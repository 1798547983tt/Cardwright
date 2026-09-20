/**
 * Loads every bundled face up front (local files, a few hundred KB) while the boot sequence covers the window.
 * Without this, a weight used for the first time mid-session swaps in late and shifts text layout,
 * which can move a preserved scroll position.
 */
export function preloadFonts(): Promise<void> {
  if (!('fonts' in document)) return Promise.resolve();
  const faces = ['400 14px "Chakra Petch"', '500 14px "Chakra Petch"', '600 14px "Chakra Petch"', '700 14px "Chakra Petch"', '400 14px "Share Tech Mono"'];
  return Promise.all(faces.map(face => document.fonts.load(face))).then(() => undefined, () => undefined);
}
