import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Extend the Request interface so TypeScript knows about 'user'
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Access denied. No token provided.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const jwtSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || 'no-jwt-key';
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded; // Attach user info to the request object
    next(); // Pass control to the next function
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};