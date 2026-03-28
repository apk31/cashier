-- AlterTable
ALTER TABLE "transaction_items" ADD COLUMN     "cogs_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "initial_qty" INTEGER NOT NULL,
    "remaining_qty" INTEGER NOT NULL,
    "base_price" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_batches_variant_id_idx" ON "stock_batches"("variant_id");

-- CreateIndex
CREATE INDEX "stock_batches_created_at_idx" ON "stock_batches"("created_at");

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
