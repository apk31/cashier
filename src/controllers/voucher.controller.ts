import { Request, Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { prisma } from '../lib/prisma';
import { VoucherType } from '@prisma/client';

const voucherSchema = z.object({
  code: z.string().min(1),
  type: z.nativeEnum(VoucherType),
  value: z.number().positive(),
  max_uses: z.number().int().min(1).default(1),
  exp_days: z.number().int().min(1).default(30)
});

export const createVoucher = async (req: Request, res: Response) => {
  const parsed = voucherSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
  }

  const { code, type, value, max_uses, exp_days } = parsed.data;
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + exp_days);

  try {
    const voucher = await prisma.voucher.create({
      data: {
        id: uuidv7(),
        code: code.toUpperCase(),
        type,
        value,
        max_uses,
        exp: expDate
      }
    });
    return res.status(201).json(voucher);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Voucher code already exists' });
    return res.status(500).json({ error: 'Failed to create voucher' });
  }
};

export const getVouchers = async (req: Request, res: Response) => {
  try {
    const vouchers = await prisma.voucher.findMany({ orderBy: { exp: 'desc' } });
    return res.json(vouchers);
  } catch (error) {
    console.error('[voucher.getAll]', error);
    return res.status(500).json({ error: 'Failed to fetch vouchers' });
  }
};

export const getVoucherByCode = async (req: Request, res: Response) => {
  try {
    const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
    const voucher = await prisma.voucher.findUnique({ where: { code: code.toUpperCase() } });
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    return res.json(voucher);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};