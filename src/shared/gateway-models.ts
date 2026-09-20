import type { Gateway, GatewayModel } from './types.ts';
import { defaultEffortMap, validateGatewayEffort } from './effort.ts';

/** Only model configuration belongs in a gateway's public model catalog. */
function copyModel(model: GatewayModel): GatewayModel {
  return {
    id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    effortMap: model.effortMap ? { ...model.effortMap } : undefined,
    adaptiveThinking: model.adaptiveThinking,
    nativeSearch: model.nativeSearch ? { enabled: model.nativeSearch.enabled, responsesUrl: model.nativeSearch.responsesUrl } : undefined,
    pricing: model.pricing ? { currency: model.pricing.currency, input: model.pricing.input, output: model.pricing.output, cacheRead: model.pricing.cacheRead, cacheWrite: model.pricing.cacheWrite } : undefined,
  };
}

/** Read old single-model gateways without mutating the saved object. */
export function gatewayModels(gateway: Gateway): GatewayModel[] {
  if (gateway.models !== undefined) return gateway.models.map(copyModel);
  return [copyModel({
    id: gateway.modelId, reasoning: gateway.reasoning, contextWindow: gateway.contextWindow,
    maxTokens: gateway.maxTokens, effortMap: gateway.effortMap,
    adaptiveThinking: gateway.adaptiveThinking, nativeSearch: gateway.nativeSearch,
  })];
}

function validateContext(value: number): void {
  if (!Number.isInteger(value) || value < 1024 || value > 10_000_000) {
    throw new Error('Context window must be an integer between 1,024 and 10,000,000 tokens.');
  }
}

/** Validate a complete catalog before replacing a gateway or its credentials. */
export function normalizeGatewayModels(gateway: Gateway): GatewayModel[] {
  if (gateway.models !== undefined && !Array.isArray(gateway.models)) throw new Error('Gateway models must be a list.');
  const source = gateway.models ?? [{
    id: gateway.modelId, reasoning: gateway.reasoning, contextWindow: gateway.contextWindow,
    maxTokens: gateway.maxTokens, effortMap: gateway.effortMap,
    adaptiveThinking: gateway.adaptiveThinking, nativeSearch: gateway.nativeSearch,
  }];
  if (source.length < 1 || source.length > 200) throw new Error('Each gateway must contain between 1 and 200 models.');
  const seen = new Set<string>();
  return source.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string') throw new Error('Enter a valid model ID.');
    const id = model.id.trim();
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Enter a model ID of up to 200 characters.');
    if (seen.has(id)) throw new Error(`Model "${id}" is already included in this gateway.`);
    seen.add(id);
    if (model.name !== undefined && (typeof model.name !== 'string' || model.name.trim().length > 120)) throw new Error('Model display names must contain at most 120 characters.');
    if (typeof model.reasoning !== 'boolean') throw new Error('Declare whether each model supports reasoning.');
    validateContext(model.contextWindow);
    if (!Number.isInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) throw new Error(`Check maximum output tokens and context window for model "${id}".`);
    if (model.nativeSearch !== undefined && (!model.nativeSearch || typeof model.nativeSearch !== 'object' || Array.isArray(model.nativeSearch) || typeof model.nativeSearch.enabled !== 'boolean' || (model.nativeSearch.responsesUrl !== undefined && typeof model.nativeSearch.responsesUrl !== 'string'))) throw new Error('Check the model native search configuration.');
    const normalized = copyModel({ ...model, id, name: model.name?.trim() || undefined });
    if (model.pricing && (!/^[A-Z]{3}$/.test(model.pricing.currency) || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(model.pricing![key as keyof Omit<NonNullable<GatewayModel['pricing']>, 'currency'>]) || Number(model.pricing![key as keyof Omit<NonNullable<GatewayModel['pricing']>, 'currency'>]) < 0))) throw new Error('Model pricing must have a currency and non-negative rates per million tokens.');
    // The protocol is shared; reasoning and search capabilities are model-specific.
    validateGatewayEffort({ ...gateway, ...normalized, id: gateway.id, modelId: normalized.id });
    if (gateway.protocol !== 'anthropic-messages' || normalized.adaptiveThinking) normalized.effortMap = { ...defaultEffortMap, ...normalized.effortMap };
    if (normalized.nativeSearch?.responsesUrl !== undefined) normalized.nativeSearch.responsesUrl = normalized.nativeSearch.responsesUrl.trim();
    return normalized;
  });
}

/** Resolve one model while retaining the shared connection and credential ID. */
export function resolveGatewayModel(gateway: Gateway, modelId?: string, contextWindow?: number): Gateway {
  const models = gatewayModels(gateway);
  const selected = modelId === undefined
    ? models.find(model => model.id === gateway.modelId) ?? models[0]
    : models.find(model => model.id === modelId);
  if (!selected) throw new Error(modelId === undefined ? 'This gateway has no configured models.' : `Model "${modelId}" is no longer configured in gateway "${gateway.name}". Select another model.`);
  const window = contextWindow ?? selected.contextWindow;
  if (contextWindow !== undefined) validateContext(window);
  return {
    ...gateway, modelId: selected.id, reasoning: selected.reasoning,
    contextWindow: window, maxTokens: Math.min(selected.maxTokens, window),
    effortMap: selected.effortMap, adaptiveThinking: selected.adaptiveThinking,
    nativeSearch: selected.nativeSearch, pricing: selected.pricing,
  };
}
