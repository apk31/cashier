import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { parseTaxConfig } from './settings.controller';

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

/** UMKM threshold — first Rp 500M of the year is tax-free for PPh Final */
const UMKM_TAX_FREE_LIMIT = 500_000_000;

// ─── Daily / range sales summary ─────────────────────────────────────────────

export const getSalesSummary = async (req: Request, res: Response) => {
  const parsed = dateRangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid date range', details: parsed.error.flatten() });
  }

  const { from, to } = getDateRange(req.query as Record<string, string>);

  try {
    const where = { created_at: { gte: from, lt: to }, status: 'PAID' as const };

    const [salesSummary, cogsSummary, paymentBreakdown, topVariants, hourlyBreakdown] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { total: true, subtotal: true, discount_total: true, tax_amount: true, service_charge_amount: true },
        _count: { id: true },
        where,
      }),

      prisma.transactionItem.aggregate({
        _sum: { cogs_total: true },
        where: { transaction: where },
      }),

      prisma.payment.groupBy({
        by: ['method'],
        _sum: { amount: true },
        _count: { id: true },
        where: { transaction: where },
      }),

      prisma.transactionItem.groupBy({
        by: ['variant_id'],
        _sum: { qty: true },
        _count: { id: true },
        orderBy: { _sum: { qty: 'desc' } },
        where: { transaction: where },
        take: 10,
      }),

      prisma.$queryRaw<{ hour: number; revenue: number; count: number }[]>`
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
               SUM(total)::float8 AS revenue,
               COUNT(*)::int AS count
        FROM transactions
        WHERE created_at >= ${from} AND created_at < ${to} AND status = 'PAID'
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
        tax_collected: salesSummary._sum.tax_amount ?? 0,
        service_charge_collected: salesSummary._sum.service_charge_amount ?? 0,
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

// ─── Monthly report — Indonesian tax report (Laporan Bulanan) ─────────────────

export const getMonthlyReport = async (req: Request, res: Response) => {
  const { year, month } = req.query as Record<string, string>;
  const y = parseInt(year) || new Date().getFullYear();
  const m = parseInt(month) || new Date().getMonth() + 1;

  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 1);
  const yearStart = new Date(y, 0, 1);

  try {
    const paidWhere = { created_at: { gte: from, lt: to }, status: 'PAID' as const };

    const [summary, cogsSummary, dailyBreakdown, paymentBreakdown, ytdResult, expenseSum] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { total: true, subtotal: true, discount_total: true, tax_amount: true, service_charge_amount: true },
        _count: { id: true },
        where: paidWhere,
      }),

      prisma.transactionItem.aggregate({
        _sum: { cogs_total: true },
        where: { transaction: paidWhere },
      }),

      prisma.$queryRaw<{ day: string; revenue: number; count: number }[]>`
        SELECT DATE(created_at) AS day,
               SUM(total)::float8 AS revenue,
               COUNT(*)::int AS count
        FROM transactions
        WHERE created_at >= ${from} AND created_at < ${to} AND status = 'PAID'
        GROUP BY day
        ORDER BY day
      `,

      prisma.payment.groupBy({
        by: ['method'],
        _sum: { amount: true },
        _count: { id: true },
        where: { transaction: paidWhere },
      }),

      // YTD gross revenue — for UMKM Rp 500M rule
      prisma.transaction.aggregate({
        _sum: { total: true },
        where: { status: 'PAID', created_at: { gte: yearStart, lt: to } },
      }),

      // Monthly expenses total
      prisma.expense.aggregate({
        _sum: { amount: true },
        where: { created_at: { gte: from, lt: to } },
      }),
    ]);

    const settings = await prisma.setting.findUnique({ where: { id: 'GLOBAL' } });
    const taxConfig = parseTaxConfig(settings?.tax_config);

    const monthlyRevenue = Number(summary._sum.total ?? 0);
    const ytdRevenue = Number(ytdResult._sum.total ?? 0);
    const monthlyExpenses = Number(expenseSum._sum.amount ?? 0);
    const cogsTotal = Number(cogsSummary._sum.cogs_total ?? 0);
    const taxCollected = Number(summary._sum.tax_amount ?? 0);

    // ── Tax Liability Calculation ───────────────────────────────────────
    let taxLiability = 0;
    let taxExplanation = '';

    if (taxConfig.tax_status === 'FREE') {
      taxLiability = 0;
      taxExplanation = 'UMKM with revenue below Rp 500M — no income tax liability.';
    } else if (taxConfig.tax_status === 'PPH_FINAL') {
      // PPh Final 0.5% applies ONLY to revenue exceeding the first Rp 500M of the year
      // Calculate how much of this month's revenue falls above the 500M threshold
      const ytdBeforeThisMonth = ytdRevenue - monthlyRevenue;
      const alreadyExempt = Math.min(ytdBeforeThisMonth, UMKM_TAX_FREE_LIMIT);
      const remainingExemption = Math.max(0, UMKM_TAX_FREE_LIMIT - alreadyExempt);
      const taxableRevenue = Math.max(0, monthlyRevenue - remainingExemption);

      taxLiability = Math.round(taxableRevenue * (taxConfig.pph_rate / 100));
      taxExplanation = `PPh Final ${taxConfig.pph_rate}% on Rp ${taxableRevenue.toLocaleString('id-ID')} taxable revenue this month. Pay by the 15th of next month.`;
    } else if (taxConfig.tax_status === 'PKP') {
      // PKP: PPN collected is the tax liability to remit
      taxLiability = taxCollected;
      taxExplanation = `PKP — Total PPN (Pajak Keluaran) collected to be remitted to the government.`;
    }

    return res.json({
      period: { year: y, month: m, from: from.toISOString(), to: to.toISOString() },
      store: settings?.store_info ?? {},
      tax: {
        config: taxConfig,
        ytd_revenue: ytdRevenue,
        ytd_remaining_exemption: Math.max(0, UMKM_TAX_FREE_LIMIT - ytdRevenue),
        ytd_progress_pct: Math.min(100, (ytdRevenue / UMKM_TAX_FREE_LIMIT) * 100),
        monthly_tax_liability: taxLiability,
        tax_explanation: taxExplanation,
        ppn_collected: taxCollected,
      },
      summary: {
        revenue: monthlyRevenue,
        subtotal: Number(summary._sum.subtotal ?? 0),
        discount_total: Number(summary._sum.discount_total ?? 0),
        tax_collected: taxCollected,
        service_charge_collected: Number(summary._sum.service_charge_amount ?? 0),
        transaction_count: summary._count.id,
        cogs_total: cogsTotal,
        gross_profit: monthlyRevenue - cogsTotal,
        expenses_total: monthlyExpenses,
        net_profit: monthlyRevenue - cogsTotal - monthlyExpenses,
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
      orderBy: { stock: 'asc' }
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
    // 1. Fetch PAID Sales Transactions for timeline
    const sales = await prisma.transaction.findMany({
      where: { created_at: { gte: from, lt: to }, status: 'PAID' },
      include: { items: true },
      orderBy: { created_at: 'asc' }
    });

    // 2. Fetch Restocks/StockBatches for timeline
    const restocks = await prisma.stockBatch.findMany({
      where: { created_at: { gte: from, lt: to } },
      include: { variant: { include: { product: true } } },
      orderBy: { created_at: 'asc' }
    });

    // 3. Fetch Expenses for timeline
    const expenses = await prisma.expense.findMany({
      where: { created_at: { gte: from, lt: to } },
      include: { user: { select: { name: true } } },
      orderBy: { created_at: 'asc' },
    });

    const ledger: Array<{
      date: string;
      type: string;
      ref_id: string;
      description: string;
      debit: number;
      credit: number;
      profit: number | null;
    }> = [];

    let totalSalesRevenue = 0;
    let totalCogs = 0;
    let totalPurchases = 0;
    let totalExpenses = 0;
    let totalTaxCollected = 0;

    for (const s of sales) {
      const cogs = s.items.reduce((sum, item) => sum + Number(item.cogs_total), 0);
      const rev = Number(s.total);
      const tax = Number(s.tax_amount);

      totalSalesRevenue += rev;
      totalCogs += cogs;
      totalTaxCollected += tax;

      ledger.push({
        date: s.created_at.toISOString(),
        type: 'SALE',
        ref_id: s.id,
        description: `Sales Transaction`,
        debit: rev,
        credit: cogs,
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
        credit: value,
        profit: null,
      });
    }

    for (const e of expenses) {
      totalExpenses += Number(e.amount);

      ledger.push({
        date: e.created_at.toISOString(),
        type: 'EXPENSE',
        ref_id: e.id,
        description: `Expense [${e.category}]: ${e.description || 'No description'}`,
        debit: 0,
        credit: Number(e.amount),
        profit: null,
      });
    }

    // Sort ledger by date chronologically
    ledger.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // 4. Current Inventory Valuation (Global Asset Value)
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
        total_expenses: totalExpenses,
        total_tax_collected: totalTaxCollected,
        net_income: totalSalesRevenue - totalCogs - totalExpenses,
        current_inventory_valuation: currentValuation,
      }
    });
  } catch (error) {
    console.error('[report.estatement]', error);
    return res.status(500).json({ error: 'Failed to generate e-statement' });
  }
};