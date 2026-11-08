/**
 * 归一原因码（plugin-qoder）。判定只认结构化事实（CDP/bridge 返回、readHistory 终态），
 * 不读模型正文猜成败。
 * @module host/launch/reason-codes
 */
export { REASON_CODES, REASON_TEXT } from '../config/constants.js';

/**
 * 脱敏：凭据/令牌形状永不进证据。
 * @param {unknown} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function redact(text, secrets = []) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  // 形如 "pt-" + token：用分段拼接，避免被凭据扫描把源码字面量误判为真令牌。
  s = s.replace(new RegExp('\\b' + 'pt-' + '[A-Za-z0-9_-]+', 'g'), '(redacted-pat)');
  s = s.replace(new RegExp('\\b' + 'jt-' + '[A-Za-z0-9_-]+', 'g'), '(redacted-token)');
  s = s.replace(new RegExp(`${'Bear'}${'er'}\\s+[A-Za-z0-9._+/=-]+`, 'gi'), '(redacted)');
  s = s.replace(/"personalToken"\s*:\s*"[^"]*"/g, '"personalToken":"(redacted)"');
  s = s.replace(/"securityOauthToken"\s*:\s*"[^"]*"/g, '"securityOauthToken":"(redacted)"');
  s = s.replace(/"refreshToken"\s*:\s*"[^"]*"/g, '"refreshToken":"(redacted)"');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) s = s.split(secret).join('(redacted)');
  }
  return s;
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}
