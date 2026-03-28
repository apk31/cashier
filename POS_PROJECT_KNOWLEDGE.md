# POS Kasir — Project Knowledge Document
_Generated 2026-03-28 · Backend v5 · For AI handoff / onboarding_

---

## 1. Project Overview

A full-stack **Progressive Web App Point-of-Sale system** for Indonesian retail stores.

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 + TypeScript (commonjs module) |
| ORM | Prisma 6 + PostgreSQL 16 (Aiven cloud) |
| Server | Oracle Cloud VM Ubuntu 22.04 |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS (PWA) |
| Auth | JWT — email+password (Admin/Manager), username+PIN (Cashier) |
| Offline | IndexedDB via Dexie.js + background sync queue |
| Receipt Printer | ESC/POS 58mm via USB / Bluetooth / IP |

---

## 2. File Structure

```
cashier/  ← backend repo
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts                    # Creates admin user + GLOBAL settings row
│   └── migrations/
│       ├── 20260326194441_newdeploy/
│       ├── 20260327035248_updateschema/
│       └── 20260327072807_addstockenum/
│       [PENDING: has_open_price — run npx prisma migrate dev]
├── src/
│   ├── app.ts                     # Express entry — all routes mounted here
│   ├── controllers/               # 12 files (see §4)
│   ├── routes/                    # 11 files (see §4)
│   ├── middlewares/auth.middleware.ts
│   └── lib/
│       ├── env.ts                 # validateEnv() — throws on startup if missing vars
│       ├── prisma.ts              # Singleton PrismaClient
│       ├── inventory.ts           # logStockChange() + StockReason re-export
│       └── receipt.ts             # generateReceiptString(transaction, StoreInfo)
├── .env.example
├── package.json
└── tsconfig.json

pos-frontend/  ← frontend repo (partially scaffolded)
├── src/
│   ├── types/index.ts             # All TypeScript interfaces
│   ├── lib/api.ts                 # Axios client wrapping all API endpoints
│   ├── lib/db.ts                  # Dexie IndexedDB — offline queue + product cache
│   ├── lib/sync.ts                # Drains offline queue when back online
│   ├── stores/auth.store.ts       # Zustand — JWT token + user
│   ├── stores/cart.store.ts       # Zustand — live checkout cart
│   ├── stores/network.store.ts    # Zustand — isOnline + pendingCount
│   ├── components/layout/AppShell.tsx  # Sidebar nav layout
│   └── pages/LoginPage.tsx        # PIN numpad + email/password modes
[NEXT TO BUILD: CashierPage — split panel checkout screen]
```

---

## 3. Database Schema

### Enums (Prisma)
```prisma
Role:          ADMIN | MANAGER | CASHIER
PaymentMethod: CASH | QRIS | TRANSFER
               # No SPLIT enum — split payment = multiple Payment rows
MemberTier:    BASIC | SILVER | GOLD
VoucherType:   PERCENTAGE | FIXED
StockReason:   SALE | RESTOCK | ADJUSTMENT | DAMAGE | RETURN
```

### Models Summary

| Model | Key Fields | Notes |
|-------|-----------|-------|
| User | id(UUIDv7), email?, username?, password?(bcrypt), pin?(bcrypt), name, role | Cashier uses username+PIN |
| Category | id, name, parent_id? | Self-referencing tree for subcategories |
| Product | id, name, category_id | |
| Variant | id, product_id, name?, sku(unique), barcode?(unique), price(Decimal 12,2), stock(Int), **has_open_price(Bool)** | ⚠️ needs migration |
| PriceLog | id, variant_id, old_price, new_price, changed_by, created_at | Tax audit trail |
| StockLog | id, variant_id, user_id, old_stock, new_stock, change, reason(StockReason), note?, created_at | Full stock audit |
| Transaction | id(UUIDv7), user_id, member_id?, voucher_id?, subtotal, discount_total, total, created_at | created_at overrideable for offline |
| TransactionItem | id, transaction_id, variant_id, qty, price(snapshot), discount | price is snapshot at sale time |
| Payment | id, transaction_id, method, amount, ref_no? | Multiple per transaction for split |
| OfflineQueue | id, payload(Json), synced_at?, error?, created_at | Manager danger zone |
| Member | id, phone(unique), name, points, tier(MemberTier), created_at | Loyalty program |
| Voucher | id, code(unique), type, value, max_uses, used_count, exp | Used_count enforced |
| Setting | id="GLOBAL" (singleton), store_info(Json), tax_config(Json), printer_config(Json) | |

