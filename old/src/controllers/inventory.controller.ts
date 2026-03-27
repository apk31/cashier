import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export const getStockHistory = async (req: Request, res: Response) => {
  const { variantId } = req.query;

  try {
    const logs = await prisma.stockLog.findMany({
      where: variantId ? { variant_id: variantId as string } : {},
      include: {
        variant: { include: { product: true } },
        user: { select: { name: true } }
      },
      orderBy: { created_at: 'desc' },
      take: 50
    });

    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch inventory history' });
  }
};