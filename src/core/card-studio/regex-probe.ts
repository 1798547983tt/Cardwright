// src/core/card-studio/regex-probe.ts
/**
 * Two regex checks SillyTavern itself never makes (Q12h): catastrophic backtracking, probed by running the pattern in a
 * worker against a deadline; and Java-dialect writings that the Android client's regex engine reads differently from JS.
 */
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

export interface ProbeResult { hang: boolean }
/** `inconclusive`: the worker never came up, or broke; nothing is known about the pattern. */
export type ProbeVerdict = 'ok' | 'hang' | 'inconclusive';
export interface RegexProber {
  /** Runs one pattern over the samples. Probes wait for each other: there is one worker. */
  probe(source: string, flags: string, samples: string[]): Promise<ProbeVerdict>;
  /** Ends the worker; a probe still running, or asked for later, is inconclusive. */
  close(): void;
}
export interface RegexProberOptions {
  /** How long the pattern may run, counted from the moment the worker has compiled it. */ budgetMs?: number;
  /** The second, longer run a first hang gets before it counts. */ confirmMs?: number;
  /** How long the worker may take to come up and compile the pattern. */ startCapMs?: number;
}

/**
 * Long inputs that share the pattern's literal opening but never close it: what makes a nested quantifier explode.
 * One run ends in a character that breaks it — a homogeneous run alone just matches, and a match never backtracks.
 */
export function backtrackSamples(source: string, format?: string | null): string[] {
  // An anchor or a group around the opening does not change what the text starts with: ^(?:<content>) opens with <content>.
  const opening = /^(?:\^|\((?:\?:|\?<[\p{ID_Start}$_][\p{ID_Continue}$]*>)?)*/u.exec(source)?.[0].length ?? 0;
  const prefix = /^(?:[^\\[\](){}.*+?^$|]|\\[<>/])*/.exec(source.slice(opening))?.[0].replace(/\\(.)/g, '$1') ?? '';
  const samples = [prefix + 'a'.repeat(4000), prefix + 'a'.repeat(4000) + '!', prefix + 'ab '.repeat(1500), (prefix + '\n').repeat(400), 'x'.repeat(5000)];
  if (format) samples.push(format.repeat(Math.ceil(4000 / Math.max(1, format.length))));
  return samples;
}

/** The worker: compile, report ready, run every sample, report done. A pattern that does not compile, or a run that throws, is done. */
const WORKER = [
  "const { workerData } = require('node:worker_threads');",
  'const port = workerData.port;',
  "port.on('message', job => {",
  '  let regex;',
  '  try { regex = new RegExp(job.source, job.flags); } catch { port.postMessage({ id: job.id, done: true }); return; }',
  '  port.postMessage({ id: job.id, ready: true });',
  '  try { for (const sample of job.samples) { regex.lastIndex = 0; regex.test(sample); } } catch { /* not a hang */ }',
  '  port.postMessage({ id: job.id, done: true });',
  '});',
].join('\n');

interface ProbeMessage { id: number; ready?: boolean; done?: boolean }

/**
 * One worker, reused, that runs patterns one after another. Only the pattern's own run is timed: the budget starts when
 * the worker reports it has compiled, so its start-up never counts, and a deadline that fires late because this thread
 * was busy first reads what the worker already sent. A first hang is run again on a fresh worker with `confirmMs`: a
 * slow machine finishes a quadratic pattern then, an exponential one never finishes.
 */
export function createRegexProber(options: RegexProberOptions = {}): RegexProber {
  const { budgetMs = 300, confirmMs = 1500, startCapMs = 5000 } = options;
  let worker: Worker | null = null;
  let port: MessagePort | null = null;
  /** The probe in flight: what reads its messages, and what ends it without an answer. */
  let running: { handle(message: ProbeMessage): void; abandon(): void } | null = null;
  let nextId = 0;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** Drops the worker, stuck or not; the next run spawns a fresh one. */
  const discard = (): void => {
    const dropped = worker; const droppedPort = port;
    worker = null; port = null;
    droppedPort?.close();
    dropped?.terminate().catch(() => undefined);
  };
  const spawn = (): MessagePort => {
    const { port1, port2 } = new MessageChannel();
    const spawned = new Worker(WORKER, { eval: true, workerData: { port: port2 }, transferList: [port2] });
    // An 'error' event nobody listens to would take the whole process down; a worker that breaks or leaves ends its probe.
    const lost = (): void => { if (worker !== spawned) return; if (running) running.abandon(); else discard(); };
    spawned.on('error', lost);
    spawned.on('exit', lost);
    spawned.unref();
    port1.on('message', (message: ProbeMessage) => running?.handle(message));
    port1.unref();
    worker = spawned; port = port1;
    return port1;
  };

  const run = (source: string, flags: string, samples: string[], budget: number): Promise<ProbeVerdict> => new Promise(resolve => {
    if (closed) { resolve('inconclusive'); return; }
    let active: MessagePort;
    try { active = port ?? spawn(); } catch { discard(); resolve('inconclusive'); return; }
    const id = ++nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const probe = {
      handle(message: ProbeMessage): void {
        if (message.id !== id) return;
        if (message.done) settle('ok');
        else if (message.ready && !started) { started = true; clearTimeout(timer); timer = setTimeout(budgetOver, budget); }
      },
      abandon(): void { settle('inconclusive'); },
    };
    function settle(verdict: ProbeVerdict): void {
      if (running !== probe) return;
      running = null;
      clearTimeout(timer);
      // A worker stuck in a pattern, or a broken one, is never reused.
      if (verdict !== 'ok') discard();
      resolve(verdict);
    }
    /** The worker's messages may still sit in the queue behind whatever held this thread: read them before judging. */
    function drain(): void {
      for (let next = receiveMessageOnPort(active); next && running === probe; next = receiveMessageOnPort(active)) probe.handle(next.message as ProbeMessage);
    }
    function budgetOver(): void { drain(); settle('hang'); }
    function startOver(): void { drain(); if (!started) settle('inconclusive'); }
    running = probe;
    timer = setTimeout(startOver, startCapMs);
    try { active.postMessage({ id, source, flags: flags.replace(/g/g, ''), samples }); } catch { settle('inconclusive'); }
  });

  const confirmed = async (source: string, flags: string, samples: string[]): Promise<ProbeVerdict> => {
    const first = await run(source, flags, samples, budgetMs);
    return first === 'hang' ? run(source, flags, samples, confirmMs) : first;
  };

  return {
    probe(source, flags, samples) {
      const result = queue.then(() => confirmed(source, flags, samples));
      queue = result.catch(() => undefined);
      return result;
    },
    close() {
      closed = true;
      running?.abandon();
      discard();
    },
  };
}

/** One pattern on a worker of its own: a hang when it runs past `timeoutMs`, and again past the longer confirmation run. */
export async function probeBacktracking(source: string, flags: string, samples: string[], timeoutMs = 300): Promise<ProbeResult> {
  const prober = createRegexProber({ budgetMs: timeoutMs });
  try { return { hang: await prober.probe(source, flags, samples) === 'hang' }; }
  finally { prober.close(); }
}

/*
 * The dialect scan reads tokens, the way JavaScript reads the pattern: an escape pair, a whole [...] class and a group
 * opener are single units, so \*+ is a literal star run, [*+] is a class and \(?> is a literal parenthesis.
 */
type TokenKind = 'escape' | 'class' | 'open' | 'close' | 'quantifier' | 'char';
interface Token { kind: TokenKind; text: string }
const OPENER = /\((?:\?(?:<[=!]|<[\p{ID_Start}$_][\p{ID_Continue}$]*>|[:=!>]|[a-zA-Z]*-?[a-zA-Z]*[:)]))?/uy;
const QUANTIFIER = /(?:[*+?]|\{\d+(?:,\d*)?\})\??/y;

function regexTokens(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    let token: Token;
    if (char === '\\') token = { kind: 'escape', text: source.slice(index, index + 2) };
    else if (char === '[') {
      // JavaScript closes a class at the first unescaped ] after [ or [^: [] is an empty class, [[:alpha:]] is [[:alpha:] and a ].
      let end = index + 1;
      if (source[end] === '^') end++;
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      token = { kind: 'class', text: source.slice(index, end + 1) };
    } else if (char === '(') { OPENER.lastIndex = index; token = { kind: 'open', text: OPENER.exec(source)?.[0] ?? char }; }
    else if (char === ')') token = { kind: 'close', text: char };
    else { QUANTIFIER.lastIndex = index; const quantifier = QUANTIFIER.exec(source)?.[0]; token = quantifier ? { kind: 'quantifier', text: quantifier } : { kind: 'char', text: char }; }
    tokens.push(token);
    index += token.text.length;
  }
  return tokens;
}

