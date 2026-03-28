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
  price: z.number().min(0),
  stock: z.number().int().min(0).default(0),
  base_price: z.number().min(0).optional().default(0),
  has_open_price: z.boolean().default(false),
})

const createProductSchema = z.object({
  name: z.string().min(1),
  category_id: z.string().min(1),
  variants: z.array(variantSchema).min(1),
})

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  category_id: z.string().min(1).optional(),
})

const updateStockSchema = z.object({
  quantity: z.number().int({ message: 'quantity must be an integer' }),
  base_price: z.number().min(0).optional().default(0),
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
        include: { 
      category: true, 
      variants: {
        include: {
          stock_batches: {
            where: { remaining_qty: { gt: 0 } }, // Only send batches that still have stock
            orderBy: { created_at: 'asc' } // Oldest first (FIFO)
          }
        }
      } 
    },
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
              has_open_price: v.has_open_price,
            },
          })

          // Log initial stock and create batch so the audit trail has no gaps
          if (v.stock > 0) {
            await tx.stockBatch.create({
              data: {
                id: uuidv7(),
                variant_id: variant.id,
                initial_qty: v.stock,
                remaining_qty: v.stock,
                base_price: v.base_price,
              }
            });
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

      if (newStock < 0) throw new Error(`Stock cannot go negative. Current stock: ${oldStock}`)

      if (quantity > 0) {
        // Add new shipment to FIFO queue
        await tx.stockBatch.create({
          data: {
            id: uuidv7(),
            variant_id: id,
            initial_qty: quantity,
            remaining_qty: quantity,
            base_price: parsed.data.base_price,
          }
        });
      } else if (quantity < 0) {
        // Remove from oldest FIFO queue
        const batches = await tx.stockBatch.findMany({
          where: { variant_id: id, remaining_qty: { gt: 0 } },
          orderBy: { created_at: 'asc' }
        });
        let qtyToDrop = Math.abs(quantity);
        for (const batch of batches) {
           if (qtyToDrop <= 0) break;
           const taking = Math.min(batch.remaining_qty, qtyToDrop);
           qtyToDrop -= taking;
           await tx.stockBatch.update({
             where: { id: batch.id },
             data: { remaining_qty: batch.remaining_qty - taking }
           });
        }
      }

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
    if (msg.startsWith('Stock cannot go negative')) return res.status(400).json({ error: msg })
    console.error('[product.updateStock]', error)
    return res.status(500).json({ error: 'Failed to update stock' })
  }
}

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    await prisma.product.delete({ where: { id } })
    return res.status(204).send()
  } catch (error: unknown) {
    const e = error as { code?: string }
    if (e.code === 'P2025') return res.status(404).json({ error: 'Product not found' })
    if (e.code === 'P2003') return res.status(409).json({ error: 'Cannot delete product with existing transaction history' })
    console.error('[product.delete]', error)
    return res.status(500).json({ error: 'Failed to delete product' })
  }
}

// ─── Bulk Operations ──────────────────────────────────────────────────────────

const bulkItemSchema = z.object({
  category_name: z.string().min(1),
  product_name: z.string().min(1),
  variant_name: z.string().optional().nullable(),
  sku: z.string().min(1),
  barcode: z.string().optional().nullable(),
  price: z.number().min(0),
  stock: z.number().int().min(0).default(0),
  base_price: z.number().min(0).optional().default(0),
  has_open_price: z.boolean().default(false),
});

const bulkApplySchema = z.array(bulkItemSchema).min(1);

export const exportProductsBulk = async (req: AuthRequest, res: Response) => {
  try {
    const variants = await prisma.variant.findMany({
      include: {
        product: {
          include: { category: true }
        }
      },
      orderBy: [
        { product: { category: { name: 'asc' } } },
        { product: { name: 'asc' } },
        { sku: 'asc' }
      ]
    });

    const flatData = variants.map(v => ({
      category_name: v.product.category.name,
      product_name: v.product.name,
      variant_name: v.name || '',
      sku: v.sku,
      barcode: v.barcode || '',
      price: Number(v.price),
      stock: v.stock,
      base_price: 0,
      has_open_price: v.has_open_price
    }));

    return res.json({ data: flatData });
  } catch (error) {
    console.error('[product.bulkExport]', error);
    return res.status(500).json({ error: 'Failed to export products' });
  }
};

