import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { validateEnv } from './lib/env'


// Fail fast if env is misconfigured
validateEnv()
import offlineRoutes from './routes/offline.routes';
import memberRoutes from './routes/member.routes';
import voucherRoutes from './routes/voucher.routes';
import authRoutes from './routes/auth.routes'
import productRoutes from './routes/product.routes'
import categoryRoutes from './routes/category.routes'
import transactionRoutes from './routes/transaction.routes'
import reportRoutes from './routes/report.routes'
import inventoryRoutes from './routes/inventory.routes'
import settingsRoutes from './routes/settings.routes'
import userRoutes from './routes/user.routes'


const app = express()

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet())
// Parse allowed origins from comma-separated env string, defaulting to common dev and prod origins
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'https://pos.penguinwalk.my.id'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}))

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/categories', categoryRoutes)
app.use('/api/transactions', transactionRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/members', memberRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/offline', offlineRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/users', userRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' })
})

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled]', err)
  res.status(500).json({ error: 'Internal server error' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

export default app
