const cashaBaOrigins = [
  'https://www.casha-ba.online',
  'https://casha-ba.online',
  'https://api.casha-ba.online',
];

function configuredOrigin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error(`${name} must contain valid HTTP(S) origins`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must contain HTTP(S) origins without credentials, paths, queries or fragments`);
  }
  return url.origin;
}

export function isAllowedBrowserOrigin(origin: string): boolean {
  const allowed = new Set(cashaBaOrigins);
  const frontend = process.env.FRONTEND_URL?.trim()
    || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
  if (frontend) allowed.add(configuredOrigin(frontend, 'FRONTEND_URL'));
  for (const extra of (process.env.CORS_ALLOWED_ORIGINS || '').split(',')) {
    if (extra.trim()) allowed.add(configuredOrigin(extra, 'CORS_ALLOWED_ORIGINS'));
  }
  // Compare complete serialized browser origins, never substrings or suffixes.
  return allowed.has(origin);
}
