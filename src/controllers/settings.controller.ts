import { Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { AuthRequest } from '../middlewares/auth.middleware'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const storeInfoSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  logo_url: z.string().url().nullable().optional(),
  footer: z.string().optional(),
})

const taxConfigSchema = z.object({
  is_pkp: z.boolean().optional(),
  npwp: z.string().nullable().optional(),
  ppn_rate: z.number().min(0).max(100).optional(),
})

const printerConfigSchema = z.object({
  connection: z.enum(['USB', 'BT', 'IP']).optional(),
  paper_width: z.number().int().optional(),
  ip_address: z.string().nullable().optional(),
  bt_device_id: z.string().nullable().optional(),
})

const updateSettingsSchema = z.object({
  store_info: storeInfoSchema.optional(),
  tax_config: taxConfigSchema.optional(),
  printer_config: printerConfigSchema.optional(),
})

// ─── Controllers ──────────────────────────────────────────────────────────────

/** GET /api/settings — any authenticated user (needed by the PWA to init) */
export const getSettings = async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.setting.findUnique({ where: { id: 'GLOBAL' } })
    if (!settings) {
      // Should never happen if seed was run, but guard gracefully
      return res.status(404).json({ error: 'Settings not initialised. Run db:seed.' })
    }
    return res.json(settings)
  } catch (error) {
    console.error('[settings.get]', error)
    return res.status(500).json({ error: 'Failed to fetch settings' })
  }
}

/** PATCH /api/settings — ADMIN only; deep-merge the provided sub-objects */
export const updateSettings = async (req: AuthRequest, res: Response) => {
  const parsed = updateSettingsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid settings payload', details: parsed.error.flatten() })
  }

  try {
    // Fetch current so we can deep-merge (partial updates are allowed)
    const current = await prisma.setting.findUnique({ where: { id: 'GLOBAL' } })
    if (!current) return res.status(404).json({ error: 'Settings not initialised. Run db:seed.' })

    const updated = await prisma.setting.update({
      where: { id: 'GLOBAL' },
      data: {
        store_info: parsed.data.store_info
          ? { ...(current.store_info as Record<string, unknown>), ...parsed.data.store_info }
          : (current.store_info as object),
        tax_config: parsed.data.tax_config
          ? { ...(current.tax_config as Record<string, unknown>), ...parsed.data.tax_config }
          : (current.tax_config as object),
        printer_config: parsed.data.printer_config
          ? { ...(current.printer_config as Record<string, unknown>), ...parsed.data.printer_config }
          : (current.printer_config as object),
      },
    })

    return res.json(updated)
  } catch (error) {
    console.error('[settings.update]', error)
    return res.status(500).json({ error: 'Failed to update settings' })
  }
}
