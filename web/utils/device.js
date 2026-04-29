/**
 * Lightweight device / in-app browser detection.
 *
 * We only need this to pick the right SSO flow (QR vs redirect) for
 * providers whose QR-scan login can't work on the same device. Used by
 * `stores/auth.js` and `components/LoginPage.js`.
 *
 * UA sniffing is a known-imperfect signal — we accept that. The fallback
 * (showing the QR) is harmless on a device that can't actually use it
 * because we already render manual provider buttons next to it.
 */

function _ua() {
  if (typeof navigator === 'undefined' || !navigator) return '';
  return navigator.userAgent || '';
}

/**
 * True for phones / tablets where scanning a QR code displayed on the same
 * screen is impossible. Conservative: tablets count as mobile because the
 * camera-on-the-same-device problem still applies.
 */
export function isMobile() {
  const ua = _ua();
  return /Android|iPhone|iPad|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(ua);
}

/**
 * True if the page is running inside the WeChat in-app browser.
 * (Currently informational only — wechat in-app OAuth requires a separate
 * appid we don't yet ship; see CLAUDE.md.)
 */
export function isInWeChat() {
  return /MicroMessenger/i.test(_ua());
}

/**
 * True if the page is running inside the Alipay in-app browser. In this
 * case the H5 authorize URL natively binds to the running Alipay session,
 * so we should still use the redirect flow (not QR).
 */
export function isInAlipay() {
  return /AlipayClient/i.test(_ua());
}
