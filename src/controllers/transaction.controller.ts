import { Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middlewares/auth.middleware';
import { logStockChange, StockReason } from '../lib/inventory';
import { generateReceiptString } from '../lib/receipt';
import { parseTaxConfig } from './settings.controller';

// ─── Constants ────────────────────────────────────────────────────────────────

/** UMKM PPh Final auto-switch safety buffer (Rp 480,000,000) */
const UMKM_THRESHOLD = 480_000_000;

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
  status: z.enum(['OPEN', 'PAID', 'VOIDED', 'QUOTATION', 'INVOICE']).default('PAID'),
  table_id: z.string().optional(),
  shift_id: z.string().uuid().optional(),
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

  const { items, payments, member_id, voucher_code, created_at, status, table_id, shift_id } = parsed.data;

  // Only PAID transactions require payment validation
  const isPaid = status === 'PAID';

  try {
    const result = await prisma.$transaction(async (tx) => {
      const transactionId = uuidv7();

      // ── 0. Fetch tax config for consumer taxes ────────────────────────
      const settings = await tx.setting.findUnique({ where: { id: 'GLOBAL' } });
      const taxConfig = parseTaxConfig(settings?.tax_config);

      // ── 1. Validate shift if provided ─────────────────────────────────
      if (shift_id) {
        const shift = await tx.cashShift.findUnique({ where: { id: shift_id } });
        if (!shift) throw new Error(`Shift ${shift_id} not found`);
        if (shift.status !== 'OPEN') throw new Error('Cannot add transactions to a closed shift');
      }

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
        if (!variant) throw new Error(`Variant ${item.variant_id} not found`);

        // Open Price Logic
        const unitPrice = variant.has_open_price && item.price !== undefined
          ? item.price
          : Number(variant.price);

        const lineTotal = unitPrice * item.quantity - item.discount;
        subtotal += lineTotal;

        let cogsTotal = 0;

        // Only PAID transactions deduct stock and compute COGS
        if (isPaid) {
          if (variant.stock < item.quantity) {
            throw new Error(`Insufficient stock for SKU ${variant.sku}`);
          }

          const oldStock = variant.stock;
          const newStock = oldStock - item.quantity;

          // ── FIFO StockBatch Calculation ──
          const batches = await tx.stockBatch.findMany({
            where: { variant_id: variant.id, remaining_qty: { gt: 0 } },
            orderBy: { created_at: 'asc' }
          });

          let qtyNeeded = item.quantity;

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

          // Update total stock integer
          await tx.variant.update({
            where: { id: variant.id },
            data: { stock: newStock },
          });

          // Log stock change
          await logStockChange(
            tx,
            variant.id,
            userId,
            oldStock,
            newStock,
            StockReason.SALE,
            `Transaction #${transactionId}`
          );
        }

        processedItems.push({
          id: uuidv7(),
          variant_id: variant.id,
          qty: item.quantity,
          price: unitPrice,
          discount: item.discount,
          cogs_total: cogsTotal,
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

      // ── 3. Validate Member ────────────────────────────────────────────
      if (member_id) {
        const member = await tx.member.findUnique({ where: { id: member_id } });
        if (!member) throw new Error(`Member ${member_id} not found`);
      }

      // ── 4. Consumer Tax Calculation ───────────────────────────────────
      const afterDiscount = Math.max(0, subtotal - voucherDiscount);

      let taxAmount = 0;
      let serviceChargeAmount = 0;

      // PPN (VAT) — added on top of subtotal for customer receipt
      if (taxConfig.apply_ppn_to_sales) {
        taxAmount += afterDiscount * (taxConfig.ppn_rate / 100);
      }

      // PB1 (Restaurant Tax) — added on top of subtotal
      if (taxConfig.apply_pb1_to_sales) {
        taxAmount += afterDiscount * (taxConfig.pb1_rate / 100);
      }

      // Service Charge — only when PB1 is enabled (restaurant mode)
      if (taxConfig.apply_pb1_to_sales && taxConfig.service_charge_rate > 0) {
        serviceChargeAmount = afterDiscount * (taxConfig.service_charge_rate / 100);
      }

      taxAmount = Math.round(taxAmount);
      serviceChargeAmount = Math.round(serviceChargeAmount);

      // ── 5. Totals & Payment ───────────────────────────────────────────
      const total = afterDiscount + taxAmount + serviceChargeAmount;

      if (isPaid) {
        const amountPaid = payments.reduce((s, p) => s + p.amount, 0);
        if (amountPaid < total) throw new Error(`Underpayment: total is ${total}`);
      }

      // ── 6. Final Creation ─────────────────────────────────────────────
      const transaction = await tx.transaction.create({
        data: {
          id: transactionId,
          user_id: userId,
          member_id: member_id ?? null,
          voucher_id: voucherId ?? null,
          shift_id: shift_id ?? null,
          status,
          table_id: table_id ?? null,
          subtotal,
          discount_total: voucherDiscount,
          tax_amount: taxAmount,
          service_charge_amount: serviceChargeAmount,
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
          user: { select: { name: true } },
          items: { include: { variant: { include: { product: true } } } },
          payments: true,
          member: true,
          voucher: true,
        }
      });

      // ── 7. Loyalty Points ─────────────────────────────────────────────
      if (isPaid && member_id && total >= 1000) {
        await tx.member.update({
          where: { id: member_id },
          data: { points: { increment: Math.floor(total / 1000) } }
        });
      }

      // ── 8. Auto-Tax Status Engine (UMKM Rp480M Rule) ──────────────────
      // Only check on PAID transactions and only when status is FREE
      if (isPaid && taxConfig.tax_status === 'FREE') {
        const yearStart = new Date(new Date().getFullYear(), 0, 1);

        const ytdResult = await tx.transaction.aggregate({
          _sum: { total: true },
          where: {
            status: 'PAID',
            created_at: { gte: yearStart },
          },
        });

        const ytdRevenue = Number(ytdResult._sum.total ?? 0);

        if (ytdRevenue >= UMKM_THRESHOLD) {
          // Auto-switch to PPH_FINAL — PKP is never auto-triggered
          const currentConfig = (settings?.tax_config as Record<string, unknown>) || {};
          await tx.setting.update({
            where: { id: 'GLOBAL' },
            data: {
              tax_config: {
                ...currentConfig,
                tax_status: 'PPH_FINAL',
              },
            },
          });

          console.log(
            `[tax-engine] Auto-switched tax_status from FREE → PPH_FINAL. YTD revenue: Rp ${ytdRevenue.toLocaleString('id-ID')}`
          );
        }
      }

      // ── 9. Generate Dynamic Receipt ───────────────────────────────────
      const storeInfo = (settings?.store_info as any) || {};
      const receiptString = generateReceiptString(transaction, storeInfo, taxAmount, serviceChargeAmount);

      const amountPaid = payments.reduce((s, p) => s + p.amount, 0);
      return { transaction, receipt_string: receiptString, change: amountPaid - total };
    }); // End of Prisma transaction

    return res.status(201).json(result);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Transaction failed';
    const clientErrors = [
      'not found', 'Insufficient stock', 'Underpayment',
      'expired', 'limit reached', 'offline mode', 'closed shift'
    ];
    const isClientError = clientErrors.some(s => msg.toLowerCase().includes(s.toLowerCase()));
    if (isClientError) return res.status(400).json({ error: msg });
    console.error('[transaction.create]', error);
    return res.status(500).json({ error: 'Transaction failed due to an internal error' });
  }
};

// ─── Get single transaction ───────────────────────────────────────────────────

export const getTransaction = async (req: AuthRequest, res: Response) => {
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
        shift: { select: { id: true, status: true, opened_at: true } },
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
  const { page = '1', limit = '50', from, to, status } = req.query as Record<string, string>;

  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const whereOptions: Prisma.TransactionWhereInput = {};

  if (from || to) {
    whereOptions.created_at = {};
    if (from) (whereOptions.created_at as Prisma.DateTimeFilter).gte = new Date(from);
    if (to) (whereOptions.created_at as Prisma.DateTimeFilter).lt = new Date(to);
  }

  // Filter by status if provided
  if (status) {
    whereOptions.status = status as any;
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
