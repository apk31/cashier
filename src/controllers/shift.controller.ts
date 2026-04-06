import { Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Prisma } from '@prisma/client';

// ─── Validation schemas ───────────────────────────────────────────────────────

const openShiftSchema = z.object({
  starting_cash: z.number().min(0),
});

const closeShiftSchema = z.object({
  actual_cash: z.number().min(0),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

/** POST /api/shifts/open — Begin a new cash shift */
export const openShift = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User not identified' });

  const parsed = openShiftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    // Check if user already has an open shift
    const existing = await prisma.cashShift.findFirst({
      where: { user_id: userId, status: 'OPEN' },
    });
    if (existing) {
      return res.status(400).json({
        error: 'You already have an open shift. Close it before opening a new one.',
        shift_id: existing.id,
      });
    }

    const shift = await prisma.cashShift.create({
      data: {
        id: uuidv7(),
        user_id: userId,
        starting_cash: parsed.data.starting_cash,
      },
    });

    return res.status(201).json(shift);
  } catch (error) {
    console.error('[shift.open]', error);
    return res.status(500).json({ error: 'Failed to open shift' });
  }
};

/** POST /api/shifts/:id/close — End a cash shift with reconciliation */
export const closeShift = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User not identified' });

  const shiftId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = closeShiftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const shift = await prisma.cashShift.findUnique({ where: { id: shiftId } });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (shift.status !== 'OPEN') return res.status(400).json({ error: 'Shift is already closed' });
    if (shift.user_id !== userId && req.user?.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only the shift owner or ADMIN can close this shift' });
    }

    // Aggregate all CASH payments from transactions tied to this shift
    const cashPayments = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        method: 'CASH',
        transaction: {
          shift_id: shiftId,
          status: 'PAID',
        },
      },
    });

    const cashFromSales = Number(cashPayments._sum.amount ?? 0);
    const expectedCash = Number(shift.starting_cash) + cashFromSales;
    const actualCash = parsed.data.actual_cash;
    const difference = actualCash - expectedCash;

    const updated = await prisma.cashShift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        closed_at: new Date(),
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference,
      },
    });

    // If there is a cash discrepancy, physically log it in the global transactions table!
    if (difference !== 0) {
      await prisma.transaction.create({
        data: {
          id: uuidv7(),
          total: difference,
          subtotal: difference,
          tax_amount: 0,
          discount_total: 0,
          status: 'PAID',
          user_id: userId,
          shift_id: shiftId,
          payments: {
            create: [{ id: uuidv7(), method: 'CASH', amount: difference }]
          }
        }
      });
    }

    return res.json({
      ...updated,
      cash_from_sales: cashFromSales,
      reconciliation: {
        starting_cash: Number(shift.starting_cash),
        cash_from_sales: cashFromSales,
        expected_cash: expectedCash,
        actual_cash: actualCash,
        difference,
        status: difference === 0 ? 'BALANCED' : difference > 0 ? 'OVERAGE' : 'SHORTAGE',
      },
    });
  } catch (error) {
    console.error('[shift.close]', error);
    return res.status(500).json({ error: 'Failed to close shift' });
  }
};

/** GET /api/shifts/current — Get the current open shift for the authenticated user */
export const getCurrentShift = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User not identified' });

  try {
    const shift = await prisma.cashShift.findFirst({
      where: { user_id: userId, status: 'OPEN' },
      include: {
        _count: { select: { transactions: true } },
      },
    });

    if (!shift) {
      return res.json({ shift: null });
    }

    return res.json({ shift });
  } catch (error) {
    console.error('[shift.current]', error);
    return res.status(500).json({ error: 'Failed to fetch current shift' });
  }
};

/** GET /api/shifts — List shifts (paginated) — MANAGER/ADMIN */
export const getShifts = async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '20', from, to, status } = req.query as Record<string, string>;

  const take = Math.min(parseInt(limit) || 20, 100);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const where: any = {};
  if (from || to) {
    where.opened_at = {};
    if (from) where.opened_at.gte = new Date(from);
    if (to) where.opened_at.lt = new Date(to);
  }
  if (status) where.status = status;

  try {
    const [rawShifts, total] = await Promise.all([
      prisma.cashShift.findMany({
        where,
        include: {
          user: { select: { name: true, role: true } },
          _count: { select: { transactions: true } },
        },
        orderBy: { opened_at: 'desc' },
        take,
        skip,
      }),
      prisma.cashShift.count({ where }),
    ]);

    const shiftIds = rawShifts.map((s) => s.id);
    const allPayments = await prisma.payment.findMany({
      where: { transaction: { shift_id: { in: shiftIds }, status: 'PAID' } },
      select: { amount: true, method: true, transaction: { select: { shift_id: true } } }
    });

    const shifts = rawShifts.map(shift => {
      let cash = 0, qris = 0, transfer = 0;
      for (const p of allPayments) {
        if (p.transaction.shift_id === shift.id) {
           if (p.method === 'CASH') cash += Number(p.amount);
           else if (p.method === 'QRIS') qris += Number(p.amount);
           else if (p.method === 'TRANSFER') transfer += Number(p.amount);
        }
      }
      return {
        ...shift,
        breakdown: { cash, qris, transfer, total_sales: cash + qris + transfer }
      };
    });

    return res.json({ data: shifts, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[shift.list]', error);
    return res.status(500).json({ error: 'Failed to fetch shifts' });
  }
};
