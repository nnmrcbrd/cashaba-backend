import { Request, Response, NextFunction } from 'express';

// Ensure the Request interface is extended to include user
// (This is the same logic as your auth middleware)
export const authorize = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(403).json({ message: 'Forbidden: No role assigned.' });
      return;
    }

    const assignedRoles = [
      typeof user.accountRole === 'string' ? user.accountRole : null,
      ...(Array.isArray(user.roles) ? user.roles : []),
    ].filter((role): role is string => Boolean(role));

    if (!assignedRoles.some((role) => allowedRoles.includes(role))) {
      res.status(403).json({ 
        message: `Forbidden: Access requires one of the following roles: ${allowedRoles.join(', ')}` 
      });
      return;
    }

    next();
  };
};
