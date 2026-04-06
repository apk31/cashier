# POS Kasir — Project Knowledge Document
_Generated 2026-04-05 · Platform v6 · For AI handoff / onboarding_

---

## 1. Project Overview

A full-stack **Progressive Web App Point-of-Sale system** for Indonesian retail stores, featuring full Indonesian Tax Localization (UMKM/PPh Final/PKP) and Business Operations management.

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 + TypeScript (commonjs module) |
| ORM | Prisma 6 + PostgreSQL 16 (Aiven cloud) |
| Server | Oracle Cloud VM Ubuntu 22.04 |
| Frontend | React 19 + Vite 8 + TypeScript + Tailwind CSS (PWA) |
| Auth | JWT — email+password (Admin/Manager), username+PIN (Cashier) |
| Offline | IndexedDB via Dexie.js + background sync queue |
| Receipt Printer | ESC/POS 58mm via USB / Bluetooth / IP |

---

## 2. File Structure

```
cashier/  ← backend repo
├── prisma/
│   ├── schema.prisma              # 15 models + 7 enums
│   ├── seed.ts                    # Creates admin user + default settings + dummy shifts/expenses
│   └── migrations/                # includes upgrade_tax_shifts_expenses
├── src/
│   ├── app.ts                     # Express entry — mounts all routes (including shifts/expenses)
│   ├── controllers/               # Business logic
│   ├── routes/                    # Router definitions
│   ├── middlewares/               # auth.middleware.ts (requireAuth, requireRole)
│   └── lib/
│       ├── prisma.ts              # Singleton PrismaClient
│       ├── inventory.ts           # logStockChange() for FIFO adjustments
│       └── receipt.ts             # generateReceiptString() with Tax and Service Charge lines
└── tsconfig.json

cashier-frontend/  ← frontend repo
├── src/
│   ├── types/index.ts             # All TS interfaces synchronized with v6 backend
│   ├── lib/api.ts                 # Axios client wrapping all API endpoints
│   ├── lib/db.ts                  # Dexie IndexedDB — offline queue + cache
│   ├── store/                     # Zustand stores (auth, cart, i18n, sync)
│   ├── components/
│   │   ├── cashier/               # CartBox, PaymentModal, ProductGrid
│   │   ├── inventory/             # ProductModal, BulkImportModal
│   │   └── reports/               # TaxReportTab, EStatementTab
│   └── pages/                     # CashierPage, SettingsPage, ReportsPage, etc.
└── vite.config.ts
```

---

## 3. Database Schema

### Enums (Prisma)
```prisma
Role:          ADMIN | MANAGER | CASHIER
PaymentMethod: CASH | QRIS | TRANSFER
MemberTier:    BASIC | SILVER | GOLD
VoucherType:   PERCENTAGE | FIXED
StockReason:   SALE | RESTOCK | ADJUSTMENT | DAMAGE | RETURN
OrderStatus:   OPEN | PAID | VOIDED | QUOTATION | INVOICE  (v6)
ShiftStatus:   OPEN | CLOSED  (v6)
```

### Models Summary

| Model | Key Fields | Notes |
|-------|-----------|-------|
| User | id(UUIDv7), email?, username?, password?, pin?, name, role | Cashier uses username+PIN |
| Category | id, name, parent_id? | Self-referencing tree |
| Product | id, name, category_id | |
| Variant | id, product_id, sku, price, stock, has_open_price | The unit sold |
| StockBatch | id, variant_id, initial_qty, base_price, created_at | FIFO inventory costing |
| Transaction | id, user_id, status(OrderStatus), shift_id?, subtotal, tax_amount, service_charge_amount, total | v6 introduces status & consumer tax fields |
| TransactionItem | id, transaction_id, variant_id, qty, price, discount, cogs_total | FIFO COGS per line item |
| Payment | id, transaction_id, method, amount | Multiple per transaction |
| CashShift | id, user_id, opened_at, expected_cash, actual_cash, status | v6 register reconciliation |
| Expense | id, store_id, amount, category, description | v6 operational costs |
| OfflineQueue| id, payload(Json), synced_at?, error? | Manager danger zone |
| Setting | id="GLOBAL", store_info(Json), tax_config(Json), printer_config(Json) | Single row of JSON configs |

