import type { PrismaClient } from '@prisma/client'
import { StockReason } from '@prisma/client'
import { uuidv7 } from 'uuidv7'

// Re-export so controllers only need to import from one place
export { StockReason }

// Prisma interactive transaction client type
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export const logStockChange = async (
  tx: TxClient,
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
      note: note ?? null,
    },
  })
}
