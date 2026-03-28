import { format } from 'date-fns';
import { Decimal } from '@prisma/client/runtime/library';

const LINE_WIDTH = 32;

// Add this interface to define the store data shape
export interface StoreInfo {
  name?: string;
  address?: string;
  phone?: string;
  footer?: string;
}

const formatRp = (amount: number | Decimal | undefined): string => {
  if (amount === undefined) return 'Rp 0';
  const num = amount instanceof Decimal ? amount.toNumber() : amount;
  return `Rp ${num.toLocaleString('id-ID')}`;
};

const center = (text: string): string => {
  if (text.length >= LINE_WIDTH) return text.substring(0, LINE_WIDTH);
  const leftPad = Math.floor((LINE_WIDTH - text.length) / 2);
  return ' '.repeat(leftPad) + text;
};

const right = (text: string): string => {
  if (text.length >= LINE_WIDTH) return text.substring(0, LINE_WIDTH);
  return ' '.repeat(LINE_WIDTH - text.length) + text;
};

const justify = (left: string, rightStr: string): string => {
  const dotsCount = LINE_WIDTH - (left.length + rightStr.length);
  if (dotsCount < 0) return `${left.substring(0, LINE_WIDTH / 2)}... ${rightStr}`;
  return `${left}${'.'.repeat(dotsCount)}${rightStr}`;
};

const separator = (char = '-') => char.repeat(LINE_WIDTH);

// Update signature to accept storeInfo
export const generateReceiptString = (transaction: any, storeInfo: StoreInfo = {}): string => {
  const lines: string[] = [];

  // Use dynamic store info or fallbacks
  lines.push(center(storeInfo.name || 'STORE NAME'));
  if (storeInfo.address) lines.push(center(storeInfo.address));
  if (storeInfo.phone) lines.push(center(storeInfo.phone));
  lines.push(separator());
  lines.push('');

  lines.push(`Trx: #${transaction.id.substring(0, 8).toUpperCase()}`);
  lines.push(`Date: ${format(transaction.created_at, 'dd/MM/yyyy HH:mm')}`);
  lines.push(`Cashier: ${transaction.user?.name || 'Unknown'}`);
  lines.push(separator());
  lines.push('');

  lines.push('ITEMS / QTY / PRICE');
  lines.push(separator());

  transaction.items.forEach((item: any) => {
    const productName = item.variant?.product?.name || 'Unknown Item';
    const lineTotal = formatRp(Number(item.price) * item.qty);
    lines.push(justify(productName, lineTotal));
    lines.push(`  (${item.qty} @ ${formatRp(item.price)})`);
    if (item.discount > 0) lines.push(right(`Item Disc: -${formatRp(item.discount)}`));
  });

  lines.push('');
  lines.push(separator());
  lines.push('');

  if (Number(transaction.discount_total) > 0) {
    lines.push(justify('SUBTOTAL', formatRp(transaction.subtotal)));
    lines.push(justify('VOUCHER', `-${formatRp(transaction.discount_total)}`));
  }
  
  lines.push(justify('TOTAL', formatRp(transaction.total)));
  lines.push('');
  lines.push(separator());
  lines.push('');

  transaction.payments.forEach((payment: any) => {
    lines.push(justify(`PAID (${payment.method})`, formatRp(payment.amount)));
  });

  const amountPaid = transaction.payments.reduce((s: number, p: any) => s + Number(p.amount), 0);
  const change = Math.max(0, amountPaid - Number(transaction.total));
  lines.push(justify('CHANGE', formatRp(change)));
  lines.push('');
  lines.push(separator());
  lines.push('');

  if (transaction.member) {
    lines.push(center(`Member: ${transaction.member.name}`));
    lines.push(center(`Member Phone: ${transaction.member.phone}`));
    lines.push(separator());
    lines.push('');
  }

  // Use dynamic footer
  lines.push(center(storeInfo.footer || 'Thank You for Visiting!'));
  lines.push('');
  lines.push('');
  lines.push('');

  return lines.join('\n');
};