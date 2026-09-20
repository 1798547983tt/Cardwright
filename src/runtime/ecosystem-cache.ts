import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventBus, ExtensionRuntime, LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import { resolveEcosystemPackage } from './ecosystem-skills.ts';

export const CACHE_OPTIMIZER_VERSION = '2.8.10';
interface PiLoader {
  loadExtensions(paths: string[], cwd: string, bus?: EventBus, runtime?: ExtensionRuntime): Promise<LoadExtensionsResult>;
}

/** Call once in an isolated task worker, before other external extensions load. */
export async function loadCacheOptimizer(options: { cwd: string; agentDir: string; eventBus?: EventBus; runtime?: ExtensionRuntime }): Promise<LoadExtensionsResult> {
  if (!isAbsolute(options.agentDir)) throw new Error('Cache state directory must be absolute.');
  mkdirSync(options.agentDir, { recursive: true });
  const manifestPath = resolveEcosystemPackage('pi-cache-optimizer');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string };
  if (manifest.version !== CACHE_OPTIMIZER_VERSION) throw new Error('Cache Optimizer version changed; review its desktop compatibility.');
  process.env.PI_CODING_AGENT_DIR = resolve(options.agentDir);
  process.env.PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE = '1';
  process.env.PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION = '1';
  process.env.PI_CACHE_OPTIMIZER_TOOL_ORDER = '0';
  process.env.PI_CACHE_OPTIMIZER_FOOTER_MODE = 'session';
  // Compatible gateway support cannot be inferred from model names. Upstream
  // still validates cache TTL ordering/retention and records actual usage.
  process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY = '1';
  const piManifestPath = resolveEcosystemPackage('@earendil-works/pi-coding-agent');
  const piManifest = JSON.parse(readFileSync(piManifestPath, 'utf8')) as { version?: string };
  if (piManifest.version !== '0.85.1') throw new Error('The agent runtime version changed; review the extension adapter.');
  const loader = await import(pathToFileURL(join(dirname(piManifestPath), 'dist', 'core', 'extensions', 'loader.js')).href) as PiLoader;
  const loaded = await loader.loadExtensions([join(dirname(manifestPath), 'index.ts')], options.cwd, options.eventBus, options.runtime);
  for (const extension of loaded.extensions) {
    const command = extension.commands.get('cache-optimizer');
    if (command) {
      const handler = command.handler;
      command.getArgumentCompletions = undefined;
      command.handler = async (args, ctx) => {
        const words = args.trim().toLowerCase().split(/\s+/);
        if (words[0] === '' || words[0] === 'help') {
          ctx.ui.notify('/cache-optimizer stats [all|contributors] — cache usage\n/cache-optimizer doctor — compatibility diagnostics\nCardwright manages cache settings.', 'info');
          return;
        }
        if (!['stats', 'status', 'doctor'].includes(words[0]) || words.length > 2 || (words.length === 2 && (words[0] !== 'stats' || !['all', 'contributors'].includes(words[1])))) {
          ctx.ui.notify('Cardwright manages cache configuration. Only /cache-optimizer stats, doctor, and help are available here.', 'info');
          return;
        }
        await handler(words[0] === 'status' ? 'stats' : words.join(' '), ctx);
      };
    }
  }
  return loaded;
}
