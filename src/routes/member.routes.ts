import { Router } from 'express';
import { createMember, getMembers } from '../controllers/member.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// Anyone logged in can view members (to attach them to a sale)
router.get('/', requireAuth, getMembers);

// Cashiers, Managers, and Admins can register new members
router.post('/', requireAuth, requireRole(['CASHIER', 'MANAGER', 'ADMIN']), createMember);

export default router;