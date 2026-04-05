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
  tax_status: z.enum(['FREE', 'PPH_FINAL', 'PKP']).optional(),
  pph_rate: z.number().min(0).max(100).optional(),       // Default 0.5
  ppn_rate: z.number().min(0).max(100).optional(),       // Default 11
  pb1_rate: z.number().min(0).max(100).optional(),       // Restaurant tax, default 10
  service_charge_rate: z.number().min(0).max(100).optional(), // Default 5
  apply_ppn_to_sales: z.boolean().optional(),
  apply_pb1_to_sales: z.boolean().optional(),
  npwp: z.string().nullable().optional(),
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

// ─── Type for tax config used across the backend ──────────────────────────────

export interface TaxConfig {
  tax_status: 'FREE' | 'PPH_FINAL' | 'PKP'
  pph_rate: number
  ppn_rate: number
  pb1_rate: number
  service_charge_rate: number
  apply_ppn_to_sales: boolean
  apply_pb1_to_sales: boolean
  npwp?: string | null
}

export const DEFAULT_TAX_CONFIG: TaxConfig = {
  tax_status: 'FREE',
  pph_rate: 0.5,
  ppn_rate: 11,
  pb1_rate: 10,
  service_charge_rate: 5,
  apply_ppn_to_sales: false,
  apply_pb1_to_sales: false,
  npwp: null,
}

/** Parse raw JSON from DB into a typed TaxConfig, filling defaults for any missing keys */
export function parseTaxConfig(raw: unknown): TaxConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  // Backward-compat: old schema had `is_pkp: boolean`
  let taxStatus: TaxConfig['tax_status'] = DEFAULT_TAX_CONFIG.tax_status
  if (obj.tax_status && typeof obj.tax_status === 'string') {
    taxStatus = obj.tax_status as TaxConfig['tax_status']
  } else if (obj.is_pkp === true) {
    taxStatus = 'PKP'
  }

  return {
    tax_status: taxStatus,
    pph_rate: typeof obj.pph_rate === 'number' ? obj.pph_rate : DEFAULT_TAX_CONFIG.pph_rate,
    ppn_rate: typeof obj.ppn_rate === 'number' ? obj.ppn_rate : DEFAULT_TAX_CONFIG.ppn_rate,
    pb1_rate: typeof obj.pb1_rate === 'number' ? obj.pb1_rate : DEFAULT_TAX_CONFIG.pb1_rate,
    service_charge_rate: typeof obj.service_charge_rate === 'number' ? obj.service_charge_rate : DEFAULT_TAX_CONFIG.service_charge_rate,
    apply_ppn_to_sales: typeof obj.apply_ppn_to_sales === 'boolean' ? obj.apply_ppn_to_sales : DEFAULT_TAX_CONFIG.apply_ppn_to_sales,
    apply_pb1_to_sales: typeof obj.apply_pb1_to_sales === 'boolean' ? obj.apply_pb1_to_sales : DEFAULT_TAX_CONFIG.apply_pb1_to_sales,
    npwp: typeof obj.npwp === 'string' ? obj.npwp : DEFAULT_TAX_CONFIG.npwp,
  }
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/** GET /api/settings — any authenticated user (needed by the PWA to init) */
export const getSettings = async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await prisma.setting.findUnique({ where: { id: 'GLOBAL' } })
    if (!settings) {
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
