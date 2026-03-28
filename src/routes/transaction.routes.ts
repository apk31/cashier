import { Router } from 'express';
import { createTransaction, getTransaction, getTransactions } from '../controllers/transaction.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', requireAuth, requireRole(['CASHIER', 'MANAGER', 'ADMIN']), createTransaction);
router.get('/', requireAuth, requireRole(['CASHIER', 'MANAGER', 'ADMIN']), getTransactions);
router.get('/:id', requireAuth, requireRole(['CASHIER', 'MANAGER', 'ADMIN']), getTransaction);

export default router;
