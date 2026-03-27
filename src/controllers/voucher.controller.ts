import { Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';

export const createVoucher = async (req: Request, res: Response) => {
  const { code, type, value, max_uses, exp_days } = req.body;
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + (exp_days || 30)); // Default expires in 30 days

  try {
    const voucher = await prisma.voucher.create({
      data: {
        id: uuidv7(),
        code: code.toUpperCase(),
        type, // 'FIXED' or 'PERCENTAGE'
        value,
        max_uses: max_uses || 1,
        exp: expDate
      }
    });
    res.status(201).json(voucher);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Voucher code already exists' });
    res.status(500).json({ error: 'Failed to create voucher' });
  }
};