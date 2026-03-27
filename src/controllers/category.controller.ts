import { Request, Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';

const createCategorySchema = z.object({
  name: z.string().min(1),
  parent_id: z.string().uuid().optional(),
});

export const getCategories = async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      include: {
        subcategories: true,
        _count: { select: { products: true } },
      },
      orderBy: { name: 'asc' },
    });
    return res.json(categories);
  } catch (error) {
    console.error('[category.getAll]', error);
    return res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const createCategory = async (req: Request, res: Response) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  try {
    const category = await prisma.category.create({
      data: { id: uuidv7(), name: parsed.data.name, parent_id: parsed.data.parent_id ?? null },
    });
    return res.status(201).json(category);
  } catch (error) {
    console.error('[category.create]', error);
    return res.status(500).json({ error: 'Failed to create category' });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.category.delete({ where: { id } });
    return res.status(204).send();
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Category not found' });
    if (error.code === 'P2003') return res.status(409).json({ error: 'Cannot delete category with existing products' });
    return res.status(500).json({ error: 'Failed to delete category' });
  }
};
