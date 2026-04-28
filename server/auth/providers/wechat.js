/**
 * WeChat Open Platform — PC web 扫码 (qrconnect) flow.
 *
 * Authorize URL: https://open.weixin.qq.com/connect/qrconnect
 * Token URL:     https://api.weixin.qq.com/sns/oauth2/access_token
 * UserInfo URL:  https://api.weixin.qq.com/sns/userinfo
 *
 * `subject` is `unionid` if available (stable across an open-platform account
 * suite), otherwise `openid`. Note: WeChat's `state` round-trips back as a
 * regular query param, same as standard OAuth2.
 */
import { CONFIG } from '../../config.js';

export const name = 'wechat';

export function isEnabled() {
  const c = CONFIG.sso?.wechat;
  return !!(c?.enabled && c.appId && c.appSecret && c.callbackUrl);
}

export function getAuthorizeUrl(state /* , intent */) {
  const c = CONFIG.sso.wechat;
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect');
  url.searchParams.set('appid', c.appId);
  url.searchParams.set('redirect_uri', c.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'snsapi_login');
  url.searchParams.set('state', state);
  // WeChat requires the fragment '#wechat_redirect' literally appended.
  return `${url.toString()}#wechat_redirect`;
}

export async function exchangeCode(code /* , state */) {
  const c = CONFIG.sso.wechat;
  const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  tokenUrl.searchParams.set('appid', c.appId);
  tokenUrl.searchParams.set('secret', c.appSecret);
  tokenUrl.searchParams.set('code', code);
  tokenUrl.searchParams.set('grant_type', 'authorization_code');

  const tokRes = await fetch(tokenUrl.toString());
  if (!tokRes.ok) throw new Error(`WeChat token exchange failed: ${tokRes.status}`);
  const tok = await tokRes.json();
  if (tok.errcode) throw new Error(`WeChat token error ${tok.errcode}: ${tok.errmsg || ''}`);
  if (!tok.access_token || !tok.openid) throw new Error('WeChat token response missing access_token/openid');

  // Step 2: pull profile (returns nickname, headimgurl, unionid if linked)
  const userUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
  userUrl.searchParams.set('access_token', tok.access_token);
  userUrl.searchParams.set('openid', tok.openid);
  userUrl.searchParams.set('lang', 'zh_CN');
  const userRes = await fetch(userUrl.toString());
  if (!userRes.ok) throw new Error(`WeChat /userinfo failed: ${userRes.status}`);
  const profile = await userRes.json();
  if (profile.errcode) throw new Error(`WeChat /userinfo error ${profile.errcode}: ${profile.errmsg || ''}`);

  const subject = profile.unionid || profile.openid || tok.unionid || tok.openid;
  if (!subject) throw new Error('WeChat profile missing unionid/openid');

  return {
    subject,
    email: null, // WeChat does not provide email
    displayName: profile.nickname || null,
    raw: profile
  };
}

export default { name, isEnabled, getAuthorizeUrl, exchangeCode };