---

## 4. API Reference

Base URL: `http://localhost:3000` (dev) | `https://api.penguinwalk.my.id` (prod)

### Core Endpoints
- **Auth**: `POST /api/auth/login`, `GET /api/auth/me`
- **Products**: `GET /api/products`, `PATCH /api/products/variants/:id/stock` (FIFO logic triggers here)
- **Transactions**: `POST /api/transactions` (requires `status`, computes `tax_amount` if PKP config applies)
- **Settings**: `GET /api/settings`, `PATCH /api/settings`

### Business Operations (v6)
- **Shifts**: 
  - `POST /api/shifts/open`: Opens a cash register session.
  - `POST /api/shifts/:id/close`: Closes the shift, returning reconciliation (expected vs actual cash).
- **Expenses**:
  - `POST /api/expenses`: Logs an operational cost (with category).
  - `GET /api/expenses/summary`: Aggregates cost by category for a period.

### Reporting
- **Monthly Tax**: `GET /api/reports/monthly` returns YTD revenue, progress toward Rp 500M UMKM limit, auto-switch alerts (Rp 480M), and calculated tax liabilities.
- **E-Statement**: `GET /api/reports/e-statement` returns complete bank-style ledger of Sales (Revenue/COGS) AND Expenses.

---

## 5. Security & Multi-Tenant Design
- **Auth**: Bearer tokens via JWT. `requireRole(['ADMIN', 'MANAGER'])` middleware gates protected operations.
- **Multi-Branch Ready**: The `Expense` and `CashShift` models use a `store_id` field (defaulting to 'GLOBAL' currently) to prepare for future branch-specific clustering without massive schema changes.

---

## 6. Business Logic Rules

### 6.1 Indonesian Tax Localization Module
- **Tax Statuses**: 
  1. `FREE` (UMKM < Rp 500M)
  2. `PPH_FINAL` (Omzet > Rp 500M, 0.5% tax)
  3. `PKP` (Pengusaha Kena Pajak, requires collecting PPN)
- **Auto-Switch Engine**: System tracks Year-to-Date (YTD) subtotal revenue. If status is `FREE` and YTD hits **Rp 480,000,000**, the backend *automatically* updates settings to `PPH_FINAL` to prevent tax compliance violations.
- **Consumer Taxes**: Frontend computes `PPN` and `PB1` (Restaurant Tax) dynamically at checkout based on settings, passing them cleanly to backend and the receipt printer.

### 6.2 FIFO Inventory & Costing
- Restocking creates a new `StockBatch` with a `base_price`.
- Sales deduct stock strictly iterating from oldest batch `created_at ASC` to the newest.
- Each `TransactionItem` saves the total `cogs_total` deduced via the sequence, preserving exact historical profitability.

### 6.3 Offline Guardrails
- **Offline Writes Forbidden**: If the app loses connection, Inventory edits, Settings edits, and Admin interfaces are fully blocked (buttons disabled).
- **Offline Checkout Allowed**: Transactions process without network, save to IndexedDB, and synchronize retroactively with `$transaction` queue playback when online.
- **Safety**: Vouchers cannot be applied during offline transactions (to prevent race conditions for usage caps).

---

## 7. Frontend Architecture (React PWA)

- **Pages**: Layout driven with `react-router-dom`. Core pages: `LoginPage`, `CashierPage`, `InventoryPage`, `ReportsPage`, `SettingsPage`.
- **Cart & Checkout**: 
  - `CartBox.tsx`: Loads `tax_config` dynamically to update the order total with PPN/PB1/Service Charge.
  - `PaymentModal.tsx`: Displays final tax splits.
- **Reports Dashboard**: 
  - `TaxReportTab.tsx`: Dynamic visual progress bar toward Rp 500M limit. Green/Yellow/Red signaling depending on threshold warnings. Shows formal "SPT Masa" preview.
  - `EStatementTab.tsx`: CSV Export capability and color-coded unified ledger (Sales + Restocks + Expenses).
- **Settings**: Full receipt layout studio for printing ESC/POS testing and configuring taxes.
