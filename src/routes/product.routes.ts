import { Router } from 'express';
import {
  getProducts,
  getProductByBarcode,
  createProduct,
  updateProduct,
  updateVariantPrice,
  updateVariantStock,
  deleteProduct,
  exportProductsBulk,
  applyProductsBulk,
} from '../controllers/product.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// ── Static / specific paths FIRST (must be before /:id) ────────────────────
router.get('/barcode/:code', requireAuth, getProductByBarcode);

// Bulk operations — MUST come before /:id to avoid "bulk" being captured as an id param
router.get('/bulk/export', requireAuth, requireRole(['ADMIN', 'MANAGER']), exportProductsBulk);
router.post('/bulk/apply', requireAuth, requireRole(['ADMIN', 'MANAGER']), applyProductsBulk);

// ── Collection routes ────────────────────────────────────────────────────────
router.get('/', requireAuth, getProducts);
router.post('/', requireAuth, requireRole(['ADMIN', 'MANAGER']), createProduct);

// ── Dynamic param routes ─────────────────────────────────────────────────────
router.patch('/variants/:id/price', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateVariantPrice);
router.patch('/variants/:id/stock', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateVariantStock);
router.patch('/:id', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateProduct);
router.delete('/:id', requireAuth, requireRole(['ADMIN']), deleteProduct);

export default router;