export const applyProductsBulk = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const parsed = bulkApplySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let createdCount = 0;
      let updatedCount = 0;

      for (const row of parsed.data) {
        // 1. Resolve/Upsert Category
        let category = await tx.category.findFirst({ where: { name: row.category_name } });
        if (!category) {
          category = await tx.category.create({
            data: { id: uuidv7(), name: row.category_name }
          });
        }

        // 2. Resolve/Upsert Product
        let product = await tx.product.findFirst({ 
          where: { name: row.product_name, category_id: category.id } 
        });
        if (!product) {
          product = await tx.product.create({
            data: { id: uuidv7(), name: row.product_name, category_id: category.id }
          });
        }

        // 3. Resolve/Upsert Variant
        const existingVariant = await tx.variant.findUnique({ where: { sku: row.sku } });

        if (!existingVariant) {
          // CREATE
          const newVariant = await tx.variant.create({
            data: {
              id: uuidv7(),
              product_id: product.id,
              name: row.variant_name || null,
              sku: row.sku,
              barcode: row.barcode || null,
              price: row.price,
              stock: row.stock,
              has_open_price: row.has_open_price
            }
          });
          
          if (row.stock > 0) {
            await logStockChange(tx, newVariant.id, userId, 0, row.stock, StockReason.RESTOCK, 'Bulk Import Creation');
          }
          createdCount++;
        } else {
          // UPDATE
          const oldStock = existingVariant.stock;
          const oldPrice = Number(existingVariant.price);
          const needsPriceLog = oldPrice !== row.price;
          const needsStockLog = oldStock !== row.stock;

          await tx.variant.update({
            where: { id: existingVariant.id },
            data: {
              product_id: product.id,
              name: row.variant_name || null,
              barcode: row.barcode || null,
              price: row.price,
              stock: row.stock,
              has_open_price: row.has_open_price
            }
          });

          if (needsPriceLog) {
            await tx.priceLog.create({
               data: { id: uuidv7(), variant_id: existingVariant.id, old_price: oldPrice, new_price: row.price, changed_by: userId }
            });
          }

          if (needsStockLog) {
            const diff = row.stock - oldStock;
            if (diff > 0) {
               await tx.stockBatch.create({
                 data: { id: uuidv7(), variant_id: existingVariant.id, initial_qty: diff, remaining_qty: diff, base_price: row.base_price }
               });
            } else if (diff < 0) {
               const batches = await tx.stockBatch.findMany({
                 where: { variant_id: existingVariant.id, remaining_qty: { gt: 0 } },
                 orderBy: { created_at: 'asc' }
               });
               let qtyToDrop = Math.abs(diff);
               for (const batch of batches) {
                  if (qtyToDrop <= 0) break;
                  const taking = Math.min(batch.remaining_qty, qtyToDrop);
                  qtyToDrop -= taking;
                  await tx.stockBatch.update({
                    where: { id: batch.id },
                    data: { remaining_qty: batch.remaining_qty - taking }
                  });
               }
            }
            await logStockChange(tx, existingVariant.id, userId, oldStock, row.stock, StockReason.ADJUSTMENT, 'Bulk Import Update');
          }

          updatedCount++;
        }
      }

      return { success: true, processed: parsed.data.length, created: createdCount, updated: updatedCount };
    });

    return res.json(result);
  } catch (error: any) {
    console.error('[product.bulkApply]', error);
    // Best effort error msg for uniqueness constraints (e.g. duplicate barcode)
    if (error.code === 'P2002') return res.status(409).json({ error: 'Bulk import failed due to duplicate SKU or Barcode in your data.' });
    return res.status(500).json({ error: 'Bulk import transaction failed' });
  }
};
