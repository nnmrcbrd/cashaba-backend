import type { CookieOptions, Response } from 'express';

function refreshCookieOptions(): CookieOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  const domain = isProduction ? process.env.COOKIE_DOMAIN?.trim() : undefined;
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/api/auth',
    ...(domain ? { domain } : {}),
  };
}

export function setRefreshCookie(res: Response, token: string) {
  const options = refreshCookieOptions();
  if (options.domain) {
    const hostOnly = { ...options };
    delete hostOnly.domain;
    // Remove the previous API-host cookie before issuing a shared-domain cookie.
    res.clearCookie('refreshToken', hostOnly);
  }
  res.cookie('refreshToken', token, { ...options, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

export function clearRefreshCookie(res: Response) {
  const options = refreshCookieOptions();
  res.clearCookie('refreshToken', options);
  if (options.domain) {
    const hostOnly = { ...options };
    delete hostOnly.domain;
    res.clearCookie('refreshToken', hostOnly);
  }
}
