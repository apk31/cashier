import { prisma } from './prisma'; // Adjust based on your prisma export location
import { uuidv7 } from 'uuidv7';

export enum StockReason {
  SALE = 'SALE',
  RESTOCK = 'RESTOCK',
  ADJUSTMENT = 'ADJUSTMENT',
  DAMAGE = 'DAMAGE',
  RETURN = 'RETURN'
}

export const logStockChange = async (
  tx: any, // Use the transaction client
  variantId: string,
  userId: string,
  oldStock: number,
  newStock: number,
  reason: StockReason,
  note?: string
) => {
  return tx.stockLog.create({
    data: {
      id: uuidv7(),
      variant_id: variantId,
      user_id: userId,
      old_stock: oldStock,
      new_stock: newStock,
      change: newStock - oldStock,
      reason,
      note
    }
  });
};