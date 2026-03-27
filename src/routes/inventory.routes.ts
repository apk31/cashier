import { Router } from 'express'
import { getStockHistory } from '../controllers/inventory.controller'
import { requireAuth, requireRole } from '../middlewares/auth.middleware'

const router = Router()

// Stock movement history — Manager and Admin only
router.get('/stock-history', requireAuth, requireRole(['ADMIN', 'MANAGER']), getStockHistory)

export default router