### Settings JSON shapes
```typescript
store_info:     { name, address, phone, logo_url, footer }
tax_config:     { is_pkp: bool, npwp: string|null, ppn_rate: number }
printer_config: { connection: 'USB'|'BT'|'IP', paper_width: 58|80,
                  ip_address: string|null, bt_device_id: string|null, show_qr: bool }
```

---

## 4. API Reference

Base URL: `http://localhost:3000` (dev) | `https://your-domain.com` (prod)
Auth header: `Authorization: Bearer <jwt_token>`

### POST /api/auth/login
```json
// Cashier:
{ "username": "kasir1", "pin": "1234" }
// Admin/Manager:
{ "email": "admin@toko.id", "password": "secret" }
// Response:
{ "token": "...", "user": { "id", "name", "role" } }
```
Rate-limited: 10 requests / 15 minutes per IP.

### GET /api/auth/me
Returns `{ id, name, role, email, username }` of logged-in user.

### Products
```
GET  /api/products?q=&category_id=&page=1&limit=50
GET  /api/products/barcode/:code        # Lookup by barcode OR sku (cashier scanner)
POST /api/products                      # { name, category_id, variants: [{ sku, price, stock, barcode?, name?, has_open_price? }] }
PATCH /api/products/:id                 # { name?, category_id? }
PATCH /api/products/variants/:id/price  # { price } — auto-logs PriceLog
PATCH /api/products/variants/:id/stock  # { quantity (delta +/-), reason?, note? }
DELETE /api/products/:id                # Admin only
GET  /api/products/bulk/export          # Flat export for CSV/XLSX editing
POST /api/products/bulk/apply           # Array of { category_name, product_name, sku, price, stock, ... }
```

### Transactions
```
POST /api/transactions
Body: {
  items: [{ variant_id, quantity, discount?, price? }],
  payments: [{ method: 'CASH'|'QRIS'|'TRANSFER', amount, ref_no? }],
  member_id?: uuid,
  voucher_code?: string,
  created_at?: ISO8601   // for offline sync
}
Response: { transaction: {...}, receipt_string: "...", change: number }

GET /api/transactions?page=&limit=&from=ISO&to=ISO
GET /api/transactions/:id
```

### Members
```
GET  /api/members?q=&page=&limit=      # Search by name or phone
GET  /api/members/:phone               # Exact lookup by phone
POST /api/members                      # { name, phone }
PATCH /api/members/:id                 # { name?, phone? } — Manager/Admin only
```

### Vouchers
```
GET /api/vouchers                      # List all
GET /api/vouchers/:code                # Lookup (used at checkout to preview)
POST /api/vouchers                     # { code, type: 'PERCENTAGE'|'FIXED', value, max_uses?, exp_days? }
```

### Reports
```
GET /api/reports/summary?from=ISO&to=ISO
  → { period, summary: { revenue, subtotal, discount_total, transaction_count },
      payment_breakdown, top_items, hourly_breakdown }

GET /api/reports/monthly?year=2025&month=12
  → { period, store, tax: { is_pkp, npwp, ppn_rate, ppn_amount },
      summary: { revenue, dpp, ... }, daily_breakdown, payment_breakdown }
  [Indonesian tax format — DPP = Dasar Pengenaan Pajak]

GET /api/reports/price-logs?from=ISO&to=ISO&page=&limit=
GET /api/reports/low-stock?threshold=10
```

### Inventory (Stock History)
```
GET /api/inventory/stock-history?from=ISO&to=ISO&variant_id=uuid&reason=SALE&page=&limit=
```

### Offline Sync
```
POST /api/offline/sync
Body: { transactions: [...] }  // Array of offline transaction payloads
Response: { message, results: { successful, failed, queued } }

Sync rules:
  - Transaction older than 6 hours → STALE → saved to queue, not executed
  - Transaction with voucher_code → INVALID_OFFLINE_VOUCHER → queued
  - Stock insufficient → EXECUTION_FAILED → queued for manager

GET    /api/offline/queue             # View danger zone (unsynced items)
POST   /api/offline/queue/:id/retry   # Manager retries a failed item
DELETE /api/offline/queue/:id         # Manager discards corrupted item
```

