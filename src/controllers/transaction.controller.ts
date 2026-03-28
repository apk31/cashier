import { Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middlewares/auth.middleware';
import { logStockChange, StockReason } from '../lib/inventory';
import { generateReceiptString } from '../lib/receipt';

// ─── Validation schemas ───────────────────────────────────────────────────────

const paymentSchema = z.object({
  // SPLIT is not a method — send multiple payment objects instead
  method: z.enum(['CASH', 'QRIS', 'TRANSFER']),
  amount: z.number().positive(),
  ref_no: z.string().optional(),
});

const itemSchema = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  discount: z.number().min(0).default(0), // per-item fixed discount in Rp
  price: z.number().min(0).optional(), // for open-price items today
});

const createTransactionSchema = z.object({
  items: z.array(itemSchema).min(1),
  payments: z.array(paymentSchema).min(1),
  member_id: z.string().uuid().optional(),
  voucher_code: z.string().optional(),
  // Offline support: client can pass original timestamp
  created_at: z.string().datetime().optional(),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const createTransaction = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User not identified' });

  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { items, payments, member_id, voucher_code, created_at } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // FIX: Use this single ID for everything
      const transactionId = uuidv7();

      // OPTIMIZATION: Fetch all variants in one query to avoid N+1
      const variantIds = items.map(i => i.variant_id);
      const variants = await tx.variant.findMany({
        where: { id: { in: variantIds } }
      });
      const variantMap = new Map(variants.map(v => [v.id, v]));

      let subtotal = 0;
      const processedItems = [];

      for (const item of items) {
        const variant = variantMap.get(item.variant_id);

        // FIX: Check for null BEFORE accessing properties
        if (!variant) throw new Error(`Variant ${item.variant_id} not found`);
        
        if (variant.stock < item.quantity) {
          throw new Error(`Insufficient stock for SKU ${variant.sku}`);
        }

        const oldStock = variant.stock;
        const newStock = oldStock - item.quantity;

        // Open Price Logic: use client price if item fluctuates, else strict DB price
        const unitPrice = variant.has_open_price && item.price !== undefined 
          ? item.price 
          : Number(variant.price);

        const lineTotal = unitPrice * item.quantity - item.discount;
        subtotal += lineTotal;

        // Update stock
        await tx.variant.update({
          where: { id: variant.id },
          data: { stock: newStock },
        });

        // Log stock change using the correct transactionId
        await logStockChange(
          tx,
          variant.id,
          userId,
          oldStock,
          newStock,
          StockReason.SALE,
          `Transaction #${transactionId}`
        );

        processedItems.push({
          id: uuidv7(),
          variant_id: variant.id,
          qty: item.quantity,
          price: unitPrice,
          discount: item.discount,
        });
      }

      // ── 2. Voucher Logic ──────────────────────────────────────────────
      let voucherId: string | undefined;
      let voucherDiscount = 0;

      if (voucher_code) {
        const voucher = await tx.voucher.findUnique({ where: { code: voucher_code } });
        if (!voucher) throw new Error(`Voucher "${voucher_code}" not found`);
        if (new Date(voucher.exp) < new Date()) throw new Error("Voucher expired");
        if (voucher.used_count >= voucher.max_uses) throw new Error("Voucher limit reached");

        voucherId = voucher.id;
        voucherDiscount = voucher.type === 'PERCENTAGE' 
          ? subtotal * (Number(voucher.value) / 100) 
          : Number(voucher.value);

        await tx.voucher.update({
          where: { id: voucher.id },
          data: { used_count: { increment: 1 } }
        });
      }

      // ── 3. Validate Member (NEW) ──────────────────────────────────────────
      if (member_id) {
        const member = await tx.member.findUnique({ where: { id: member_id } });
        if (!member) throw new Error(`Member ${member_id} not found`);
      }

      // ── 4. Totals & Payment ───────────────────────────────────────────
      const total = Math.max(0, subtotal - voucherDiscount);
      const amountPaid = payments.reduce((s, p) => s + p.amount, 0);

      if (amountPaid < total) throw new Error(`Underpayment: total is ${total}`);

      // ── 5. Final Creation (MODIFIED) ───────────────────────────────────
      const transaction = await tx.transaction.create({
        data: {
          id: transactionId, 
          user_id: userId,
          member_id: member_id ?? null,
          voucher_id: voucherId ?? null,
          subtotal,
          discount_total: voucherDiscount,
          total,
          ...(created_at ? { created_at: new Date(created_at) } : {}),
          items: { create: processedItems },
          payments: {
            create: payments.map((p) => ({
              id: uuidv7(),
              method: p.method,
              amount: p.amount,
              ref_no: p.ref_no ?? null,
            })),
          },
        },
        include: {
          user: { select: { name: true } }, // Included so the receipt can print the cashier's name
          items: { include: { variant: { include: { product: true } } } },
          payments: true,
          member: true,
          voucher: true,
        }
      });

      // ── 6. Loyalty Points ──────────────────────────────────────────────
      if (member_id && total >= 1000) {
        await tx.member.update({
          where: { id: member_id },
          data: { points: { increment: Math.floor(total / 1000) } }
        });
      }

      // ── 7. Generate Dynamic Receipt ────────────────────────────────────
      const settings = await tx.setting.findUnique({ where: { id: 'GLOBAL' } });
      const storeInfo = (settings?.store_info as any) || {};

      const receiptString = generateReceiptString(transaction, storeInfo);

      return { transaction, receipt_string: receiptString, change: amountPaid - total };
    }); // End of Prisma transaction

    return res.status(201).json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Transaction failed';
    // Known business-logic errors thrown inside the tx block are client errors (400)
    const clientErrors = [
      'not found', 'Insufficient stock', 'Underpayment',
      'expired', 'limit reached', 'offline mode'
    ];
    const isClientError = clientErrors.some(s => msg.toLowerCase().includes(s.toLowerCase()));
    if (isClientError) return res.status(400).json({ error: msg });
    console.error('[transaction.create]', error);
    return res.status(500).json({ error: 'Transaction failed due to an internal error' });
  }
};

// ─── Get single transaction ───────────────────────────────────────────────────

export const getTransaction = async (req: AuthRequest, res: Response) => {
  // const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: {
        items: { include: { variant: { include: { product: true } } } },
        payments: true,
        user: { select: { name: true, role: true } },
        member: { select: { name: true, phone: true } },
        voucher: { select: { code: true, type: true, value: true } },
      },
    });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    return res.json(tx);
  } catch (error) {
    console.error('[transaction.get]', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ─── Get all transactions (paginated) ─────────────────────────────────────────

export const getTransactions = async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '50', from, to } = req.query as Record<string, string>;
  
  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const whereOptions: Prisma.TransactionWhereInput = {};

  if (from || to) {
    whereOptions.created_at = {};
    if (from) (whereOptions.created_at as Prisma.DateTimeFilter).gte = new Date(from);
    if (to) (whereOptions.created_at as Prisma.DateTimeFilter).lt = new Date(to);
  }

  try {
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: whereOptions,
        include: {
          user: { select: { name: true } },
          member: { select: { name: true } },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      prisma.transaction.count({ where: whereOptions }),
    ]);

    return res.json({ data: transactions, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[transaction.getAll]', error);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};
