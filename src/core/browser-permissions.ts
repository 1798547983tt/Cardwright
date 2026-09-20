/**
 * What the built-in browser is allowed to do (§6.4): local pages open by themselves, any other site waits for the
 * user, and passwords or payment details are never typed by the agent.
 */
export type BrowserDecision = { allow: true } | { allow: false; reason: 'ask'; origin: string } | { allow: false; reason: 'blocked'; message: string };

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;
const SECRET_FIELD = /(password|passwd|pwd|otp|一次性密码|验证码)/i;
const PAYMENT_FIELD = /(^|[^a-z])(cc|card|cvc|cvv|securitycode|creditcard|cardnumber|expiry|exp-date)([^a-z]|$)/i;

/** An address the user or the agent typed, as a real URL; anything that is not a web page is refused. */
export function normalizeUrl(input: string): string | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  // `localhost:3000` is a host and a port, not a scheme; a real scheme has `//` or is not followed by digits.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text);
  const local = LOCAL.test(text.split(/[:/]/)[0]) || /^[\w.-]+\.localhost(:|\/|$)/i.test(text);
  const candidate = hasScheme ? text : `${local ? 'http' : 'https'}://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch { return null; }
}

export function isLocal(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return LOCAL.test(hostname) || /\.localhost$/i.test(hostname);
  } catch { return false; }
}

export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

/** Whether this address may be opened now, or which origin the user has to allow first. */
export function browserDecision(url: string, allowed: readonly string[]): BrowserDecision {
  const normalized = normalizeUrl(url);
  if (!normalized) return { allow: false, reason: 'blocked', message: '只能打开 http 或 https 网页。' };
  if (isLocal(normalized)) return { allow: true };
  const origin = originOf(normalized);
  return allowed.includes(origin) ? { allow: true } : { allow: false, reason: 'ask', origin };
}

/** A click that would hand a form to the site; the user decides those, not the agent (§6.4). */
export function submitsForm(element: { role?: string; type?: string; inForm?: boolean }): boolean {
  if (!element.inForm) return false;
  const type = (element.type ?? '').toLowerCase();
  const role = (element.role ?? '').toLowerCase();
  if (type === 'submit' || type === 'image') return true;
  return role === 'button' && type !== 'button' && type !== 'reset';
}

/** Typing into a password or payment field is refused whatever the page or the user says. */
export function typingDecision(field: { type?: string; autocomplete?: string; name?: string; id?: string; label?: string }): { allow: boolean; message?: string } {
  const haystack = [field.autocomplete, field.name, field.id, field.label].filter(Boolean).join(' ');
  if ((field.type ?? '').toLowerCase() === 'password' || SECRET_FIELD.test(haystack)) return { allow: false, message: '这是密码或验证码输入框，Cardwright 不代填，请你自己输入。' };
  if (PAYMENT_FIELD.test(haystack)) return { allow: false, message: '这是支付信息输入框，Cardwright 不代填，请你自己输入。' };
  return { allow: true };
}
