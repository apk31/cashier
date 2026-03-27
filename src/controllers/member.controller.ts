import { Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';

export const createMember = async (req: Request, res: Response) => {
  const { name, phone } = req.body;
  try {
    const member = await prisma.member.create({
      data: { id: uuidv7(), name, phone }
    });
    res.status(201).json(member);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Phone number already registered' });
    res.status(500).json({ error: 'Failed to create member' });
  }
};

export const getMembers = async (req: Request, res: Response) => {
  const members = await prisma.member.findMany({ orderBy: { points: 'desc' } });
  res.json(members);
};
export const getMemberByPhone = async (req: Request, res: Response) => {
    const phone = Array.isArray(req.params.phone) ? req.params.phone[0] : req.params.phone;

  try {
    const member = await prisma.member.findUnique({
      where: { phone }
    });

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    return res.json(member);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};