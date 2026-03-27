import { Request, Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { AuthRequest } from '../middlewares/auth.middleware';

// ─── Validation schemas ───────────────────────────────────────────────────────

const variantSchema = z.object({
  name: z.string().optional(),
  sku: z.string().min(1),
  barcode: z.string().optional(),
  price: z.number().positive(),
  stock: z.number().int().min(0).default(0),
});

const createProductSchema = z.object({
  name: z.string().min(1),
  category_id: z.string().uuid(),
  variants: z.array(variantSchema).min(1),
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  category_id: z.string().uuid().optional(),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const getProducts = async (req: Request, res: Response) => {
  const { q, category_id, page = '1', limit = '50' } = req.query as Record<string, string>;

  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  try {
    const where = {
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(category_id ? { category_id } : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { category: true, variants: true },
        orderBy: { name: 'asc' },
        take,
        skip,
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({ data: products, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[product.getAll]', error);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
};

// Fast barcode / SKU lookup for cashier scanner
export const getProductByBarcode = async (req: Request, res: Response) => {
  const { code } = req.params;
  try {
    const variant = await prisma.variant.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: { product: { include: { category: true } } },
    });
    if (!variant) return res.status(404).json({ error: 'Product not found' });
    return res.json(variant);
  } catch (error) {
    console.error('[product.barcode]', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const createProduct = async (req: Request, res: Response) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() });
  }

  const { name, category_id, variants } = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { id: uuidv7(), name, category_id },
      });

      const createdVariants = await Promise.all(
        variants.map((v) =>
          tx.variant.create({
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
        )
      );

      return { ...product, variants: createdVariants };
    });

    return res.status(201).json(result);
  } catch (error: any) {
    console.error('[product.create]', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'A variant with that SKU or barcode already exists' });
    }
    return res.status(500).json({ error: 'Failed to create product' });
  }
};

export const updateProduct = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const product = await prisma.product.update({
      where: { id },
      data: parsed.data,
      include: { variants: true, category: true },
    });
    return res.json(product);
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Product not found' });
    console.error('[product.update]', error);
    return res.status(500).json({ error: 'Failed to update product' });
  }
};

// Update price for a variant — logs the change
export const updateVariantPrice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params; // variant id
  const userId = req.user!.id;

  const parsed = z.object({ price: z.number().positive() }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findUnique({ where: { id } });
      if (!variant) throw new Error('Variant not found');

      await tx.priceLog.create({
        data: {
          id: uuidv7(),
          variant_id: id,
          old_price: variant.price,
          new_price: parsed.data.price,
          changed_by: userId,
        },
      });

      return tx.variant.update({ where: { id }, data: { price: parsed.data.price } });
    });

    return res.json(result);
  } catch (error: any) {
    if (error.message === 'Variant not found') return res.status(404).json({ error: 'Variant not found' });
    console.error('[product.updatePrice]', error);
    return res.status(500).json({ error: 'Failed to update price' });
  }
};

// Update stock for a variant
export const updateVariantStock = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const parsed = z.object({ stock: z.number().int().min(0) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const variant = await prisma.variant.update({
      where: { id },
      data: { stock: parsed.data.stock },
    });
    return res.json(variant);
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Variant not found' });
    return res.status(500).json({ error: 'Failed to update stock' });
  }
};
