import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

const app: Application = express();

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
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
app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', database: 'Prisma ready (not yet tested)' });
});

import authRoutes from './routes/auth.routes.js';
import transactionRoutes from "./routes/transaction.routes.js";
import userRoutes from "./routes/user.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import budgetRoutes from "./routes/budget.routes.js";
import loanRoutes from "./routes/loan.routes.js";
import incomeSetupRoutes from "./routes/incomeSetup.routes.js";

// Premium feature routes
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

// Premium feature routes
app.use("/api/ai/insights", insightsRoutes);
app.use("/api/user", healthScoreRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/transactions", recurringRoutes);
app.use("/api/wallets", walletRoutes);

// GCash scan-image (inline route — no separate file needed)
import { scanGCashImage } from "./controllers/gcashScan.controller.js";
import { authenticate as _auth } from "./middlewares/auth.middleware.js";
app.post("/api/gcash/scan-image", _auth, scanGCashImage);

export default app;
