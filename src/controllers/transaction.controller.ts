import { Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middlewares/auth.middleware';

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
    return res.status(400).json({ error: 'Invalid transaction payload', details: parsed.error.flatten() });
  }

  const { items, payments, member_id, voucher_code, created_at } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {

      // ── 1. Validate & resolve items ──────────────────────────────────────
      let subtotal = 0;
      const processedItems: {
        id: string; variant_id: string; qty: number; price: number; discount: number;
      }[] = [];

      for (const item of items) {
        const variant = await tx.variant.findUnique({ where: { id: item.variant_id } });

        if (!variant) throw new Error(`Variant ${item.variant_id} not found`);
        if (variant.stock < item.quantity) {
          throw new Error(`Insufficient stock for SKU ${variant.sku} (have ${variant.stock}, need ${item.quantity})`);
        }

        const lineTotal = Number(variant.price) * item.quantity - item.discount;
        subtotal += lineTotal;

        await tx.variant.update({
          where: { id: variant.id },
          data: { stock: { decrement: item.quantity } },
        });

        processedItems.push({
          id: uuidv7(),
          variant_id: variant.id,
          qty: item.quantity,
          price: Number(variant.price),
          discount: item.discount,
        });
      }

      // ── 2. Validate & apply voucher ──────────────────────────────────────
      let voucherId: string | undefined;
      let voucherDiscount = 0;

      if (voucher_code) {
        const now = new Date();
        const voucher = await tx.voucher.findUnique({ where: { code: voucher_code } });

        if (!voucher) throw new Error(`Voucher code "${voucher_code}" not found`);
        if (voucher.exp < now) throw new Error(`Voucher "${voucher_code}" has expired`);
        if (voucher.used_count >= voucher.max_uses) throw new Error(`Voucher "${voucher_code}" has reached its usage limit`);

        voucherId = voucher.id;
        voucherDiscount =
          voucher.type === 'PERCENTAGE'
            ? subtotal * (Number(voucher.value) / 100)
            : Number(voucher.value);

        await tx.voucher.update({
          where: { id: voucher.id },
          data: { used_count: { increment: 1 } },
        });
      }

      // ── 3. Validate member ───────────────────────────────────────────────
      if (member_id) {
        const member = await tx.member.findUnique({ where: { id: member_id } });
        if (!member) throw new Error(`Member ${member_id} not found`);
      }

      // ── 4. Validate payments sum covers total ────────────────────────────
      const discountTotal = voucherDiscount;
      const total = Math.max(0, subtotal - discountTotal);
      const amountPaid = payments.reduce((s, p) => s + p.amount, 0);

      if (amountPaid < total) {
        throw new Error(`Underpayment: total is ${total}, but only ${amountPaid} paid`);
      }

      // ── 5. Create transaction ────────────────────────────────────────────
      const transaction = await tx.transaction.create({
        data: {
          id: uuidv7(),
          user_id: userId,
          member_id: member_id ?? null,
          voucher_id: voucherId ?? null,
          subtotal,
          discount_total: discountTotal,
          total,
          // Allow offline timestamp override
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
          items: { include: { variant: { include: { product: true } } } },
          payments: true,
          member: { select: { name: true, phone: true, tier: true } },
          voucher: { select: { code: true, type: true, value: true } },
        },
      });

      // ── 6. Award member loyalty points (1 point per 1000 Rp) ─────────────
      if (member_id) {
        const pointsEarned = Math.floor(total / 1000);
        if (pointsEarned > 0) {
          await tx.member.update({
            where: { id: member_id },
            data: { points: { increment: pointsEarned } },
          });
        }
      }

      return { transaction, change: amountPaid - total };
    });

    return res.status(201).json(result);
  } catch (error: any) {
    console.error('[transaction.create]', error);
    const isClientError = [
      'not found', 'Insufficient stock', 'Voucher', 'Underpayment', 'Member',
    ].some((msg) => error.message?.includes(msg));
    return res.status(isClientError ? 400 : 500).json({ error: error.message || 'Transaction failed' });
  }
};

// ─── Get single transaction ───────────────────────────────────────────────────

export const getTransaction = async (req: AuthRequest, res: Response) => {
  // const { id } = req.params;
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
