import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { ENV } from "@/config/env";
import authRoutes from "./routes/auth.routes";
import userRoutes from './routes/user.routes';

const app = express();

// Middlewares
app.use(cors({
    origin: ENV.FRONTEND_URL,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Basic health check route
app.get("/health", (req, res) => {
    res.json({ status: "ok", appName: ENV.APP_NAME });
});

// Start server
app.listen(ENV.PORT, () => {
    console.log(`[server]: Server is running at http://localhost:${ENV.PORT}`);
});

app.use('/api/auth', authRoutes);

app.use('/api/user', userRoutes);