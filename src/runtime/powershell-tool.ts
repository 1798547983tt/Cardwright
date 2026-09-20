import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalPowerShellOperations, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveEcosystemPackage } from './ecosystem-skills.ts';

type ShellOperations = { exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> };
type ShellToolFactory = (cwd: string, config: Record<string, unknown>, options: { operations: ShellOperations; exposeSessionEnvironment: false }) => ToolDefinition;

/** The worker's environment for a command, without the agent runtime's own PI_* settings. */
export function commandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^PI_/i.test(key)));
}

/** Runs on this computer, like the SDK's PowerShell, but with the command environment above. */
export function localPowerShellOperations(): ShellOperations {
  const operations = createLocalPowerShellOperations();
  return { exec: (command, cwd, options) => operations.exec(command, cwd, { ...options, env: commandEnvironment(options.env ?? process.env) }) };
}

let factory: Promise<ShellToolFactory> | undefined;
/**
 * The SDK's shell tool builder (pinned to 0.85.1), loaded from the same file the package entry uses, so a PowerShell
 * tool can carry Cardwright's own name for the file that keeps truncated output.
 */
export function loadShellToolFactory(): Promise<ShellToolFactory> {
  factory ??= import(pathToFileURL(join(dirname(resolveEcosystemPackage('@earendil-works/pi-coding-agent')), 'dist', 'core', 'tools', 'bash.js')).href)
    .then((module: { createShellToolDefinition?: ShellToolFactory }) => {
      if (typeof module.createShellToolDefinition !== 'function') throw new Error('The agent runtime changed its shell tool; review the PowerShell adapter.');
      return module.createShellToolDefinition;
    });
  return factory;
}

/** A PowerShell tool definition: no session variables in the environment, truncated output kept in cardwright-powershell-*.log. */
export function powershellTool(create: ShellToolFactory, cwd: string, operations: ShellOperations, name = 'powershell'): ToolDefinition {
  return create(cwd, { name, label: name, shellName: 'PowerShell', prompt: 'PS>', promptSnippet: 'Execute PowerShell commands', tempFilePrefix: 'cardwright-powershell' }, { operations, exposeSessionEnvironment: false });
}
