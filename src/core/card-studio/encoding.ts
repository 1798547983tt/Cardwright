/** Text encodings accepted for imported material. Everything is stored as UTF-8 afterwards. */
export type TextEncodingId = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030';
export interface DecodedText { encoding: TextEncodingId; label: string; text: string }

const LABELS: Record<TextEncodingId, string> = {
  'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 BOM → UTF-8', 'utf-16le': 'UTF-16LE → UTF-8', 'utf-16be': 'UTF-16BE → UTF-8', gb18030: 'GB18030/GBK → UTF-8',
};

function result(encoding: TextEncodingId, text: string): DecodedText { return { encoding, label: LABELS[encoding], text }; }

/** UTF-16 without a byte order mark: ASCII-heavy text leaves zero bytes on one side of each pair. */
function guessUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length < 4 || bytes.length % 2) return null;
  const pairs = Math.min(bytes.length, 4096) / 2;
  let even = 0; let odd = 0;
  for (let index = 0; index < pairs * 2; index++) if (bytes[index] === 0) { if (index % 2) odd++; else even++; }
  if (odd / pairs > 0.3 && even / pairs < 0.05) return 'utf-16le';
  if (even / pairs > 0.3 && odd / pairs < 0.05) return 'utf-16be';
  return null;
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return result('utf-8-bom', new TextDecoder('utf-8').decode(bytes.subarray(3)));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return result('utf-16le', new TextDecoder('utf-16le').decode(bytes.subarray(2)));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return result('utf-16be', new TextDecoder('utf-16be').decode(bytes.subarray(2)));
  const utf16 = guessUtf16(bytes);
  if (utf16) return result(utf16, new TextDecoder(utf16).decode(bytes));
  try { return result('utf-8', new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return result('gb18030', new TextDecoder('gb18030').decode(bytes)); }
}
