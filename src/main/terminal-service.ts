import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { startSandboxCommand, type CommandPolicy, type RunningCommand } from '../runtime/sandbox-runner.ts';

export interface TerminalSession {
  id: string;
  taskId: string;
  cwd: string;
  pid?: number;
  mode: CommandPolicy['mode'];
  status: 'starting' | 'running' | 'closed' | 'failed';
  output: string;
  exitCode?: number | null;
  error?: string;
}
interface LiveTerminal { session: TerminalSession; command: RunningCommand; decoder: StringDecoder; timer?: NodeJS.Timeout }

/** Native ConPTY sessions. Callers must validate task/cwd ownership and host access. */
export class TerminalService extends EventEmitter {
  private readonly terminals = new Map<string, LiveTerminal>();
  private closing = false;

  constructor(private readonly helperPath?: string, private readonly maximumSessions = 6) { super(); }

  list(): TerminalSession[] { return [...this.terminals.values()].map(item => ({ ...item.session })); }
  get(id: string): TerminalSession { return { ...this.find(id).session }; }
  private find(id: string): LiveTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('Terminal session was not found.');
    return terminal;
  }
  private changed(terminal: LiveTerminal, immediate = false): void {
    if (immediate && terminal.timer) { clearTimeout(terminal.timer); terminal.timer = undefined; }
    if (!immediate) {
      if (!terminal.timer) terminal.timer = setTimeout(() => { terminal.timer = undefined; this.emit('change', { ...terminal.session }); }, 40);
      return;
    }
    this.emit('change', { ...terminal.session });
  }

  async open(taskId: string, cwd: string, options: { policy?: CommandPolicy; cols?: number; rows?: number } = {}): Promise<TerminalSession> {
    if (this.closing) throw new Error('Terminals are shutting down.');
    if (!taskId) throw new Error('A task is required for the terminal.');
    const active = [...this.terminals.values()].filter(item => item.session.status === 'starting' || item.session.status === 'running').length;
    if (active >= this.maximumSessions) throw new Error(`Close an existing terminal before opening another (limit ${this.maximumSessions}).`);
    const policy = options.policy ?? { mode: 'sandbox', network: 'off' };
    const session: TerminalSession = { id: randomUUID(), taskId, cwd, mode: policy.mode, status: 'starting', output: '' };
    const decoder = new StringDecoder('utf8');
    let started!: (value: TerminalSession) => void;
    let failed!: (error: Error) => void;
    const ready = new Promise<TerminalSession>((resolve, reject) => { started = resolve; failed = reject; });
    const command = startSandboxCommand('', cwd, {
      policy, helperPath: this.helperPath, interactive: true, cols: options.cols, rows: options.rows,
      onStarted: pid => { session.pid = pid; session.status = 'running'; this.changed(terminal, true); started({ ...session }); },
      onData: data => { session.output = `${session.output}${decoder.write(data)}`.slice(-1_000_000); this.changed(terminal); },
    });
    const terminal: LiveTerminal = { session, command, decoder };
    this.terminals.set(session.id, terminal);
    this.changed(terminal, true);
    void command.completion.then(result => {
      session.output = `${session.output}${decoder.end()}`.slice(-1_000_000);
      session.status = 'closed'; session.exitCode = result.exitCode;
      if (!session.pid) failed(new Error('Terminal stopped before it could start.'));
      this.changed(terminal, true);
    }, error => {
      session.status = 'failed'; session.error = error instanceof Error ? error.message : String(error);
      failed(new Error(session.error)); this.changed(terminal, true);
    });
    return ready;
  }

  input(id: string, text: string): void {
    const terminal = this.find(id);
    if (terminal.session.status !== 'running') throw new Error('This terminal has stopped.');
    terminal.command.write(text);
  }
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error('Invalid terminal dimensions.');
    const terminal = this.find(id);
    if (terminal.session.status === 'running') terminal.command.resize(cols, rows);
  }
  async close(id: string): Promise<void> {
    const terminal = this.find(id);
    terminal.command.close();
    await terminal.command.completion.catch(() => undefined);
  }
  forget(id: string): void {
    const terminal = this.find(id);
    if (terminal.session.status === 'running' || terminal.session.status === 'starting') throw new Error('Close the terminal before removing it.');
    if (terminal.timer) clearTimeout(terminal.timer);
    this.terminals.delete(id);
  }
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.terminals.keys()].map(id => this.close(id)));
  }
  resumeAfterFailedUpdate(): void {
    if ([...this.terminals.values()].some(item => item.session.status === 'starting' || item.session.status === 'running')) throw new Error('Close active terminals before reopening terminal admission.');
    this.closing = false;
  }
}
