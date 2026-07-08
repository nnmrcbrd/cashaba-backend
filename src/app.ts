import express, { Application, Request, Response } from 'express';
// If you use cors, uncomment the line below after running: npm i cors @types/cors
// import cors from 'cors';

const app: Application = express();

// Middlewares
// app.use(cors()); // Uncomment if you need cross-origin requests
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

// API Routes
app.use('/api/auth', authRoutes);

import transactionRoutes from "./routes/transaction.routes.js";


app.use(express.json());

app.use("/api/transactions", transactionRoutes);

export default app;
