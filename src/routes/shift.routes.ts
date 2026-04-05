import { Router } from 'express';
import { openShift, closeShift, getCurrentShift, getShifts } from '../controllers/shift.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Any cashier/manager/admin can open and manage their own shift
router.post('/open', requireAuth, openShift);
router.post('/:id/close', requireAuth, closeShift);
router.get('/current', requireAuth, getCurrentShift);

// Shift history — MANAGER/ADMIN only
router.get('/', requireAuth, requireRole(['MANAGER', 'ADMIN']), getShifts);

export default router;
