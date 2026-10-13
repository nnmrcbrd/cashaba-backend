import type { Request, Response, NextFunction } from 'express';
import { isAllowedBrowserOrigin } from '../config/origins';
// Browser cookie mutations must be bound to a trusted app origin. CLI clients without
// Origin remain supported unless Fetch Metadata identifies a cross-site call.
export function protectCookieMutation(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('Origin');
  if ((origin && !isAllowedBrowserOrigin(origin)) || (!origin && req.get('Sec-Fetch-Site') === 'cross-site')) {
    res.status(403).json({ message: 'This session request must originate from Casha-Ba' });
    return;
  }
  next();
}
