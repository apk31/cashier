import { Router } from 'express';
import { getSalesSummary, getMonthlyReport, getPriceChangeLogs, getLowStockAlerts, getEStatement } from '../controllers/report.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

const managerOrAdmin = requireRole(['MANAGER', 'ADMIN']);

router.get('/summary', requireAuth, managerOrAdmin, getSalesSummary);
router.get('/monthly', requireAuth, managerOrAdmin, getMonthlyReport);
router.get('/price-logs', requireAuth, managerOrAdmin, getPriceChangeLogs);
router.get('/low-stock', requireAuth, managerOrAdmin, getLowStockAlerts);
router.get('/e-statement', requireAuth, managerOrAdmin, getEStatement);

export default router;
