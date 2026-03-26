import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export const login = async (req: Request, res: Response) => {

  if (!req.body) {
    return res.status(400).json({ error: 'Request body is missing' });
  }

  const { email, password, pin } = req.body;

  try {
    let user;

    // SCENARIO 1: Cashier Fast Login via PIN
    if (pin) {
      // In a real app, you might scope PIN login to a specific terminal/store ID 
      // or require a username alongside the PIN to prevent PIN collisions.
      const usersWithPins = await prisma.user.findMany({
        where: { role: 'CASHIER', pin: { not: null } }
      });

      for (const u of usersWithPins) {
        if (await bcrypt.compare(pin, u.pin!)) {
          user = u;
          break;
        }
      }
    } 
    // SCENARIO 2: Admin/Manager Login via Email & Password
    else if (email && password) {
      user = await prisma.user.findUnique({ where: { email } });
      if (user && user.password) {
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) user = null;
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' } // 12-hour shift duration
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, role: user.role }
    });

  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
};