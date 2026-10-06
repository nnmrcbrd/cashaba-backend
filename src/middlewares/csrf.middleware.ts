import type { Request, Response, NextFunction } from 'express';
// Browser cookie mutations must be bound to our frontend. CLI clients without
// Origin remain supported unless Fetch Metadata identifies a cross-site call.
export function protectCookieMutation(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('Origin');
  const expected = new URL(process.env.FRONTEND_URL || 'http://localhost:3000').origin;
  if ((origin && origin !== expected) || (!origin && req.get('Sec-Fetch-Site') === 'cross-site')) {
    res.status(403).json({ message: 'This session request must originate from Casha-Ba' });
    return;
  }
  next();
}
