import { Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { AuthRequest } from '../middlewares/auth.middleware';

// ─── Validation schemas ───────────────────────────────────────────────────────

const createExpenseSchema = z.object({
  amount: z.number().positive(),
  category: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  receipt_url: z.string().url().optional(),
  store_id: z.string().default('GLOBAL'),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

/** POST /api/expenses — Log an expense */
export const createExpense = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'User not identified' });

  const parsed = createExpenseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const expense = await prisma.expense.create({
      data: {
        id: uuidv7(),
        user_id: userId,
        store_id: parsed.data.store_id,
        amount: parsed.data.amount,
        category: parsed.data.category,
        description: parsed.data.description ?? null,
        receipt_url: parsed.data.receipt_url ?? null,
      },
      include: {
        user: { select: { name: true } },
      },
    });

    return res.status(201).json(expense);
  } catch (error) {
    console.error('[expense.create]', error);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
};

/** GET /api/expenses — List expenses with date range + pagination */
export const getExpenses = async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '50', from, to, category } = req.query as Record<string, string>;

  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  const where: Prisma.ExpenseWhereInput = {};

  if (from || to) {
    where.created_at = {};
    if (from) (where.created_at as Prisma.DateTimeFilter).gte = new Date(from);
    if (to) (where.created_at as Prisma.DateTimeFilter).lt = new Date(to);
  }

  if (category) where.category = category;

  try {
    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: { user: { select: { name: true } } },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      prisma.expense.count({ where }),
    ]);

    return res.json({ data: expenses, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[expense.list]', error);
    return res.status(500).json({ error: 'Failed to fetch expenses' });
  }
};

/** GET /api/expenses/summary — Aggregate by category for a date range */
export const getExpenseSummary = async (req: AuthRequest, res: Response) => {
  const { from, to } = req.query as Record<string, string>;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateFrom = from ? new Date(from) : today;
  const dateTo = to ? new Date(to) : tomorrow;

  try {
    const [categoryBreakdown, totalSum] = await Promise.all([
      prisma.expense.groupBy({
        by: ['category'],
        _sum: { amount: true },
        _count: { id: true },
        where: { created_at: { gte: dateFrom, lt: dateTo } },
        orderBy: { _sum: { amount: 'desc' } },
      }),
      prisma.expense.aggregate({
        _sum: { amount: true },
        _count: { id: true },
        where: { created_at: { gte: dateFrom, lt: dateTo } },
      }),
    ]);

    return res.json({
      period: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
      total: totalSum._sum.amount ?? 0,
      count: totalSum._count.id,
      by_category: categoryBreakdown.map(c => ({
        category: c.category,
        total: c._sum.amount ?? 0,
        count: c._count.id,
      })),
    });
  } catch (error) {
    console.error('[expense.summary]', error);
    return res.status(500).json({ error: 'Failed to get expense summary' });
  }
};

/** DELETE /api/expenses/:id — Delete an expense (ADMIN/MANAGER only) */
export const deleteExpense = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    await prisma.expense.delete({ where: { id } });
    return res.json({ message: 'Expense deleted' });
  } catch (error) {
    console.error('[expense.delete]', error);
    return res.status(500).json({ error: 'Failed to delete expense' });
  }
};
