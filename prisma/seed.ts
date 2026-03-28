import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { uuidv7 } from 'uuidv7';
import 'dotenv/config';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database with realistic dummy data...');

  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin123';
  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  // 1. Clear existing data (Optional: comment out if you want to keep existing)
  // await prisma.transactionItem.deleteMany();
  // await prisma.transaction.deleteMany();
  // await prisma.stockBatch.deleteMany();
  // await prisma.variant.deleteMany();
  // await prisma.product.deleteMany();
  // await prisma.category.deleteMany();

  // 2. Users
  const adminId = uuidv7();
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      id: adminId,
      name: 'Owner Toko',
      email: 'admin@pos.id',
      username: 'admin',
      password: hashedPassword,
      role: 'ADMIN',
    },
  });

  const cashierId = uuidv7();
  await prisma.user.upsert({
    where: { username: 'budi' },
    update: {},
    create: {
      id: cashierId,
      name: 'Budi Cashier',
      username: 'budi',
      pin: await bcrypt.hash('123456', 12),
      role: 'CASHIER',
    },
  });

  // 3. Settings
  await prisma.setting.upsert({
    where: { id: 'GLOBAL' },
    update: {},
    create: {
      id: 'GLOBAL',
      store_info: { name: 'Penguin Walk Coffee', address: 'Jl. Kopi No. 1, Malang', phone: '08123456789', footer: 'Thank you for visiting!' },
      tax_config: { is_pkp: true, npwp: '12.345.678.9-012.000', ppn_rate: 11 },
      printer_config: { connection: 'USB', paper_width: 58 },
    },
  });

  // 4. Categories & Products
  const catCoffeeId = uuidv7();
  const catFoodId = uuidv7();
  await prisma.category.createMany({
    data: [
      { id: catCoffeeId, name: 'Coffee Beverages' },
      { id: catFoodId, name: 'Pastries & Food' }
    ]
  });

  // Create Product 1: Iced Latte
  const prodLatteId = uuidv7();
  await prisma.product.create({
    data: { id: prodLatteId, name: 'Iced Caffe Latte', category_id: catCoffeeId }
  });

  const varLatteRegId = uuidv7();
  await prisma.variant.create({
    data: {
      id: varLatteRegId, product_id: prodLatteId, name: 'Regular', sku: 'LATTE-REG', price: 25000, stock: 50, has_open_price: false,
    }
  });

  // INITIAL STOCK BATCH (FIFO)
  await prisma.stockBatch.create({
    data: { id: uuidv7(), variant_id: varLatteRegId, initial_qty: 50, remaining_qty: 50, base_price: 12000 } // HPP: 12k
  });

  // Create Product 2: Croissant (Showcasing old vs new stock batches)
  const prodCroissantId = uuidv7();
  await prisma.product.create({
    data: { id: prodCroissantId, name: 'Butter Croissant', category_id: catFoodId }
  });

  const varCroissantId = uuidv7();
  await prisma.variant.create({
    data: {
      id: varCroissantId, product_id: prodCroissantId, name: 'Default', sku: 'FOOD-CROIS', price: 20000, stock: 30, has_open_price: false,
    }
  });

  // Two stock batches to test FIFO
  await prisma.stockBatch.create({
    data: { id: uuidv7(), variant_id: varCroissantId, initial_qty: 20, remaining_qty: 10, base_price: 8000, created_at: new Date(Date.now() - 86400000) } // Yesterday's batch, HPP 8k
  });
  await prisma.stockBatch.create({
    data: { id: uuidv7(), variant_id: varCroissantId, initial_qty: 20, remaining_qty: 20, base_price: 9000 } // Today's batch, price went up! HPP 9k
  });

  // 5. Sample Transactions
  const trxId = uuidv7();
  await prisma.transaction.create({
    data: {
      id: trxId, user_id: cashierId, subtotal: 45000, discount_total: 0, total: 45000,
      items: {
        create: [
          { id: uuidv7(), variant_id: varLatteRegId, qty: 1, price: 25000, discount: 0, cogs_total: 12000 },
          { id: uuidv7(), variant_id: varCroissantId, qty: 1, price: 20000, discount: 0, cogs_total: 8000 }, // Deducted from old batch
        ]
      },
      payments: {
        create: [{ id: uuidv7(), method: 'QRIS', amount: 45000 }]
      }
    }
  });

  console.log('✅ Seed complete. Run `npm run dev` in backend.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());