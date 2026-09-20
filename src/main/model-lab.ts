import { randomUUID } from 'node:crypto';
import type { Context, Model } from '@earendil-works/pi-ai/compat';
import { effectiveEffort } from '../shared/effort.ts';
import type { Gateway } from '../shared/types.ts';
import type { LabReport } from '../shared/studio-types.ts';

export interface LabConnection { gateway: Gateway; apiKey: string }
export async function labCompletion(connection: LabConnection, messages: Context['messages'], options: { tools?: Context['tools']; reasoning?: boolean; signal?: AbortSignal } = {}) {
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) };
  const { streamSimple } = await import('@earendil-works/pi-ai/compat');
  const { gateway } = connection; const effort = effectiveEffort(gateway, gateway.reasoning && options.reasoning !== false ? 'medium' : 'off');
  const model: Model<any> = { id: gateway.modelId, name: gateway.modelId, provider: `cardwright-lab-${gateway.id}`, api: gateway.protocol, baseUrl: gateway.baseUrl, reasoning: gateway.reasoning, input: ['text', 'image'], contextWindow: gateway.contextWindow, maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { [effort.level]: effort.providerValue }, compat: gateway.protocol === 'anthropic-messages' ? { forceAdaptiveThinking: !!gateway.adaptiveThinking } : {} };
  const started = Date.now(); let firstTokenMs: number | null = null; let requestBytes = 0; let cacheReported = false; const probes: Promise<void>[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'error' });
    const clone = response.clone();
    probes.push((async () => {
      const reader = clone.body?.getReader(); if (!reader) return; let bytes = 0; let text = '';
      try { while (true) { const value = await reader.read(); if (value.done) break; bytes += value.value.length; text += Buffer.from(value.value).toString('utf8'); if (bytes > 1024 * 1024) { await reader.cancel(); break; } } cacheReported ||= /"(?:cached_tokens|prompt_cache_hit_tokens|cache_read_input_tokens|cache_read_tokens)"\s*:/.test(text); } catch { /* Missing telemetry stays unknown. */ } finally { reader.releaseLock(); }
    })());
    return response;
  };
  const stream = streamSimple(model, { systemPrompt: 'You are participating in an explicitly requested Cardwright connection test. Follow the user instruction concisely.', messages, tools: options.tools }, { apiKey: connection.apiKey, maxTokens: 512, reasoning: effort.level === 'off' ? undefined : effort.level, signal: options.signal, fetch: observedFetch, onPayload: payload => { requestBytes = Buffer.byteLength(JSON.stringify(payload)); } });
  for await (const event of stream) if (firstTokenMs === null && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type)) firstTokenMs = Date.now() - started;
  const result = await stream.result();
  await Promise.all(probes);
  if (result.stopReason === 'error' || result.stopReason === 'aborted') { let error = result.errorMessage || 'The model request did not complete.'; if (connection.apiKey) error = error.split(connection.apiKey).join('[redacted]'); throw new Error(error); }
  return { result, firstTokenMs, durationMs: Date.now() - started, requestBytes, cacheReported };
}
export async function probeConnection(connection: LabConnection, requested: string[]): Promise<LabReport> {
  const report: LabReport = { id: randomUUID(), kind: 'capabilities', status: 'running', rows: [], summary: '' };
  for (const capability of [...new Set(requested)].slice(0, 4)) {
    if (!['text', 'tools', 'reasoning', 'image'].includes(capability)) throw new Error('Choose text, tools, reasoning or image.');
    if (capability === 'reasoning' && !connection.gateway.reasoning) { report.rows.push({ capability, status: 'unknown', detail: 'Reasoning is not enabled for this model. No reasoning request was sent.' }); continue; }
    try {
      const tool = { name: 'connection_echo', description: 'Return the requested test value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };
      // A fixed tiny image tests transport support; it does not claim visual task quality.
      const content: any = capability === 'image' ? [{ type: 'text', text: 'An image is attached. Reply with OK.' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=' }]
        : capability === 'tools' ? 'Call connection_echo once with value "cardwright-test". Do not use any other tool.' : 'Reply with the single word OK.';
      const measured = await labCompletion(connection, [{ role: 'user', content, timestamp: Date.now() }], { tools: capability === 'tools' ? [tool] : undefined, reasoning: capability === 'reasoning' });
      const called = measured.result.content.some(part => part.type === 'toolCall' && part.name === tool.name);
      const passed = capability !== 'tools' || called;
      report.rows.push({ capability, status: passed ? 'passed' : 'failed', detail: capability === 'image' ? 'Image request accepted; visual understanding is not graded.' : capability === 'reasoning' ? 'Reasoning parameter accepted; hidden reasoning is not independently verified.' : passed ? 'Request completed as expected.' : 'The model did not call the supplied test tool.', firstTokenMs: measured.firstTokenMs, durationMs: measured.durationMs, tokens: measured.result.usage.totalTokens });
    } catch (error) { report.rows.push({ capability, status: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  }
  report.status = 'completed'; report.summary = 'Observed results from this endpoint and model. Context capacity remains a configured value until a representative workload is tested.'; return report;
}

export async function benchmarkConnection(connection: LabConnection): Promise<LabReport> {
  const report: LabReport = { id: randomUUID(), kind: 'cache', status: 'running', rows: [], summary: '' };
  const prefix = 'Cardwright synthetic cache benchmark. This is public test content, not user or project data.\n' + Array.from({ length: 220 }, (_, i) => `Reference ${i}: stable deterministic context for measuring reused input.\n`).join('');
  let input = 0; let cached = 0; let allReported = true;
  for (let round = 1; round <= 3; round++) {
    const measured = await labCompletion(connection, [{ role: 'user', content: `${prefix}\nRound ${round}: reply only OK.`, timestamp: 1 }], { reasoning: false });
    const usage = measured.result.usage; input += usage.input + usage.cacheRead + usage.cacheWrite; cached += usage.cacheRead;
    allReported &&= measured.cacheReported;
    report.rows.push({ round, input: usage.input, cacheRead: measured.cacheReported ? usage.cacheRead : null, cacheWrite: measured.cacheReported ? usage.cacheWrite : null, output: usage.output, firstTokenMs: measured.firstTokenMs, durationMs: measured.durationMs, requestBytes: measured.requestBytes });
    if (round < 3) await new Promise(resolve => setTimeout(resolve, 1800));
  }
  report.status = 'completed'; report.summary = allReported ? `Observed reused input: ${cached.toLocaleString()} / ${input.toLocaleString()} tokens (${input ? (cached / input * 100).toFixed(1) : 'unknown'}%). This synthetic test does not guarantee a real-workload hit rate.` : 'The endpoint did not provide complete cache counters. Cache hit rate is unknown; latency and request results are shown.';
  return report;
}
