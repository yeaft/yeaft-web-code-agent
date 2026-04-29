/**
 * Email-based password reset.
 *
 * Two-step flow:
 *   1) POST /api/auth/password-reset/request  { email }
 *      → server looks up user by email; if found, mints a 6-digit code,
 *        stashes it in memory keyed by a random opaque resetToken, and emails
 *        the code. Always responds 200 even if email isn't on file (prevents
 *        account enumeration). 15-minute TTL.
 *   2) POST /api/auth/password-reset/verify   { resetToken, code, newPassword }
 *      → validates code, replaces password_hash, returns success.
 *
 * Uses the same SMTP infra as login email verification.
 */
import { randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { CONFIG, isEmailConfigured } from '../config.js';
import { userDb } from '../database.js';
import { sendVerificationCode } from '../email.js';
import { hashPassword } from './utils.js';

const RESET_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const _pending = new Map(); // resetToken -> { userId, code, expiresAt, attempts }

function _gc() {
  const now = Date.now();
  for (const [t, e] of _pending.entries()) if (e.expiresAt < now) _pending.delete(t);
}

function _generateCode() {
  // CSPRNG. Math.random() is unsuitable for security tokens — predictable
  // across attackers who can sample the server's PRNG state.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function _constantTimeCodeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Step 1: request a reset code.
 * Always returns { success: true } regardless of whether the email exists,
 * so an attacker can't enumerate accounts. Returns the resetToken on success
 * (or always — same shape — for the user who actually owns the email).
 */
export async function requestPasswordReset(email) {
  _gc();
  if (!isEmailConfigured()) {
    return { success: false, error: 'Email is not configured on this server' };
  }
  if (!email || typeof email !== 'string') {
    return { success: false, error: 'Email is required' };
  }
  const normalized = email.trim().toLowerCase();

  // Look up user by email. We scan getAll() because there's no index — this is
  // an admin-rare action so the cost is acceptable.
  const all = userDb.getAll();
  const user = all.find(u => (u.email || '').toLowerCase() === normalized);

  if (!user) {
    // Pretend success to prevent enumeration. No code sent, no token issued.
    // The client gets a fake-looking token so the UI can still proceed to
    // the "enter code" step — verification will simply fail.
    //
    // Sleep a small randomized window so the response time roughly matches
    // the existing-email path (which awaits an SMTP round-trip). Without
    // this, request latency is itself an enumeration oracle.
    const fakeDelay = 200 + Math.floor(Math.random() * 400);
    await new Promise(r => setTimeout(r, fakeDelay));
    return { success: true, resetToken: 'fake_' + randomBytes(16).toString('hex') };
  }

  const code = _generateCode();
  const resetToken = 'rst_' + randomBytes(24).toString('hex');
  _pending.set(resetToken, {
    userId: user.id,
    code,
    expiresAt: Date.now() + RESET_TTL_MS,
    attempts: 0
  });
  try {
    await sendVerificationCode(user.email, code, user.username);
  } catch (err) {
    console.error('[password-reset] sendVerificationCode failed:', err.message);
    _pending.delete(resetToken);
    return { success: false, error: 'Failed to send reset email' };
  }
  return { success: true, resetToken };
}

/**
 * Step 2: verify code and set new password.
 *
 * Per-token attempt counter caps brute-force at MAX_ATTEMPTS regardless of
 * IP rotation — the IP rate-limit alone is bypassable via residential
 * proxies.
 */
export async function verifyPasswordReset(resetToken, code, newPassword) {
  _gc();
  const entry = _pending.get(resetToken);
  if (!entry) return { success: false, error: 'Invalid or expired reset token' };
  if (Date.now() > entry.expiresAt) {
    _pending.delete(resetToken);
    return { success: false, error: 'Reset code has expired' };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    _pending.delete(resetToken);
    return { success: false, error: 'Too many attempts; request a new reset code' };
  }
  if (!_constantTimeCodeEqual(entry.code, code || '')) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS) _pending.delete(resetToken);
    return { success: false, error: 'Invalid reset code' };
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters' };
  }
  const user = userDb.get(entry.userId);
  if (!user) {
    _pending.delete(resetToken);
    return { success: false, error: 'User no longer exists' };
  }
  const hash = await hashPassword(newPassword);
  userDb.updatePassword(user.id, hash);
  _pending.delete(resetToken);
  return { success: true };
}

// Test-only
export function _resetPasswordResetStore() { _pending.clear(); }
