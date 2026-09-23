// What the portable build leaves out. The installer wraps this same directory (prepackaged), so anything that
// ships here ships to every user: only the app itself goes in, never design documents, scripts, native sources
// or this machine's tool settings.
export const PACKAGE_IGNORE = [
  /^\/(release|src|test|artifacts|docs|scripts|native|\.data|\.impeccable|\.claude|\.tmp|\.git)($|\/)/,
  /^\/(CONTEXT|DESIGN|PRODUCT|README)\.md$/,
  /^\/(\.gitignore|tsconfig\.json|electron-builder\.config\.cjs|index\.html|pet\.html)$/,
];
