import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

export const SUPI_GUIDANCE_VERSION = '6.4.0';
let applicationRoot: string | undefined;
/** Electron knows its application path even when launched without an argv entry. */
export function setEcosystemApplicationRoot(path: string): void {
  if (!isAbsolute(path) || JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name !== 'cardwright') throw new Error('Invalid Cardwright application root.');
  applicationRoot = realpathSync(path);
}

/** Works in the bundled Electron CJS main and isolated ESM task workers.
 * Resolution is anchored to the executing app/test module, never a project cwd.
 * Stop at the Cardwright package root so user-global node_modules is not searched.
 */
export function resolveEcosystemPackage(name: string): string {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)) throw new Error('Invalid built-in package name.');
  const main = (process as NodeJS.Process & { mainModule?: { filename?: string } }).mainModule?.filename;
  const anchor = applicationRoot ? join(applicationRoot, 'package.json') : main ?? process.argv[1];
  if (!anchor || !isAbsolute(anchor)) throw new Error('Cannot resolve the Cardwright application module.');
  let directory = dirname(anchor);
  while (true) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name === 'cardwright') {
        const require = createRequire(manifestPath);
        const packageJson = join(directory, 'node_modules', name, 'package.json');
        if (!existsSync(packageJson)) throw new Error(`Built-in package ${name} is not installed in Cardwright.`);
        // Ask Node for its module roots while refusing global/user fallbacks.
        if (!(require.resolve.paths(name) ?? []).includes(join(directory, 'node_modules'))) throw new Error('Invalid application module search path.');
        const installed = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (installed.name !== name) throw new Error(`Built-in package identity mismatch: ${name}.`);
        return packageJson;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cardwright package root was not found.');
    directory = parent;
  }
}

/** Exact text resources bundled by supi-claude-md. No JS discovery or project scanning. */
export function getEcosystemSkillPaths(): string[] {
  const manifestPath = resolveEcosystemPackage('@mrclrchtr/supi-claude-md');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
  if (manifest.version !== SUPI_GUIDANCE_VERSION) throw new Error('The bundled guidance skills changed version; review them.');
  return ['claude-md-improver', 'claude-md-revision'].map(name => realpathSync(join(dirname(manifestPath), 'skills', name, 'SKILL.md')));
}
