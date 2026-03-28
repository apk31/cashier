import { Response } from 'express'
import bcrypt from 'bcrypt'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { prisma } from '../lib/prisma'
import { AuthRequest } from '../middlewares/auth.middleware'

// ─── Validation schemas ───────────────────────────────────────────────────────

const createUserSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'MANAGER', 'CASHIER']),
  // Admin/Manager: email + password
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  // Cashier fast-login: username + PIN
  username: z.string().min(1).optional(),
  pin: z.string().min(4).max(6).optional(),
}).refine(
  (d) => (d.email && d.password) || (d.username && d.pin),
  { message: 'Provide either (email + password) or (username + pin)' }
)

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'MANAGER', 'CASHIER']).optional(),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),          // if provided, will be re-hashed
  username: z.string().min(1).nullable().optional(),
  pin: z.string().min(4).max(6).optional(),         // if provided, will be re-hashed
})

// ─── Controllers ──────────────────────────────────────────────────────────────

/** GET /api/users — ADMIN only: list all users (passwords/pins excluded) */
export const getUsers = async (_req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, username: true, role: true, created_at: true, updated_at: true },
      orderBy: { name: 'asc' },
    })
    return res.json(users)
  } catch (error) {
    console.error('[user.getAll]', error)
    return res.status(500).json({ error: 'Failed to fetch users' })
  }
}

/** POST /api/users — ADMIN only: create a new user */
export const createUser = async (req: AuthRequest, res: Response) => {
  const parsed = createUserSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid user payload', details: parsed.error.flatten() })
  }

  const { name, role, email, password, username, pin } = parsed.data

  try {
    const hashedPassword = password ? await bcrypt.hash(password, 12) : null
    const hashedPin = pin ? await bcrypt.hash(pin, 10) : null

    const user = await prisma.user.create({
      data: {
        id: uuidv7(),
        name,
        role,
        email: email ?? null,
        password: hashedPassword,
        username: username ?? null,
        pin: hashedPin,
      },
      select: { id: true, name: true, email: true, username: true, role: true, created_at: true },
    })
    return res.status(201).json(user)
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'Email or username already taken' })
    }
    console.error('[user.create]', error)
    return res.status(500).json({ error: 'Failed to create user' })
  }
}

/** PATCH /api/users/:id — ADMIN only: update user details */
export const updateUser = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id

  const parsed = updateUserSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() })
  }

  const { name, role, email, password, username, pin } = parsed.data

  try {
    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name
    if (role !== undefined) updateData.role = role
    if (email !== undefined) updateData.email = email
    if (username !== undefined) updateData.username = username
    if (password) updateData.password = await bcrypt.hash(password, 12)
    if (pin) updateData.pin = await bcrypt.hash(pin, 10)

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, email: true, username: true, role: true, updated_at: true },
    })
    return res.json(user)
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'User not found' })
    if (error.code === 'P2002') return res.status(409).json({ error: 'Email or username already taken' })
    console.error('[user.update]', error)
    return res.status(500).json({ error: 'Failed to update user' })
  }
}

/** DELETE /api/users/:id — ADMIN only: remove a user (cannot delete self) */
export const deleteUser = async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id

  if (req.user?.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account' })
  }

  try {
    await prisma.user.delete({ where: { id } })
    return res.status(204).send()
  } catch (error: any) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'User not found' })
    if (error.code === 'P2003') return res.status(409).json({ error: 'Cannot delete user with existing transactions' })
    console.error('[user.delete]', error)
    return res.status(500).json({ error: 'Failed to delete user' })
  }
}
