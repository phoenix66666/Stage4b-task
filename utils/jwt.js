/**
 * utils/jwt.js — JWT client utilities
 * Server signs/verifies; we only parse for UX.
 */

export function parseJWT(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function getTokenField(token, field) {
  return parseJWT(token)?.[field] ?? null;
}

export function isTokenExpired(token) {
  const payload = parseJWT(token);
  if (!payload?.exp) return true;
  return Date.now() >= payload.exp * 1000;
}

/** True if token expires in less than `marginSeconds` (default 60s). */
export function isTokenExpiringSoon(token, marginSeconds = 60) {
  const payload = parseJWT(token);
  if (!payload?.exp) return true;
  return Date.now() >= (payload.exp - marginSeconds) * 1000;
}

export function secondsUntilExpiry(token) {
  const payload = parseJWT(token);
  if (!payload?.exp) return -1;
  return Math.floor(payload.exp - Date.now() / 1000);
}
