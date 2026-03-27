import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { AuthRequest } from '../middlewares/auth.middleware';

const prisma = new PrismaClient();

export const createTransaction = async (req: AuthRequest, res: Response) => {
  const { items, payment_method, amount_paid } = req.body;
  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ error: 'User not identified' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      let calculatedTotal = 0;
      const processedItems = [];

      // 1. Validate items and stock
      for (const item of items) {
        const variant = await tx.variant.findUnique({
          where: { id: item.variant_id },
        });

        if (!variant || variant.stock < item.quantity) {
          throw new Error(`Insufficient stock for ${variant?.sku || 'item'}`);
        }

        const itemSubtotal = Number(variant.price) * item.quantity;
        calculatedTotal += itemSubtotal;

        // Deduct Stock
        await tx.variant.update({
          where: { id: variant.id },
          data: { stock: { decrement: item.quantity } },
        });

        // Build the item array matching the TransactionItem schema exactly
        processedItems.push({
          id: uuidv7(),
          variant_id: variant.id,
          qty: item.quantity, 
          price: variant.price
        });
      }

      // 2. Create Transaction Header
      const transaction = await tx.transaction.create({
        data: {
          id: uuidv7(),
          user_id: userId,
          total: calculatedTotal,
          items: {
            create: processedItems
          },
          payments: { 
            create: {
              id: uuidv7(),
              method: payment_method,
              amount: amount_paid || calculatedTotal,
            }
          }
        },
        include: {
          items: true,
          payments: true
        }
      });

      return transaction;
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Transaction failed' });
  }
};