import { Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { StockReason } from '../lib/inventory'

// ─── Validation ───────────────────────────────────────────────────────────────

const dateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

function getDateRange(query: Record<string, string>) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return {
    from: query.from ? new Date(query.from) : today,
    to: query.to   ? new Date(query.to)   : tomorrow,
  }
}

// ─── Controllers ──────────────────────────────────────────────────────────────

export const getStockHistory = async (req: Request, res: Response) => {
  const dateValidation = dateRangeSchema.safeParse(req.query)
  if (!dateValidation.success) {
    return res.status(400).json({ error: 'Invalid date range', details: dateValidation.error.flatten() })
  }

  const { from, to } = getDateRange(req.query as Record<string, string>)
  const { variant_id, reason, page = '1', limit = '50' } = req.query as Record<string, string>

  // Validate reason filter if provided
  if (reason && !Object.values(StockReason).includes(reason as StockReason)) {
    return res.status(400).json({ error: `reason must be one of: ${Object.values(StockReason).join(', ')}` })
  }

  const take = Math.min(parseInt(limit) || 50, 200)
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take

  try {
    const where = {
      created_at: { gte: from, lt: to },
      ...(variant_id ? { variant_id } : {}),
      ...(reason ? { reason: reason as StockReason } : {}),
    }

    const [logs, total] = await Promise.all([
      prisma.stockLog.findMany({
        where,
        include: {
          variant: { include: { product: { select: { name: true } } } },
          user: { select: { name: true, role: true } },
        },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      }),
      prisma.stockLog.count({ where }),
    ])

    return res.json({ data: logs, total, page: parseInt(page), limit: take })
  } catch (error) {
    console.error('[inventory.stockHistory]', error)
    return res.status(500).json({ error: 'Failed to fetch stock history' })
  }
}
