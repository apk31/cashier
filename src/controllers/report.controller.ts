import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';

// ─── Helper ───────────────────────────────────────────────────────────────────

const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function getDateRange(query: Record<string, string>) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const from = query.from ? new Date(query.from) : today;
  const to = query.to ? new Date(query.to) : tomorrow;
  return { from, to };
}

// ─── Daily / range sales summary ─────────────────────────────────────────────

export const getSalesSummary = async (req: Request, res: Response) => {
  const parsed = dateRangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid date range', details: parsed.error.flatten() });
  }

  const { from, to } = getDateRange(req.query as Record<string, string>);

  try {
    const where = { created_at: { gte: from, lt: to } };

    const [salesSummary, cogsSummary, paymentBreakdown, topVariants, hourlyBreakdown] = await Promise.all([
      // Total revenue, count, discount
      prisma.transaction.aggregate({
        _sum: { total: true, subtotal: true, discount_total: true },
        _count: { id: true },
        where,
      }),

      // COGS from items
      prisma.transactionItem.aggregate({
        _sum: { cogs_total: true },
        where: { transaction: where },
      }),

      // Revenue by payment method
      prisma.payment.groupBy({
        by: ['method'],
        _sum: { amount: true },
        _count: { id: true },
        where: { transaction: where },
      }),

      // Top 10 selling variants with names resolved
      prisma.transactionItem.groupBy({
        by: ['variant_id'],
        _sum: { qty: true },
        _count: { id: true },
        orderBy: { _sum: { qty: 'desc' } },
        where: { transaction: where },
        take: 10,
      }),

      // Hourly breakdown for today (useful for busy-hour analysis)
      prisma.$queryRaw<{ hour: number; revenue: number; count: number }[]>`
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
               SUM(total)::float8 AS revenue,
               COUNT(*)::int AS count
        FROM transactions
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY hour
        ORDER BY hour
      `,
    ]);

    // Resolve variant names for top items
    const variantIds = topVariants.map((v) => v.variant_id);
    const variants = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      include: { product: { select: { name: true } } },
    });
    const variantMap = Object.fromEntries(variants.map((v) => [v.id, v]));

    const topItems = topVariants.map((item) => ({
      variant_id: item.variant_id,
      sku: variantMap[item.variant_id]?.sku,
      product_name: variantMap[item.variant_id]?.product?.name,
      variant_name: variantMap[item.variant_id]?.name,
      qty_sold: item._sum.qty,
      transactions: item._count.id,
    }));

    return res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        revenue: salesSummary._sum.total ?? 0,
        subtotal: salesSummary._sum.subtotal ?? 0,
        discount_total: salesSummary._sum.discount_total ?? 0,
        transaction_count: salesSummary._count.id,
        cogs_total: cogsSummary._sum.cogs_total ?? 0,
        gross_profit: Number(salesSummary._sum.total ?? 0) - Number(cogsSummary._sum.cogs_total ?? 0),
      },
      payment_breakdown: paymentBreakdown,
      top_items: topItems,
      hourly_breakdown: hourlyBreakdown,
    });
  } catch (error) {
    console.error('[report.summary]', error);
    return res.status(500).json({ error: 'Failed to generate report' });
  }
};

// ─── Monthly report — for Indonesian tax report (Laporan Bulanan) ─────────────

export const getMonthlyReport = async (req: Request, res: Response) => {
  const { year, month } = req.query as Record<string, string>;
  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || new Date().getMonth() + 1;

  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 1);

  try {
    const [summary, cogsSummary, dailyBreakdown, paymentBreakdown] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { total: true, subtotal: true, discount_total: true },
        _count: { id: true },
        where: { created_at: { gte: from, lt: to } },
      }),

      prisma.transactionItem.aggregate({
        _sum: { cogs_total: true },
        where: { transaction: { created_at: { gte: from, lt: to } } },
      }),

      // Daily totals — used for the Laporan Penjualan Harian table
      prisma.$queryRaw<{ day: string; revenue: number; count: number }[]>`
        SELECT DATE(created_at) AS day,
               SUM(total)::float8 AS revenue,
               COUNT(*)::int AS count
        FROM transactions
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY day
        ORDER BY day
      `,

      prisma.payment.groupBy({
        by: ['method'],
        _sum: { amount: true },
        _count: { id: true },
        where: { transaction: { created_at: { gte: from, lt: to } } },
      }),
    ]);

    const settings = await prisma.setting.findUnique({ where: { id: 'GLOBAL' } });
    const taxConfig = settings?.tax_config as { is_pkp: boolean; ppn_rate: number; npwp?: string } | null;

    const revenue = Number(summary._sum.total ?? 0);
    const ppnRate = taxConfig?.ppn_rate ?? 11;
    const ppnAmount = taxConfig?.is_pkp ? (revenue * ppnRate) / (100 + ppnRate) : 0;

    return res.json({
      period: { year: y, month: m, from: from.toISOString(), to: to.toISOString() },
      store: settings?.store_info ?? {},
      tax: { is_pkp: taxConfig?.is_pkp ?? false, npwp: taxConfig?.npwp, ppn_rate: ppnRate, ppn_amount: ppnAmount },
      summary: {
        revenue,
        subtotal: Number(summary._sum.subtotal ?? 0),
        discount_total: Number(summary._sum.discount_total ?? 0),
        transaction_count: summary._count.id,
        dpp: taxConfig?.is_pkp ? revenue - ppnAmount : revenue, // Dasar Pengenaan Pajak
        cogs_total: Number(cogsSummary._sum.cogs_total ?? 0),
        gross_profit: revenue - Number(cogsSummary._sum.cogs_total ?? 0),
      },
      daily_breakdown: dailyBreakdown,
      payment_breakdown: paymentBreakdown,
    });
  } catch (error) {
    console.error('[report.monthly]', error);
    return res.status(500).json({ error: 'Failed to generate monthly report' });
  }
};

