/*
  Warnings:

  - The values [SPLIT] on the enum `PaymentMethod` will be removed. If these variants are still used in the database, this will fail.
  - The `tier` column on the `members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[username]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `subtotal` to the `transactions` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `vouchers` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "MemberTier" AS ENUM ('BASIC', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "VoucherType" AS ENUM ('PERCENTAGE', 'FIXED');

-- AlterEnum
BEGIN;
CREATE TYPE "PaymentMethod_new" AS ENUM ('CASH', 'QRIS', 'TRANSFER');
ALTER TABLE "payments" ALTER COLUMN "method" TYPE "PaymentMethod_new" USING ("method"::text::"PaymentMethod_new");
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
ALTER TYPE "PaymentMethod_new" RENAME TO "PaymentMethod";
DROP TYPE "public"."PaymentMethod_old";
COMMIT;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
DROP COLUMN "tier",
ADD COLUMN     "tier" "MemberTier" NOT NULL DEFAULT 'BASIC';

-- AlterTable
ALTER TABLE "offline_queue" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "discount_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "member_id" UUID,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "voucher_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "username" TEXT;

-- AlterTable
ALTER TABLE "variants" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "vouchers" ADD COLUMN     "max_uses" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "used_count" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "type",
ADD COLUMN     "type" "VoucherType" NOT NULL;

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX "members_phone_idx" ON "members"("phone");

-- CreateIndex
CREATE INDEX "offline_queue_synced_at_idx" ON "offline_queue"("synced_at");

-- CreateIndex
CREATE INDEX "payments_transaction_id_idx" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "price_logs_variant_id_idx" ON "price_logs"("variant_id");

-- CreateIndex
CREATE INDEX "price_logs_changed_by_idx" ON "price_logs"("changed_by");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "transaction_items_transaction_id_idx" ON "transaction_items"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_items_variant_id_idx" ON "transaction_items"("variant_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_idx" ON "transactions"("user_id");

-- CreateIndex
CREATE INDEX "transactions_member_id_idx" ON "transactions"("member_id");

-- CreateIndex
CREATE INDEX "transactions_created_at_idx" ON "transactions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "variants_product_id_idx" ON "variants"("product_id");

-- CreateIndex
CREATE INDEX "variants_barcode_idx" ON "variants"("barcode");

-- CreateIndex
CREATE INDEX "vouchers_code_idx" ON "vouchers"("code");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
