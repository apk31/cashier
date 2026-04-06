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

// ─── Annual report — Indonesian tax report (Laporan Tahunan SPT) ─────────────────

export const getMonthlyReport = async (req: Request, res: Response) => {
  const { year } = req.query as Record<string, string>;
  const y = parseInt(year) || new Date().getFullYear();

  const from = new Date(y, 0, 1);
  const to = new Date(y + 1, 0, 1);
  const yearStart = from;

  try {
    const paidWhere = { created_at: { gte: from, lt: to }, status: 'PAID' as const };

    const [summary, cogsSummary, dailyBreakdown, paymentBreakdown, ytdResult, expenseSum, txHistory, activeBatches, monthlyBatches, adjustLogs] = await Promise.all([
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

      // Transaction history (sales) mapping
      prisma.transaction.findMany({
        where: paidWhere,
        select: { id: true, created_at: true, total: true, tax_amount: true, items: { include: { variant: { include: { product: { select: { name: true } } } } } } },
        orderBy: { created_at: 'asc' },
      }),

      // Active stock batches for valuation (held up to the selected year)
      prisma.stockBatch.findMany({
        where: { 
          remaining_qty: { gt: 0 },
          created_at: { lt: to }
        },
        include: { variant: { include: { product: { select: { name: true } } } } }
      }),

      // Monthly stock batches for transaction history mapping (Buys)
      prisma.stockBatch.findMany({
        where: { created_at: { gte: from, lt: to } },
        include: { variant: { include: { product: { select: { name: true } } } } }
      }),

      // Stock adjustments for audit logging (lost/damaged stocks in SPT)
      prisma.stockLog.findMany({
        where: { created_at: { gte: from, lt: to }, reason: { notIn: ['SALE', 'RESTOCK'] } },
        include: { variant: { include: { product: { select: { name: true } } } } }
      })
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
      taxExplanation = `PPh Final ${taxConfig.pph_rate}% on Rp ${taxableRevenue.toLocaleString('id-ID')} taxable revenue this year.`;
    } else if (taxConfig.tax_status === 'PKP') {
      // PKP: PPN collected is the tax liability to remit
      taxLiability = taxCollected;
      taxExplanation = `PKP — Total PPN (Pajak Keluaran) collected this year to be remitted to the government.`;
    }

    // Map combined transaction history (Buys and Sells)
    const transactionHistory = [];
    
    for (const tx of txHistory) {
      const isSystemAdj = tx.items.length === 0;
      const productNames = isSystemAdj ? (Number(tx.total) < 0 ? 'CASHUP SHORTAGE' : 'CASHUP OVERAGE') : Array.from(new Set(tx.items.map((i: any) => i.variant?.product?.name || 'Item'))).join(', ');
      
      transactionHistory.push({
        date: tx.created_at.toISOString(),
        product_name: productNames,
        type: 'S',
        qty: tx.items.reduce((sum: number, item: any) => sum + item.qty, 0),
        price: 0,
        buy_value: 0,
        sell_value: Number(tx.total),
        tax: Number(tx.tax_amount)
      });
    }

    for (const b of monthlyBatches) {
      transactionHistory.push({
        date: b.created_at.toISOString(),
        product_name: b.variant.product.name + (b.variant.name ? ` ${b.variant.name}` : ''),
        type: 'B',
        qty: b.initial_qty,
        price: Number(b.base_price),
        buy_value: b.initial_qty * Number(b.base_price),
        sell_value: 0,
        tax: 0
      });
    }

    // Map adjustments
    for (const log of adjustLogs) {
      if (log.change === 0) continue;
      
      let basePriceTotal = 0;
      let qtyTracked = 0;
      
      // If details exist, use them safely
      const logData = log as any;
      if (logData.details && Array.isArray(logData.details)) {
         for (const d of logData.details) {
            qtyTracked += Number(d.qty);
            basePriceTotal += (Number(d.qty) * Number(d.base_price));
         }
      }

      // Fallback base price if no details exist (legacy or skipped)
      const effectiveQty = qtyTracked || Math.abs(log.change);
      const effectiveBasePrice = basePriceTotal > 0 ? (basePriceTotal / effectiveQty) : 0;

      // Apply the negative sign if log.change is negative so qty is strictly signed
      const actualQty = log.change < 0 ? -Math.abs(effectiveQty) : Math.abs(effectiveQty);

      transactionHistory.push({
        date: log.created_at.toISOString(),
        product_name: `[${log.reason}] ${log.variant.product.name}` + (log.variant.name ? ` ${log.variant.name}` : ''),
        type: log.change > 0 ? 'A (In)' : 'A (Out)', // Explicit direction
        qty: actualQty,
        price: effectiveBasePrice,
        buy_value: log.change < 0 ? -basePriceTotal : basePriceTotal,
        sell_value: 0,
        tax: 0
      });
    }

    // Chronological sort
    transactionHistory.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Map inventory valuation (separate by batches as requested)
    const inventoryValuation = activeBatches.map(batch => ({
      sku: batch.variant.sku,
      product_name: batch.variant.product.name + (batch.variant.name ? ` - ${batch.variant.name}` : ''),
      qty: batch.remaining_qty,
      base_price: Number(batch.base_price),
      valuation: batch.remaining_qty * Number(batch.base_price)
    })).sort((a: any, b: any) => b.valuation - a.valuation);

    return res.json({
      period: { year: y, from: from.toISOString(), to: to.toISOString() },
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
      inventory_valuation: inventoryValuation,
      transaction_history: transactionHistory,
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

    // Fetch Stock Deductions (Losses/Damages) for timeline
    const deductions = await prisma.stockLog.findMany({
      where: { created_at: { gte: from, lt: to }, change: { lt: 0 }, reason: { in: ['DAMAGE', 'ADJUSTMENT', 'RETURN'] } },
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
      if (s.items.length === 0) {
        // System Cashup Discrepancy
        const val = Number(s.total);
        if (val < 0) {
          const loss = Math.abs(val);
          totalExpenses += loss;
          ledger.push({
            date: s.created_at.toISOString(),
            type: 'SHORTAGE',
            ref_id: s.id,
            description: `Cashup Shortage (Missing Cash)`,
            debit: 0,
            credit: loss,
            profit: -loss,
          });
        } else {
          totalSalesRevenue += val;
          ledger.push({
            date: s.created_at.toISOString(),
            type: 'OVERAGE',
            ref_id: s.id,
            description: `Cashup Overage (Surplus Cash)`,
            debit: val,
            credit: 0,
            profit: val,
          });
        }
        continue;
      }

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

    for (const d of deductions) {
      let lossValue = 0;
      const logData = d as any;
      if (logData.details && Array.isArray(logData.details)) {
        for (const det of logData.details) {
          lossValue += Number(det.qty) * Number(det.base_price);
        }
      }
      if (lossValue > 0) {
        totalExpenses += lossValue;
        ledger.push({
          date: d.created_at.toISOString(),
          type: 'LOSS',
          ref_id: d.id,
          description: `Stock Adjusted (Lost) [${d.reason}]: ${d.variant.product.name}`,
          debit: 0,
          credit: lossValue,
          profit: -lossValue,
        });
      }
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