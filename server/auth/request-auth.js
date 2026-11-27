import jwt from 'jsonwebtoken';
import { verifyToken } from './token.js';

export const SESSION_COOKIE_NAME = 'yeaft_session';

function readBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice('Bearer '.length).trim();
  return token || null;
}

function readCookieToken(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve one authenticated browser session for HTTP and WebSocket requests.
 * Explicit bearer/query tokens remain the compatibility path; a valid
 * HttpOnly cookie is the browser fallback when that token is absent or stale.
 */
export function authenticateRequest({ authorizationHeader, cookieHeader, queryToken } = {}, { fullSession = false } = {}) {
  const candidates = [
    ['bearer', readBearerToken(authorizationHeader)],
    ['query', typeof queryToken === 'string' && queryToken ? queryToken : null],
    ['cookie', readCookieToken(cookieHeader)],
  ];
  const seen = new Set();
  for (const [source, token] of candidates) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    const result = verifyToken(token);
    if (result.valid) return fullSession && result.type ? null : { ...result, token, source };
  }
  return null;
}

function requestIsSecure(req) {
  if (req?.secure) return true;
  const forwardedProto = req?.headers?.['x-forwarded-proto'];
  return typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim() === 'https';
}

function sessionCookieOptions(req, token) {
  const decoded = token ? jwt.decode(token) : null;
  const remainingMs = decoded?.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : undefined;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: requestIsSecure(req),
    path: '/',
    ...(remainingMs !== undefined && { maxAge: remainingMs }),
  };
}

export function setSessionCookie(req, res, token) {
  if (!token || typeof res?.cookie !== 'function') return;
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(req, token));
}

export function clearSessionCookie(req, res) {
  if (typeof res?.clearCookie !== 'function') return;
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: requestIsSecure(req),
    path: '/',
  });
}
