-- CreateEnum
CREATE TYPE "StockReason" AS ENUM ('SALE', 'RESTOCK', 'ADJUSTMENT', 'DAMAGE', 'RETURN');

-- CreateTable
CREATE TABLE "stock_logs" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "old_stock" INTEGER NOT NULL,
    "new_stock" INTEGER NOT NULL,
    "change" INTEGER NOT NULL,
    "reason" "StockReason" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_logs_variant_id_idx" ON "stock_logs"("variant_id");

-- CreateIndex
CREATE INDEX "stock_logs_user_id_idx" ON "stock_logs"("user_id");

-- CreateIndex
CREATE INDEX "stock_logs_created_at_idx" ON "stock_logs"("created_at");

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
