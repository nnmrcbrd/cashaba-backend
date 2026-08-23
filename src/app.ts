import express, { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { prisma } from './lib/prisma.js';

const app: Application = express();

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Base Test Route
app.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'success',
    message: 'Backend is up and running smoothly!',
    timestamp: new Date().toISOString()
  });
});

// A quick health-check route
app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'OK', database: 'connected' });
  } catch (error) {
    console.error('Health check database error:', error);
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

import authRoutes from './routes/auth.routes.js';
import transactionRoutes from "./routes/transaction.routes.js";
import userRoutes from "./routes/user.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import budgetRoutes from "./routes/budget.routes.js";
import loanRoutes from "./routes/loan.routes.js";
import incomeSetupRoutes from "./routes/incomeSetup.routes.js";

// Financial intelligence and account routes
import insightsRoutes from "./routes/insights.routes.js";
import healthScoreRoutes from "./routes/healthScore.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import recurringRoutes from "./routes/recurring.routes.js";
import walletRoutes from "./routes/wallet.routes.js";

// API Routes
app.use('/api/auth', authRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/users", userRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/budget", budgetRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/income-setup", incomeSetupRoutes);

// Financial intelligence and account routes
app.use("/api/ai/insights", insightsRoutes);
app.use("/api/user", healthScoreRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/transactions", recurringRoutes);
app.use("/api/wallets", walletRoutes);

// GCash scan-image (inline route — no separate file needed)
import { scanGCashImage } from "./controllers/gcashScan.controller.js";
import { authenticate as _auth } from "./middlewares/auth.middleware.js";
app.post("/api/gcash/scan-image", _auth, scanGCashImage);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  if ('code' in error && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ message: 'Uploaded file must be 2 MB or smaller' });
    return;
  }
  console.error('Unhandled request error:', error);
  res.status(500).json({ message: 'Internal server error' });
});

export default app;
