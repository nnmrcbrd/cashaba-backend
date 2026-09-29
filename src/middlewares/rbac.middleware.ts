import { Request, Response, NextFunction } from 'express';

export type AccountPermission = 'USER' | 'ADMIN';

/**
 * Authorize against the system account role only. `user.roles` contains
 * profile labels such as STUDENT and WORKING and must never grant access.
 */
export const authorize = (allowedRoles: readonly AccountPermission[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    if (!allowedRoles.includes(user.accountRole as AccountPermission)) {
      res.status(403).json({ message: 'You do not have permission to perform this action.' });
      return;
    }

    next();
  };
};
