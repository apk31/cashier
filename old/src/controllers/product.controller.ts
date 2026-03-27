import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

const prisma = new PrismaClient();

export const createProduct = async (req: Request, res: Response) => {
  const { name, category_id, sku, price, stock, barcode } = req.body;

  try {
    // We use a transaction to ensure both Product and Variant are created together
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          id: uuidv7(),
          name,
          category_id,
        },
      });

      const variant = await tx.variant.create({
        data: {
          id: uuidv7(),
          product_id: product.id,
          sku: sku || `SKU-${Date.now()}`,
          price,
          stock: stock || 0,
          barcode: barcode || null,
        },
      });

      return { product, variant };
    });

    res.status(201).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create product and variant' });
  }
};

export const getProducts = async (req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    include: {
      category: true,
      variants: true,
    },
  });
  res.json(products);
};