import { Router } from 'express';
import { createVoucher, getVoucherByCode, getVouchers } from '../controllers/voucher.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Only Managers and Admins can create promotional vouchers
router.post('/', requireAuth, requireRole(['MANAGER', 'ADMIN']), createVoucher);
router.get('/', requireAuth, getVouchers)
router.get('/:code', requireAuth, getVoucherByCode);
export default router;