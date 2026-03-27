import { Response } from 'express'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { prisma } from '../lib/prisma'
import { AuthRequest } from '../middlewares/auth.middleware'
import { logStockChange, StockReason } from '../lib/inventory'

// ─── Validation schemas ───────────────────────────────────────────────────────

const variantSchema = z.object({
  name: z.string().optional(),
  sku: z.string().min(1),
  barcode: z.string().optional(),
  price: z.number().positive(),
  stock: z.number().int().min(0).default(0),
})

const createProductSchema = z.object({
  name: z.string().min(1),
  category_id: z.string().uuid(),
  variants: z.array(variantSchema).min(1),
})

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  category_id: z.string().uuid().optional(),
})

const updateStockSchema = z.object({
  quantity: z.number().int({ message: 'quantity must be an integer' }),
  reason: z.nativeEnum(StockReason).optional().default(StockReason.ADJUSTMENT),
  note: z.string().max(255).optional(),
})

// ─── Controllers ──────────────────────────────────────────────────────────────

export const getProducts = async (req: AuthRequest, res: Response) => {
  const { q, category_id, page = '1', limit = '50' } = req.query as Record<string, string>

  const take = Math.min(parseInt(limit) || 50, 200)
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take

  try {
    const where = {
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(category_id ? { category_id } : {}),
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { category: true, variants: true },
        orderBy: { name: 'asc' },
        take,
        skip,
      }),
      prisma.product.count({ where }),
    ])

    return res.json({ data: products, total, page: parseInt(page), limit: take })
  } catch (error) {
    console.error('[product.getAll]', error)
    return res.status(500).json({ error: 'Failed to fetch products' })
  }
}

// Fast barcode / SKU lookup for cashier scanner
export const getProductByBarcode = async (req: AuthRequest, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  try {
    const variant = await prisma.variant.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: { product: { include: { category: true } } },
    })
    if (!variant) return res.status(404).json({ error: 'Product not found' })
    return res.json(variant)
  } catch (error) {
    console.error('[product.barcode]', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const createProduct = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const parsed = createProductSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() })
  }

  const { name, category_id, variants } = parsed.data

  try {
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { id: uuidv7(), name, category_id },
      })

      const createdVariants = await Promise.all(
        variants.map(async (v) => {
          const variant = await tx.variant.create({
            data: {
              id: uuidv7(),
              product_id: product.id,
              name: v.name ?? null,
              sku: v.sku || `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              barcode: v.barcode ?? null,
              price: v.price,
              stock: v.stock,
            },
          })

          // Log initial stock so the audit trail has no gaps
          if (v.stock > 0) {
            await logStockChange(
              tx, variant.id, userId,
              0, v.stock,
              StockReason.RESTOCK,
              'Initial stock on product creation'
            )
          }

          return variant
        })
      )

      return { ...product, variants: createdVariants }
    })

    return res.status(201).json(result)
  } catch (error: unknown) {
    console.error('[product.create]', error)
    const e = error as { code?: string }
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'A variant with that SKU or barcode already exists' })
    }
    return res.status(500).json({ error: 'Failed to create product' })
  }
}

export const updateProduct = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = updateProductSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() })
  }

  try {
    const product = await prisma.product.update({
      where: { id },
      data: parsed.data,
      include: { variants: true, category: true },
    })
    return res.json(product)
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return res.status(404).json({ error: 'Product not found' })
    console.error('[product.update]', error)
    return res.status(500).json({ error: 'Failed to update product' })
  }
}

// Update variant price — logs the change for tax audit trail
export const updateVariantPrice = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const parsed = z.object({ price: z.number().positive() }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findUnique({ where: { id } })
      if (!variant) throw new Error('Variant not found')

      await tx.priceLog.create({
        data: {
          id: uuidv7(),
          variant_id: id,
          old_price: variant.price,
          new_price: parsed.data.price,
          changed_by: userId,
        },
      })

      return tx.variant.update({ where: { id }, data: { price: parsed.data.price } })
    })

    return res.json(result)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : ''
    if (msg === 'Variant not found') return res.status(404).json({ error: 'Variant not found' })
    console.error('[product.updatePrice]', error)
    return res.status(500).json({ error: 'Failed to update price' })
  }
}

// Update variant stock — quantity is a delta (+/-), logs to StockLog
export const updateVariantStock = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const parsed = updateStockSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() })
  }

  const { quantity, reason, note } = parsed.data

  try {
    const result = await prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findUnique({ where: { id } })
      if (!variant) throw new Error('Variant not found')

      const oldStock = variant.stock
      const newStock = oldStock + quantity

      const updated = await tx.variant.update({
        where: { id },
        data: { stock: newStock },
      })

      await logStockChange(tx, id, userId, oldStock, newStock, reason, note)

      return updated
    })

    return res.json(result)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : ''
    if (msg === 'Variant not found') return res.status(404).json({ error: 'Variant not found' })
    console.error('[product.updateStock]', error)
    return res.status(500).json({ error: 'Failed to update stock' })
  }
}
