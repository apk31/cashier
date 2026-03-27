import { Router } from 'express';
import { createVoucher } from '../controllers/voucher.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Only Managers and Admins can create promotional vouchers
router.post('/', requireAuth, requireRole(['MANAGER', 'ADMIN']), createVoucher);

export default router;