import { Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { logStockChange, StockReason } from '../lib/inventory';
import { AuthRequest } from '../middlewares/auth.middleware';

// ─── 1. Bulk Sync Endpoint ────────────────────────────────────────────────────
export const syncTransactions = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { transactions } = req.body; // Array of pending transactions from PWA
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Expected array of transactions' });

  const results = { successful: 0, failed: 0, queued: 0 };
  const now = new Date().getTime();
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  for (const txData of transactions) {
    const txTime = new Date(txData.created_at).getTime();
    const timeDrift = now - txTime;

    // RULE 3: The 6-Hour Lockout
    if (timeDrift > SIX_HOURS_MS) {
      await saveToQueue(txData, 'STALE_TRANSACTION', 'Transaction is older than 6 hours limit');
      results.queued++;
      continue;
    }

    // RULE 2: No Offline Vouchers (Backend Safeguard)
    if (txData.voucher_code) {
      await saveToQueue(txData, 'INVALID_OFFLINE_VOUCHER', 'Vouchers cannot be used in offline mode');
      results.queued++;
      continue;
    }

    // RULE 1: Attempt execution, queue if failed (e.g., Stock out)
    try {
      await executeTransactionCore(userId, txData);
      results.successful++;
    } catch (error: any) {
      await saveToQueue(txData, 'EXECUTION_FAILED', error.message || 'Unknown database error');
      results.failed++;
    }
  }

  return res.json({ message: 'Sync complete', results });
};

// ─── 2. Manager Endpoints for the Danger Zone ─────────────────────────────────

// Get all failed/stale transactions needing review
export const getOfflineQueue = async (req: Request, res: Response) => {
  try {
    const queue = await prisma.offlineQueue.findMany({
      where: { synced_at: null },
      orderBy: { created_at: 'asc' }
    });
    return res.json(queue);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch queue' });
  }
};

// Manager force-discards a corrupted/invalid offline transaction
export const discardQueueItem = async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await prisma.offlineQueue.delete({ where: { id } });
    return res.json({ message: 'Item discarded' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to discard item' });
  }
};

// Add this near your other exports in src/controllers/offline.controller.ts

export const retryQueueItem = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  
  try {
    const queuedItem = await prisma.offlineQueue.findUnique({ where: { id } });
    if (!queuedItem) return res.status(404).json({ error: 'Queue item not found' });

    const payload = queuedItem.payload as any;
    // Use the original cashier's ID if available in the payload, otherwise default to the Manager resolving it
    const executorId = payload.user_id || req.user?.id;

    if (!executorId) throw new Error("No valid user ID to execute transaction");

    // Attempt to run the transaction again
    await executeTransactionCore(executorId, payload);

    // If it reaches here, it succeeded! Remove it from the Danger Zone queue.
    await prisma.offlineQueue.delete({ where: { id } });

    return res.json({ message: 'Transaction successfully recovered and synced' });
    
  } catch (error: any) {
    // If it fails AGAIN (e.g., they still didn't add enough stock), update the error log
    await prisma.offlineQueue.update({
      where: { id },
      data: { error: `[RETRY_FAILED] ${error.message || 'Unknown error'}` }
    });
    
    return res.status(400).json({ error: error.message || 'Retry failed' });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Saves failed syncs to the DB for manager review
async function saveToQueue(payload: any, errorType: string, details: string) {
  await prisma.offlineQueue.create({
    data: {
      id: uuidv7(),
      payload: payload,
      error: `[${errorType}] ${details}`
    }
  });
}

// The core transaction logic (extracted so both live and offline can use it safely)
async function executeTransactionCore(userId: string, data: any) {
  return await prisma.$transaction(async (tx) => {
    const transactionId = uuidv7();
    let subtotal = 0;
    const processedItems = [];

    // Fetch variants
    const variantIds = data.items.map((i: any) => i.variant_id);
    const variants = await tx.variant.findMany({ where: { id: { in: variantIds } } });
    const variantMap = new Map(variants.map(v => [v.id, v]));

    for (const item of data.items) {
      const variant = variantMap.get(item.variant_id);
      if (!variant) throw new Error(`Variant ${item.variant_id} not found`);
      if (variant.stock < item.quantity) {
        throw new Error(`Insufficient stock for ${variant.sku}. Have ${variant.stock}, need ${item.quantity}.`);
      }

      const oldStock = variant.stock;
      const newStock = oldStock - item.quantity;
      const lineTotal = Number(variant.price) * item.quantity - item.discount;
      subtotal += lineTotal;

      await tx.variant.update({ where: { id: variant.id }, data: { stock: newStock } });

      await logStockChange(tx, variant.id, userId, oldStock, newStock, StockReason.SALE, `Sync Trx #${transactionId}`);

      processedItems.push({
        id: uuidv7(),
        variant_id: variant.id,
        qty: item.quantity,
        price: Number(variant.price),
        discount: item.discount,
      });
    }

    const total = Math.max(0, subtotal); // Offline has no vouchers, so subtotal = total
    const amountPaid = data.payments.reduce((s: number, p: any) => s + p.amount, 0);
    if (amountPaid < total) throw new Error(`Underpayment: total is ${total}`);

    await tx.transaction.create({
      data: {
        id: transactionId,
        user_id: userId,
        member_id: data.member_id ?? null,
        subtotal,
        total,
        created_at: new Date(data.created_at), // Accurate to the offline moment
        items: { create: processedItems },
        payments: {
          create: data.payments.map((p: any) => ({
            id: uuidv7(),
            method: p.method,
            amount: p.amount,
          })),
        },
      }
    });

    if (data.member_id && total >= 1000) {
      await tx.member.update({
        where: { id: data.member_id },
        data: { points: { increment: Math.floor(total / 1000) } }
      });
    }
  });
}