import { Router } from 'express';
import { 
  syncTransactions, 
  getOfflineQueue, 
  discardQueueItem, 
  retryQueueItem 
} from '../controllers/offline.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// ─── Cashier / System Routes ──────────────────────────────────────────
// The frontend calls this silently in the background when internet returns
router.post('/sync', requireAuth, syncTransactions);

// ─── Manager / Admin Routes ───────────────────────────────────────────
const managerOrAdmin = requireRole(['MANAGER', 'ADMIN']);

// View the Danger Zone queue
router.get('/queue', requireAuth, managerOrAdmin, getOfflineQueue);

// Attempt to push a failed transaction through again
router.post('/queue/:id/retry', requireAuth, managerOrAdmin, retryQueueItem);

// Delete a totally corrupted or invalid transaction
router.delete('/queue/:id', requireAuth, managerOrAdmin, discardQueueItem);

export default router;