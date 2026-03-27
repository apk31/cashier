import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { uuidv7 } from 'uuidv7';
import 'dotenv/config';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Guard: only seed if no users exist — safe to re-run
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    console.log(`Skipping seed — ${existingUsers} user(s) already exist.`);
    return;
  }

  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD env var is required for seeding');

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  await prisma.user.create({
    data: {
      id: uuidv7(),
      name: 'Owner Toko',
      email: 'admin@pos.id',
      username: 'admin',
      password: hashedPassword,
      role: 'ADMIN',
    },
  });

  // Default settings (singleton)
  await prisma.setting.upsert({
    where: { id: 'GLOBAL' },
    update: {},
    create: {
      id: 'GLOBAL',
      store_info: {
        name: 'Toko Saya',
        address: '',
        phone: '',
        logo_url: null,
        footer: 'Terima kasih telah berbelanja!',
      },
      tax_config: {
        is_pkp: false,
        npwp: null,
        ppn_rate: 11,
      },
      printer_config: {
        connection: 'USB',
        paper_width: 58,
        ip_address: null,
        bt_device_id: null,
      },
    },
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
