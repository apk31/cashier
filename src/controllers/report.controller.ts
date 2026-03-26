import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const getDailyStats = async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. Total Sales Today
    const salesSummary = await prisma.transaction.aggregate({
      _sum: { total: true },
      _count: { id: true },
      where: { created_at: { gte: today } }
    });

    // 2. Top Selling Items
    const topItems = await prisma.transactionItem.groupBy({
      by: ['variant_id'],
      _sum: { qty: true },
      orderBy: { _sum: { qty: 'desc' } },
      take: 5
    });

    res.json({
      date: today.toISOString().split('T')[0],
      total_revenue: salesSummary._sum.total || 0,
      transaction_count: salesSummary._count.id,
      top_variants: topItems
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report' });
  }
};