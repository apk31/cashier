import { Router } from 'express'
import { getSettings, updateSettings } from '../controllers/settings.controller'
import { requireAuth, requireRole } from '../middlewares/auth.middleware'

const router = Router()

// Any logged-in user can read (PWA needs store_info for receipts & printer config)
router.get('/', requireAuth, getSettings)

// Only ADMIN can change store info, tax, or printer config
router.patch('/', requireAuth, requireRole(['ADMIN']), updateSettings)

export default router