// ─── Price change log — for tax audit trail ───────────────────────────────────

export const getPriceChangeLogs = async (req: Request, res: Response) => {
  const dateValidation = dateRangeSchema.safeParse(req.query);
  if (!dateValidation.success) {
    return res.status(400).json({ error: 'Invalid date range', details: dateValidation.error.flatten() });
  }
  const { from, to } = getDateRange(req.query as Record<string, string>);
  const { page = '1', limit = '50' } = req.query as Record<string, string>;
  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  try {
    const [logs, total] = await Promise.all([
      prisma.priceLog.findMany({
        where: { created_at: { gte: from, lt: to } },
        include: {
          variant: { include: { product: { select: { name: true } } } },
          user: { select: { name: true, role: true } },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      prisma.priceLog.count({ where: { created_at: { gte: from, lt: to } } }),
    ]);

    return res.json({ data: logs, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[report.priceLogs]', error);
    return res.status(500).json({ error: 'Failed to fetch price logs' });
  }
};

// ─── Low stock alerts ─────────────────────────────────────────────────────────

export const getLowStockAlerts = async (req: Request, res: Response) => {
  // Default threshold is 10, but the frontend can request a custom one (e.g., ?threshold=5)
  const threshold = Number(req.query.threshold) || 10;

  try {
    const lowStockItems = await prisma.variant.findMany({
      where: {
        stock: { lte: threshold }
      },
      include: {
        product: {
          select: { name: true, category: { select: { name: true } } }
        }
      },
      orderBy: { stock: 'asc' } // Show lowest stock first
    });

    return res.json({
      alert_threshold: threshold,
      total_alerts: lowStockItems.length,
      items: lowStockItems.map(item => ({
        variant_id: item.id,
        product_name: item.product.name,
        category: item.product.category.name,
        sku: item.sku,
        current_stock: item.stock,
        price: item.price
      }))
    });
  } catch (error) {
    console.error('[report.lowStock]', error);
    return res.status(500).json({ error: 'Failed to fetch low stock alerts' });
  }
};

// ─── E-Statement / Ledger ──────────────────────────────────────────────────────

export const getEStatement = async (req: Request, res: Response) => {
  const { from, to } = getDateRange(req.query as Record<string, string>);

  try {
    // 1. Fetch Sales Transactions for timeline
    const sales = await prisma.transaction.findMany({
      where: { created_at: { gte: from, lt: to } },
      include: { items: true },
      orderBy: { created_at: 'asc' }
    });

    // 2. Fetch Restocks/StockBatches for timeline
    const restocks = await prisma.stockBatch.findMany({
      where: { created_at: { gte: from, lt: to } },
      include: { variant: { include: { product: true } } },
      orderBy: { created_at: 'asc' }
    });

    // We can merge them into a standard ledger format
    const ledger = [];

    let totalSalesRevenue = 0;
    let totalCogs = 0;
    let totalPurchases = 0;

    for (const s of sales) {
      const cogs = s.items.reduce((sum, item) => sum + Number(item.cogs_total), 0);
      const rev = Number(s.total);
      
      totalSalesRevenue += rev;
      totalCogs += cogs;

      ledger.push({
        date: s.created_at.toISOString(),
        type: 'SALE',
        ref_id: s.id,
        description: `Sales Transaction`,
        debit: rev,     // Money in from sale
        credit: cogs,   // COGS represented here as an asset credit, but e-statement formats usually vary.
        profit: rev - cogs,
      });
    }

    for (const r of restocks) {
      const value = r.initial_qty * Number(r.base_price);
      totalPurchases += value;

      ledger.push({
        date: r.created_at.toISOString(),
        type: 'RESTOCK',
        ref_id: r.id,
        description: `Restock: ${r.variant.product.name} ${r.variant.name ? `(${r.variant.name})` : ''}`,
        debit: 0,
        credit: value, // Money out to buy stock
        profit: null,
      });
    }

    // Sort ledger by date true chronological
    ledger.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // 3. Current Inventory Valuation (Global Asset Value)
    const allBatches = await prisma.stockBatch.findMany({
      where: { remaining_qty: { gt: 0 } }
    });
    const currentValuation = allBatches.reduce((sum, b) => sum + (b.remaining_qty * Number(b.base_price)), 0);

    return res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      ledger,
      summary: {
        total_sales_revenue: totalSalesRevenue,
        total_cogs: totalCogs,
        gross_profit: totalSalesRevenue - totalCogs,
        total_purchases_spent: totalPurchases,
        current_inventory_valuation: currentValuation
      }
    });
  } catch (error) {
    console.error('[report.estatement]', error);
    return res.status(500).json({ error: 'Failed to generate e-statement' });
  }
};