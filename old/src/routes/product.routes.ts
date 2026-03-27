import { Router } from 'express';
import {
  getProducts,
  getProductByBarcode,
  createProduct,
  updateProduct,
  updateVariantPrice,
  updateVariantStock,
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

export default router;
