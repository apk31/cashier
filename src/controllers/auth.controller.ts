import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '12h';

// ─── Validation schemas ───────────────────────────────────────────────────────

const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const pinLoginSchema = z.object({
  username: z.string().min(1),
  pin: z.string().min(4).max(6),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const login = async (req: Request, res: Response) => {
  const { email, password, username, pin } = req.body ?? {};

  try {
    let user: { id: string; name: string; role: string; password: string | null; pin: string | null } | null = null;

    // SCENARIO 1: Cashier fast-login via username + PIN (single DB lookup — no loop)
    if (username && pin) {
      const parsed = pinLoginSchema.safeParse({ username, pin });
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid PIN login payload', details: parsed.error.flatten() });
      }

      const found = await prisma.user.findUnique({
        where: { username },
        select: { id: true, name: true, role: true, password: true, pin: true },
      });

      if (found?.pin && (await bcrypt.compare(pin, found.pin))) {
        user = found;
      }
    }

    // SCENARIO 2: Admin / Manager login via email + password
    else if (email && password) {
      const parsed = emailLoginSchema.safeParse({ email, password });
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid login payload', details: parsed.error.flatten() });
      }

      const found = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, role: true, password: true, pin: true },
      });

      if (found?.password && (await bcrypt.compare(password, found.password))) {
        user = found;
      }
    } else {
      return res.status(400).json({ error: 'Provide either (email + password) or (username + pin)' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Cast the secret to string and ensure the value is treated as a SignOptions value
const token = jwt.sign(
  { id: user.id, role: user.role }, 
  JWT_SECRET as string, 
  { expiresIn: JWT_EXPIRES as any } 
);

    return res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role },
    });
  } catch (error) {
    console.error('[auth.login]', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
