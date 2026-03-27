import { Request, Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';

const memberSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8).max(15)
});

export const createMember = async (req: Request, res: Response) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { name, phone } = parsed.data;

  try {
    const member = await prisma.member.create({
      data: { id: uuidv7(), name, phone }
    });
    return res.status(201).json(member);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Phone number already registered' });
    return res.status(500).json({ error: 'Failed to create member' });
  }
};

export const getMembers = async (req: Request, res: Response) => {
  const { q, page = '1', limit = '50' } = req.query as Record<string, string>;
  const take = Math.min(parseInt(limit) || 50, 200);
  const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

  try {
    const where = q ? {
      OR: [
        { name: { contains: q, mode: 'insensitive' as const } },
        { phone: { contains: q } }
      ]
    } : {};

    const [members, total] = await Promise.all([
      prisma.member.findMany({ where, orderBy: { points: 'desc' }, take, skip }),
      prisma.member.count({ where })
    ]);

    return res.json({ data: members, total, page: parseInt(page), limit: take });
  } catch (error) {
    console.error('[member.getAll]', error);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }
};

export const getMemberByPhone = async (req: Request, res: Response) => {
  try {
    const phone = Array.isArray(req.params.phone) ? req.params.phone[0] : req.params.phone;
    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    return res.json(member);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};