### Settings
```
GET   /api/settings          # Any authenticated user (PWA needs it for receipts)
PATCH /api/settings          # Admin only — partial update, deep merged
Body: {
  store_info?: { name?, address?, phone?, logo_url?, footer? },
  tax_config?: { is_pkp?, npwp?, ppn_rate? },
  printer_config?: { connection?, paper_width?, ip_address?, bt_device_id? }
}
```

### User Management (Admin only)
```
GET    /api/users
POST   /api/users            # { name, role, email?, password?, username?, pin? }
PATCH  /api/users/:id        # Partial update — password/pin auto-rehashed if provided
DELETE /api/users/:id        # Cannot delete self
```

---

## 5. Key Code Patterns

### ID generation
Always use `uuidv7()` from the `uuidv7` package. Never use `crypto.randomUUID()` or auto-increment.

### Money arithmetic
Prisma returns `Decimal` objects. Convert with `Number(variant.price)` for math. Store as Decimal in DB. Never float round-trip money.

### Stock change — ALWAYS log
```typescript
import { logStockChange, StockReason } from '../lib/inventory'
// Must be called inside a prisma.$transaction() block:
await logStockChange(tx, variantId, userId, oldStock, newStock, StockReason.SALE, note?)
```

### Price change — ALWAYS log
```typescript
await tx.priceLog.create({
  data: { id: uuidv7(), variant_id, old_price: variant.price, new_price, changed_by: userId }
})
```

### Error handling pattern
```typescript
// Input validation
const parsed = schema.safeParse(req.body)
if (!parsed.success) return res.status(400).json({ error: 'msg', details: parsed.error.flatten() })

// DB errors
} catch (error: unknown) {
  const e = error as { code?: string }
  if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' })
  if (e.code === 'P2002') return res.status(409).json({ error: 'Conflict' })
  if (e.code === 'P2003') return res.status(409).json({ error: 'FK constraint' })
  console.error('[controller.action]', error)
  return res.status(500).json({ error: 'Internal server error' })
}
```

### req.params workaround (@types/express v5)
Express 5 types params as `string | string[]` causing TS2322. Use this pattern:
```typescript
const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
```

### AuthRequest type
Use `AuthRequest` (not `Request`) in any controller that accesses `req.user`:
```typescript
import { AuthRequest } from '../middlewares/auth.middleware'
export const myController = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id  // string | undefined
}
```

### Prisma transaction client type
```typescript
type TxClient = Omit<PrismaClient, '$connect'|'$disconnect'|'$on'|'$transaction'|'$use'|'$extends'>
```

### Open-price items
```typescript
const unitPrice = variant.has_open_price && item.price !== undefined
  ? item.price
  : Number(variant.price)
```

### Receipt generation
```typescript
import { generateReceiptString, StoreInfo } from '../lib/receipt'
const settings = await tx.setting.findUnique({ where: { id: 'GLOBAL' } })
const storeInfo = (settings?.store_info as StoreInfo) || {}
const receiptString = generateReceiptString(transaction, storeInfo)
// Receipt is 32 chars wide (58mm ESC/POS standard)
```

---

## 6. Environment Variables

```bash
DATABASE_URL="postgresql://user:pass@host:port/db?sslmode=require"
JWT_SECRET="minimum 64 chars — use: openssl rand -hex 64"
JWT_EXPIRES_IN="12h"
ALLOWED_ORIGIN="https://pos.yourdomain.com"
SEED_ADMIN_PASSWORD="strong-password-here"
PORT=3000
NODE_ENV=production
```
`validateEnv()` is called at startup and throws if `DATABASE_URL` or `JWT_SECRET` are missing.

---

## 7. NPM Scripts

```bash
npm run dev           # tsx watch src/app.ts — hot reload dev
npm run build         # tsc — compile to dist/
npm start             # node dist/app.js — production
npm run db:migrate    # npx prisma migrate dev — dev migrations
npm run db:migrate:prod  # npx prisma migrate deploy — production
npm run db:seed       # tsx prisma/seed.ts — creates admin + default settings
npm run db:studio     # Prisma Studio GUI
```

---

## 8. Known Issues & Pending Work (as of v5)

