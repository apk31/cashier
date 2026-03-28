import { Request, Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { logStockChange, StockReason } from '../lib/inventory';
import { AuthRequest } from '../middlewares/auth.middleware';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OfflineTransactionPayload {
  created_at: string;
  voucher_code?: string;
  member_id?: string | null;
  user_id?: string;
  items: Array<{
    variant_id: string;
    quantity: number;
    discount: number;
    price?: number;
  }>;
  payments: Array<{
    method: string;
    amount: number;
    ref_no?: string;
  }>;
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const offlineItemSchema = z.object({
  variant_id: z.string(),
  quantity: z.coerce.number().int().positive(),
  discount: z.coerce.number().min(0).default(0),
  price: z.coerce.number().min(0).optional(),
});

const offlinePaymentSchema = z.object({
  method: z.enum(['CASH', 'QRIS', 'TRANSFER']),
  amount: z.coerce.number().positive(),
  ref_no: z.string().optional(),
});

const offlineTxSchema = z.object({
  created_at: z.string().datetime(),
  voucher_code: z.string().optional(),
  member_id: z.string().optional().nullable(),
  user_id: z.string().optional(),
  items: z.array(offlineItemSchema).min(1),
  payments: z.array(offlinePaymentSchema).min(1),
});

const syncSchema = z.object({
  transactions: z.array(offlineTxSchema).min(1),
});

// ─── 1. Bulk Sync Endpoint ────────────────────────────────────────────────────

export const syncTransactions = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid sync payload', details: parsed.error.flatten() });
  }

  const { transactions } = parsed.data;
  const results = { successful: 0, failed: 0, queued: 0 };
  const now = Date.now();
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  for (const txData of transactions) {
    const txTime = new Date(txData.created_at).getTime();
    const timeDrift = now - txTime;

    // RULE 1: The 6-Hour Lockout
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

    // RULE 3: Attempt execution, queue if failed (e.g., stock out)
    try {
      await executeTransactionCore(userId, txData);
      results.successful++;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown database error';
      await saveToQueue(txData, 'EXECUTION_FAILED', msg);
      results.failed++;
    }
  }

  return res.json({ message: 'Sync complete', results });
};

// ─── 2. Manager Endpoints for the Danger Zone ─────────────────────────────────

// Get all failed/stale transactions needing review
export const getOfflineQueue = async (_req: Request, res: Response) => {
  try {
    const queue = await prisma.offlineQueue.findMany({
      where: { synced_at: null },
      orderBy: { created_at: 'asc' }
    });
    return res.json(queue);
  } catch (error) {
    console.error('[offline.getQueue]', error);
    return res.status(500).json({ error: 'Failed to fetch queue' });
  }
};

// Manager force-discards a corrupted/invalid offline transaction
export const discardQueueItem = async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    await prisma.offlineQueue.delete({ where: { id } });
    return res.json({ message: 'Item discarded' });
  } catch (error: unknown) {
    const e = error as { code?: string };
    if (e.code === 'P2025') return res.status(404).json({ error: 'Queue item not found' });
    console.error('[offline.discard]', error);
    return res.status(500).json({ error: 'Failed to discard item' });
  }
};

export const retryQueueItem = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const queuedItem = await prisma.offlineQueue.findUnique({ where: { id } });
    if (!queuedItem) return res.status(404).json({ error: 'Queue item not found' });

    const payload = queuedItem.payload as unknown as OfflineTransactionPayload;
    // Use the original cashier's ID if available in the payload, otherwise use the Manager resolving it
    const executorId = payload.user_id ?? req.user?.id;
    if (!executorId) return res.status(400).json({ error: 'No valid user ID to execute transaction' });

    await executeTransactionCore(executorId, payload);

    // Success — remove from Danger Zone
    await prisma.offlineQueue.delete({ where: { id } });
    return res.json({ message: 'Transaction successfully recovered and synced' });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    // Update the error log and leave it in queue for next attempt
    await prisma.offlineQueue.update({
      where: { id },
      data: { error: `[RETRY_FAILED] ${msg}` }
    });
    return res.status(400).json({ error: msg });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function saveToQueue(payload: OfflineTransactionPayload, errorType: string, details: string) {
  await prisma.offlineQueue.create({
    data: {
      id: uuidv7(),
      payload: payload as object,
      error: `[${errorType}] ${details}`
    }
  });
}

// Core transaction logic — shared by live sync and retry endpoints
async function executeTransactionCore(userId: string, data: OfflineTransactionPayload) {
  return await prisma.$transaction(async (tx) => {
    const transactionId = uuidv7();
    let subtotal = 0;
    const processedItems: Array<{
      id: string;
      variant_id: string;
      qty: number;
      price: number;
      discount: number;
      cogs_total: number;
    }> = [];

    // Batch-fetch all variants to avoid N+1
    const variantIds = data.items.map(i => i.variant_id);
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

      // Open-price logic: respect cashier-entered price only for flagged variants
      const unitPrice = variant.has_open_price && item.price !== undefined
        ? item.price
        : Number(variant.price);

      const lineTotal = unitPrice * item.quantity - item.discount;
      subtotal += lineTotal;

      // ── FIFO StockBatch Calculation ──
      const batches = await tx.stockBatch.findMany({
        where: { variant_id: variant.id, remaining_qty: { gt: 0 } },
        orderBy: { created_at: 'asc' }
      });

      let qtyNeeded = item.quantity;
      let cogsTotal = 0;

      for (const batch of batches) {
         if (qtyNeeded <= 0) break;
         const qtyToTake = Math.min(batch.remaining_qty, qtyNeeded);
         
         cogsTotal += qtyToTake * Number(batch.base_price);
         qtyNeeded -= qtyToTake;

         await tx.stockBatch.update({
           where: { id: batch.id },
           data: { remaining_qty: batch.remaining_qty - qtyToTake }
         });
      }

      await tx.variant.update({ where: { id: variant.id }, data: { stock: newStock } });
      await logStockChange(tx, variant.id, userId, oldStock, newStock, StockReason.SALE, `Sync Trx #${transactionId}`);

      processedItems.push({
        id: uuidv7(),
        variant_id: variant.id,
        qty: item.quantity,
        price: unitPrice,
        discount: item.discount,
        cogs_total: cogsTotal,
      });
    }

    const total = Math.max(0, subtotal); // Offline has no vouchers, so subtotal = total
    const amountPaid = data.payments.reduce((s, p) => s + p.amount, 0);
    if (amountPaid < total) throw new Error(`Underpayment: total is ${total}`);

    await tx.transaction.create({
      data: {
        id: transactionId,
        user_id: userId,
        member_id: data.member_id ?? null,
        subtotal,
        total,
        created_at: new Date(data.created_at),
        items: { create: processedItems },
        payments: {
          create: data.payments.map(p => ({
            id: uuidv7(),
            method: p.method as 'CASH' | 'QRIS' | 'TRANSFER',
            amount: p.amount,
            ref_no: p.ref_no ?? null,
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