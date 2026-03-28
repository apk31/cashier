import { Router } from 'express'
import { getUsers, createUser, updateUser, deleteUser } from '../controllers/user.controller'
import { requireAuth, requireRole } from '../middlewares/auth.middleware'

const router = Router()

// All user management routes are ADMIN-only
const adminOnly = requireRole(['ADMIN'])

router.get('/', requireAuth, adminOnly, getUsers)
router.post('/', requireAuth, adminOnly, createUser)
router.patch('/:id', requireAuth, adminOnly, updateUser)
router.delete('/:id', requireAuth, adminOnly, deleteUser)

export default router