### Must fix before deploying
1. **Run migration for `has_open_price`**: `npx prisma migrate dev --name add_open_price`
2. **Fix `.gitignore`**: Remove `/prisma/migrations` and `*.md` — migrations MUST be committed
3. **Clean package-lock.json**: Frontend packages (`idb`, `lucide-react`, `react-router-dom`, `zustand`) leaked into backend lock file — run `npm install` to reconcile
4. **transaction.controller.ts**: Final catch block returns 400 for ALL errors including real 500s — differentiate client vs server errors
5. **auth.controller.ts `getMe`**: Uses `(req as any).user` — change signature to `AuthRequest`

### Should fix before production
6. `offline.controller.ts`: No Zod validation on sync payload — add schema
7. `offline.controller.ts`: Extensive `any` types — define `OfflineTransactionPayload` interface
8. `transaction.controller.ts getTransactions`: Uses `whereOptions: any` — use `Prisma.TransactionWhereInput`
9. `member.controller.ts createMember`: Still uses `catch (error: any)` — change to `unknown`
10. `product.routes.ts`: Move `/bulk/export` and `/bulk/apply` before `/:id` routes

---

## 9. Frontend — What's Built vs What's Needed

### Built (scaffolded)
- `package.json` with all dependencies (React, Vite, Tailwind, TanStack Query, Zustand, Dexie, Axios, React Router v6, lucide-react, react-hot-toast, date-fns)
- `vite.config.ts` with PWA plugin (Workbox, manifest, service worker)
- `tailwind.config.js` with custom color palette (dark theme, surface/brand/success/warn/danger)
- `index.html` with DM Sans + JetBrains Mono fonts
- `src/index.css` with global styles, component classes (btn-primary, input, card, badge-tier-*)
- `src/main.tsx` with QueryClient, BrowserRouter, Toaster
- `src/App.tsx` with routes, RequireAuth guard, online/offline event listeners
- `src/types/index.ts` — complete type definitions matching backend
- `src/lib/api.ts` — all API calls wrapped
- `src/lib/db.ts` — Dexie schema for offlineQueue, productsCache, settingsCache
- `src/lib/sync.ts` — drains queue on reconnect
- `src/stores/` — auth, cart, network
- `src/components/layout/AppShell.tsx` — sidebar with nav, online indicator, pending count, user info
- `src/pages/LoginPage.tsx` — PIN numpad + email/password tabs, auto-submit on 4+ digits

### Next to build (Phase 2)
1. **CashierPage** (highest priority):
   - Split-panel: left = product search/grid, right = cart + payment
   - Barcode scanner (USB HID — listens to keyboard input on hidden field)
   - QR scanner via camera (web API)
   - Name search with debounce → API call
   - Cart management (qty stepper, per-item discount)
   - Member lookup by phone
   - Voucher code field
   - Payment modal (cash with change calc, QRIS, transfer, split multi-row)
   - Offline mode: save to IndexedDB, show banner, print receipt anyway
   - ESC/POS receipt printing

2. **InventoryPage** — product list, bulk CSV import/export, stock adjustment
3. **ReportsPage** — daily dashboard + monthly laporan
4. **SettingsPage** — store info, tax config, printer config, user management
5. **ESC/POS printer bridge** — for PC: tiny localhost agent; for mobile: Web Bluetooth API

---

## 10. Business Rules

- **Offline stock conflict**: Allow negative stock + flag for manager review (not rejected)
- **Vouchers are online-only**: Never applied during offline mode
- **Offline sync time limit**: 6 hours — transactions older than this are quarantined
- **Tax**: System defaults to non-PKP. PKP toggle in settings generates Faktur Pajak (PPN 11%)
- **Loyalty points**: 1 point per Rp 1,000 spent (on `total` after discounts, minimum Rp 1,000)
- **Split payment**: Send multiple `payments` objects — no SPLIT enum
- **Receipt QR code**: Off by default, toggle in printer_config.show_qr
- **Roles**:
  - CASHIER: checkout, view products, register/lookup members, view transactions
  - MANAGER: all cashier + inventory, reports, vouchers, member updates, offline queue
  - ADMIN: all manager + settings, user management, delete products/categories

---

## 11. Deployment Notes (Oracle VM Ubuntu 22.04)

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Deploy migrations (production)
npm run db:migrate:prod

# Seed (first time only — guarded by user count check)
SEED_ADMIN_PASSWORD=your-password npm run db:seed

# Build
npm run build

# Start (use PM2 for production)
pm2 start dist/app.js --name cashier-api

# Reverse proxy: Nginx → localhost:3000
```

Aiven PostgreSQL requires `?sslmode=require` in `DATABASE_URL`.

