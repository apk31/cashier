import { Router } from 'express';
import { createExpense, getExpenses, getExpenseSummary, deleteExpense } from '../controllers/expense.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

const managerOrAdmin = requireRole(['MANAGER', 'ADMIN']);

// Any authenticated user can log and view expenses
router.post('/', requireAuth, createExpense);
router.get('/', requireAuth, getExpenses);
router.get('/summary', requireAuth, managerOrAdmin, getExpenseSummary);

// Only MANAGER/ADMIN can delete
router.delete('/:id', requireAuth, managerOrAdmin, deleteExpense);

export default router;
