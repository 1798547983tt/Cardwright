import { createJiti } from 'jiti/static';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { resolveEcosystemPackage } from './ecosystem-skills.ts';

export interface EcosystemMcpServer {
  id: string; name: string; enabled: boolean; transport: 'stdio' | 'http';
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}
export interface McpApprovalRequest {
  serverName: string; originalToolName: string; prefixedToolName: string;
  args: Record<string, unknown>; origin: string; signal?: AbortSignal;
}
interface UpstreamApprovalRequest extends McpApprovalRequest { claim(callback: () => Promise<'allow_once' | 'deny'>): boolean }
export interface EcosystemMcpOptions {
  agentDir: string;
  /** Reuse the task's current permission mode; no second independent approval policy. */
  approve(request: McpApprovalRequest): Promise<boolean>;
  onStatus?(snapshot: unknown): void;
}
interface UpstreamMcp { createMcpAdapter(options: { config: ReturnType<typeof ecosystemMcpConfig> }): ExtensionFactory }
let modulePromise: Promise<UpstreamMcp> | undefined;

/** Explicit isolated snapshot. No host imports, profile discovery, token-store reads or eager processes. */
export function ecosystemMcpConfig(servers: EcosystemMcpServer[]) {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(server.id) || Object.hasOwn(mcpServers, server.id)) throw new Error('MCP server IDs must be unique letters, numbers, underscores or hyphens.');
    const common = { lifecycle: 'lazy', directTools: false, approveTools: true, auth: false, oauth: false, requestTimeoutMs: 20_000 };
    if (server.transport === 'stdio') {
      if (!server.command?.trim() || server.command.includes('\0')) throw new Error('MCP stdio servers need an executable command.');
      if (server.args && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('MCP arguments must be strings.');
      mcpServers[server.id] = { ...common, command: server.command.trim(), args: server.args ? [...server.args] : [], ...(server.cwd ? { cwd: server.cwd } : {}),
        inheritEnv: false, env: { ...server.env }, literalEnv: true };
    } else if (server.transport === 'http') {
      let url: URL;
      try { url = new URL(server.url ?? ''); } catch { throw new Error('MCP HTTP servers need an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP URLs must use HTTP(S) without embedded credentials or fragments.');
      if (server.headers && Object.entries(server.headers).some(([name, value]) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value))) throw new Error('MCP headers are invalid.');
      mcpServers[server.id] = { ...common, url: url.href, headers: { ...server.headers } };
    } else throw new Error('Unknown MCP transport.');
  }
  return { mcpServers, imports: [], settings: {
    hostConfigDiscovery: 'off', directTools: false, scriptMode: false, autoAuth: false, sampling: false,
    elicitation: false, approveTools: true, notifyOnStartupConnect: false, mcpFooterStatus: 'off',
    outputGuard: { maxBytes: 24_000, maxLines: 400, detailsMaxBytes: 12_000 },
    authRequiredMessage: 'Configure this MCP server connection in Cardwright settings.',
  } };
}

export async function createEcosystemMcpExtension(servers: EcosystemMcpServer[], options: EcosystemMcpOptions): Promise<ExtensionFactory> {
  const config = ecosystemMcpConfig(servers);
  const manifest = resolveEcosystemPackage('pi-mcp-adapter');
  const loader = createJiti(manifest, { fsCache: false, interopDefault: false });
  const { getMetadataCachePath } = await loader.import<{ getMetadataCachePath(): string }>(join(dirname(manifest), 'metadata-cache.ts'));
  // Upstream bootstraps ALL servers when the metadata file is absent, even lazy servers.
  // Seed only the app-owned cache so startup cannot execute an unapproved stdio command.
  const cachePath = getMetadataCachePath();
  if (resolve(cachePath) !== resolve(join(options.agentDir, 'mcp-cache.json'))) throw new Error('MCP runtime storage must be isolated to the Cardwright worker agent directory.');
  await mkdir(options.agentDir, { recursive: true });
  try { await writeFile(cachePath, '{"version":1,"servers":{}}', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
  const upstream = await (modulePromise ??= loader.import<UpstreamMcp>(join(dirname(manifest), 'index.ts')));
  const extension = upstream.createMcpAdapter({ config });
  return pi => {
    // The upstream broker runs for proxy/direct/resource execution; only host answers settle it.
    const unsubscribeApproval = pi.events.on('pi-mcp-adapter:tool-approval-request', (event: unknown) => {
      const request = event as UpstreamApprovalRequest;
      request.claim(async () => {
        if (request.signal?.aborted) return 'deny';
        try { return await options.approve(request) && !request.signal?.aborted ? 'allow_once' : 'deny'; }
        catch { return 'deny'; }
      });
    });
    const unsubscribeStatus = pi.events.on('pi-mcp-adapter/status/v1', snapshot => options.onStatus?.(snapshot));
    pi.on('session_shutdown', () => { unsubscribeApproval(); unsubscribeStatus(); });
    return extension(pi);
  };
}
