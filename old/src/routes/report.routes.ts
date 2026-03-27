import { Router } from 'express';
import { getSalesSummary, getMonthlyReport, getPriceChangeLogs } from '../controllers/report.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

const managerOrAdmin = requireRole(['MANAGER', 'ADMIN']);

router.get('/summary', requireAuth, managerOrAdmin, getSalesSummary);
router.get('/monthly', requireAuth, managerOrAdmin, getMonthlyReport);
router.get('/price-logs', requireAuth, managerOrAdmin, getPriceChangeLogs);

export default router;
