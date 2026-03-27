import { Router } from 'express';
import { getCategories, createCategory, deleteCategory } from '../controllers/category.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.get('/', requireAuth, getCategories);
router.post('/', requireAuth, requireRole(['ADMIN', 'MANAGER']), createCategory);
router.delete('/:id', requireAuth, requireRole(['ADMIN']), deleteCategory);

export default router;
