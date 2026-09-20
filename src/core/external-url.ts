export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid source URL.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Only HTTP(S) source links without credentials can be opened.');
  return url.href;
}
