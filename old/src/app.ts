import express from 'express';
import cors from 'cors';
import { login } from './controllers/auth.controller';
import { requireAuth, requireRole } from './middlewares/auth.middleware';
import { getCategories, createCategory } from './controllers/category.controller';
import { createProduct, getProducts } from './controllers/product.controller';
import { createTransaction } from './controllers/transaction.controller';
import { getDailyStats } from './controllers/report.controller';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Helps with standard form data

// Public Routes
app.post('/api/auth/login', login);

// Protected Routes Example
// Cashiers can process transactions
// app.post('/api/transactions', requireAuth, requireRole(['CASHIER', 'MANAGER', 'ADMIN']), (req, res) => {
//     res.json({ message: 'Transaction endpoint ready to be built!' });
// });
app.post('/api/transactions', requireAuth,requireRole(['CASHIER', 'MANAGER', 'ADMIN']), createTransaction);

// Only Managers and Admins can access reports
// app.get('/api/reports', requireAuth, requireRole(['MANAGER', 'ADMIN']), (req, res) => {
//     res.json({ message: 'Reports endpoint ready to be built!' });
// });
app.get('/api/reports/daily', requireAuth, requireRole(['ADMIN', 'MANAGER']), getDailyStats);

// Category Routes
app.get('/api/categories', getCategories);
app.post('/api/categories', requireAuth, requireRole(['ADMIN', 'MANAGER']), createCategory);

// Product Routes (to be implemented)
app.get('/api/products', getProducts);
app.post('/api/products', requireAuth, requireRole(['ADMIN', 'MANAGER']), createProduct);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});