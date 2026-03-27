import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { uuidv7 } from 'uuidv7';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  await prisma.user.deleteMany();

  const adminPassword = await bcrypt.hash('admin123', 10);

  await prisma.user.create({
    data: {
      id: uuidv7(),
      name: 'Owner Toko',
      email: 'admin@pos.id',
      password: adminPassword,
      role: 'ADMIN',
    },
  });

  console.log('✅ Seed successful!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());