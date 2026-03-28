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

// Public reads (cashier still needs auth for checkout — protected at checkout level)
router.get('/', requireAuth, getProducts);
router.get('/barcode/:code', requireAuth, getProductByBarcode);

// Write — Manager / Admin only
router.post('/', requireAuth, requireRole(['ADMIN', 'MANAGER']), createProduct);
router.patch('/:id', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateProduct);
router.patch('/variants/:id/price', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateVariantPrice);
router.patch('/variants/:id/stock', requireAuth, requireRole(['ADMIN', 'MANAGER']), updateVariantStock);

// Delete — Admin only (prevents accidental deletion by managers)
router.delete('/:id', requireAuth, requireRole(['ADMIN']), deleteProduct);

// Bulk Operations
router.get('/bulk/export', requireAuth, requireRole(['ADMIN', 'MANAGER']), exportProductsBulk);
router.post('/bulk/apply', requireAuth, requireRole(['ADMIN', 'MANAGER']), applyProductsBulk);

export default router;

