import { Request, Response, NextFunction } from 'express';

// Ensure the Request interface is extended to include user
// (This is the same logic as your auth middleware)
export const authorize = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Get the user from the request (attached by your auth middleware)
    const user = (req as any).user;

    // 1. Ensure user has roles
    if (!user || !user.roles || !Array.isArray(user.roles)) {
      res.status(403).json({ message: 'Forbidden: No roles assigned.' });
      return;
    }

    const hasPermission = user.roles.some((role: string) => allowedRoles.includes(role));
    
    if (!hasPermission) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    // 2. Check if user exists and has a role
    if (!user || !user.accountRole) {
      res.status(403).json({ message: 'Forbidden: No role assigned.' });
      return;
    }

    // 3. Check if user's role is in the allowedRoles array
    if (!allowedRoles.includes(user.accountRole)) {
      res.status(403).json({ 
        message: `Forbidden: Access requires one of the following roles: ${allowedRoles.join(', ')}` 
      });
      return;
    }

    // 4. Role is valid, proceed to controller
    next();
  };
};