/** A lookbehind whose length has no upper bound up to its own ): an unbounded quantifier (* + {n,}) or a backreference. */
function unboundedLookbehind(tokens: Token[], start: number): boolean {
  let depth = 0;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'open') { if (!token.text.endsWith(')')) depth++; } // (?i) opens nothing
    else if (token.kind === 'close') { if (depth-- === 0) return false; }
    else if (token.kind === 'quantifier' && /^(?:[*+]|\{\d+,\})/.test(token.text)) return true;
    else if (token.kind === 'escape' && (/^\\[1-9]$/.test(token.text) || (token.text === '\\k' && tokens[index + 1]?.text === '<'))) return true;
  }
  return false;
}

/** In reporting order; each finds its writing among the tokens. */
const DIALECT: Array<{ found(token: Token, index: number, tokens: Token[]): boolean; message: string }> = [
  { found: token => token.kind === 'open' && /^\(\?[a-zA-Z-]+\)$/.test(token.text), message: '内联标志（(?i) 这类写法）：JS 不支持，安卓客户端的 Java 方言支持但含义不同。把标志写到结尾的 /…/i。' },
  { found: token => token.kind === 'escape' && /^\\[AZzhHRX]$/.test(token.text), message: '\\A、\\Z、\\z、\\h、\\R、\\X 是 Java 方言的转义，JS 里意义不同或无效。用 ^、$ 与 \\s。' },
  { found: token => token.kind === 'class' && /^\[\^?\[:[a-z]+:\]$/.test(token.text), message: 'POSIX 字符类 [[:alpha:]] 只有 Java 方言认；用 [A-Za-z] 或 \\p{L}（加 u 标志）。' },
  { found: token => token.kind === 'open' && token.text === '(?>', message: '原子组 (?>…) JS 不支持。' },
  { found: (token, index, tokens) => token.kind === 'quantifier' && tokens[index + 1]?.kind === 'quantifier' && tokens[index + 1].text.startsWith('+'), message: '占有量词（*+、++、?+、{n}+）JS 不支持。' },
  { found: (token, index, tokens) => token.kind === 'open' && (token.text === '(?<=' || token.text === '(?<!') && unboundedLookbehind(tokens, index), message: '后视 (?<=、(?<! 里有不定长的量词（* + {n,}）或反向引用：安卓客户端的 Java 方言要求后视有长度上限，JS 不要求。改成有上限的写法，或改用捕获组。' },
];
/** Java-dialect writings in a find expression, each with the JavaScript way to write it. */
export function dialectProblems(source: string): string[] {
  const tokens = regexTokens(source);
  return DIALECT.filter(rule => tokens.some((token, index) => rule.found(token, index, tokens))).map(rule => rule.message);
}
