import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

const prisma = new PrismaClient();

export const getCategories = async (req: Request, res: Response) => {
  const categories = await prisma.category.findMany({
    include: { _count: { select: { products: true } } }
  });
  res.json(categories);
};

export const createCategory = async (req: Request, res: Response) => {
  const { name, parent_id } = req.body;
  try {
    const category = await prisma.category.create({
      data: {
        id: uuidv7(),
        name,
        parent_id: parent_id || null
      }
    });
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: "Failed to create category" });
  }
};