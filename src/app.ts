import express, { Application, Request, Response } from 'express';
import cors from 'cors';

const app: Application = express();

// Middlewares
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

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

// API Routes
app.use('/api/auth', authRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/users", userRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/budget", budgetRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/income-setup", incomeSetupRoutes);

export default app;
