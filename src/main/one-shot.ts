import type { Model } from '@earendil-works/pi-ai/compat';
import { availableEfforts, effectiveEffort } from '../shared/effort.ts';
import type { Gateway } from '../shared/types.ts';

export interface OneShotConnection { gateway: Gateway; apiKey: string }
export interface OneShotRequest { systemPrompt: string; prompt: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal }

/**
 * One model call outside any conversation, for a small job the app asks for itself (AI 归类建议): a system prompt, one
 * user message, the reply's text. No tools, and reasoning off where the model allows it, else its lightest level.
 * Modelled on the model lab's labCompletion; the key never appears in an error.
 */
export async function oneShotCompletion(connection: OneShotConnection, request: OneShotRequest): Promise<{ text: string; stopReason: string }> {
  const { gateway, apiKey } = connection;
  const maxTokens = Math.max(256, Math.min(request.maxTokens ?? 4000, gateway.maxTokens > 0 ? gateway.maxTokens : Number.MAX_SAFE_INTEGER));
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const effort = effectiveEffort(gateway, gateway.reasoning && gateway.effortMap?.off === null ? availableEfforts(gateway)[0] ?? 'low' : 'off');
  const { streamSimple } = await import('@earendil-works/pi-ai/compat');
  const model: Model<any> = {
    id: gateway.modelId, name: gateway.modelId, provider: `cardwright-one-shot-${gateway.id}`, api: gateway.protocol, baseUrl: gateway.baseUrl,
    reasoning: gateway.reasoning, input: ['text'], contextWindow: gateway.contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { [effort.level]: effort.providerValue },
    compat: gateway.protocol === 'anthropic-messages' ? { forceAdaptiveThinking: !!gateway.adaptiveThinking } : {},
  };
  const stream = streamSimple(model, { systemPrompt: request.systemPrompt, messages: [{ role: 'user', content: request.prompt, timestamp: Date.now() }] }, {
    apiKey, maxTokens, reasoning: effort.level === 'off' ? undefined : effort.level, signal,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  for await (const event of stream) void event;
  const result = await stream.result();
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    let error = result.errorMessage || (timeout.aborted ? '模型请求超时了。' : '模型请求没有完成。');
    if (apiKey) error = error.split(apiKey).join('[redacted]');
    throw new Error(error);
  }
  return { text: result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''), stopReason: result.stopReason };
}
