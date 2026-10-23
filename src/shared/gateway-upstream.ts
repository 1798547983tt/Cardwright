/**
 * 上游服务商 — who actually serves the requests behind a gateway's address.
 *
 * pi-ai decides which request fields an OpenAI-compatible endpoint accepts by
 * matching the base URL against known vendor hosts. A local relay or round-robin
 * proxy defeats that match, so pi-ai falls back to the permissive defaults and
 * sends OpenAI-only fields such as `prompt_cache_key`. Strict services reject
 * them, and a relay that drops the upstream body turns it into the bare
 * "400 status code (no body)".
 *
 * Naming an upstream restores the right field set no matter what the address
 * looks like. `auto` keeps the URL match and falls back to the conservative
 * `generic` set, which omits the fields only api.openai.com is known to accept.
 */

export const GATEWAY_UPSTREAMS = [
  'auto', 'openai', 'nvidia', 'deepseek', 'openrouter', 'zai',
  'moonshot', 'together', 'xai', 'cerebras', 'generic',
] as const;

export type GatewayUpstream = (typeof GATEWAY_UPSTREAMS)[number];

/** A resolved upstream is every choice except the `auto` placeholder. */
export type ResolvedUpstream = Exclude<GatewayUpstream, 'auto'>;

export function isGatewayUpstream(value: unknown): value is GatewayUpstream {
  return typeof value === 'string' && (GATEWAY_UPSTREAMS as readonly string[]).includes(value);
}

export const UPSTREAM_LABELS: Record<GatewayUpstream, { en: string; zh: string }> = {
  auto: { en: 'Detect from the address', zh: '自动识别' },
  openai: { en: 'OpenAI', zh: 'OpenAI 官方' },
  nvidia: { en: 'NVIDIA NIM', zh: '英伟达 NIM' },
  deepseek: { en: 'DeepSeek', zh: 'DeepSeek' },
  openrouter: { en: 'OpenRouter', zh: 'OpenRouter' },
  zai: { en: 'Z.ai / Zhipu', zh: '智谱 / Z.ai' },
  moonshot: { en: 'Moonshot', zh: 'Moonshot' },
  together: { en: 'Together', zh: 'Together' },
  xai: { en: 'xAI Grok', zh: 'xAI Grok' },
  cerebras: { en: 'Cerebras', zh: 'Cerebras' },
  generic: { en: 'Other compatible service', zh: '其他兼容服务' },
};

/**
 * The host patterns pi-ai itself matches. Kept beside the compat table so both
 * move together; `test/integration/gateway-upstream.test.ts` pins the behaviour.
 */
const UPSTREAM_HOSTS: Array<{ upstream: ResolvedUpstream; hosts: string[] }> = [
  { upstream: 'openai', hosts: ['api.openai.com'] },
  { upstream: 'nvidia', hosts: ['integrate.api.nvidia.com'] },
  { upstream: 'deepseek', hosts: ['deepseek.com'] },
  { upstream: 'openrouter', hosts: ['openrouter.ai'] },
  { upstream: 'zai', hosts: ['api.z.ai', 'open.bigmodel.cn'] },
  { upstream: 'moonshot', hosts: ['api.moonshot.'] },
  { upstream: 'together', hosts: ['api.together.ai', 'api.together.xyz'] },
  { upstream: 'xai', hosts: ['api.x.ai'] },
  { upstream: 'cerebras', hosts: ['cerebras.ai'] },
];

/** The upstream a base URL names outright, if any. */
export function detectUpstream(baseUrl: string): ResolvedUpstream | undefined {
  const url = (baseUrl || '').toLowerCase();
  if (!url) return undefined;
  return UPSTREAM_HOSTS.find(entry => entry.hosts.some(host => url.includes(host)))?.upstream;
}

/**
 * The upstream a gateway actually talks to. An explicit choice always wins, so a
 * relay in front of a known vendor keeps that vendor's field set.
 */
export function resolveUpstream(gateway: { baseUrl: string; upstream?: GatewayUpstream }): ResolvedUpstream {
  if (gateway.upstream && gateway.upstream !== 'auto') return gateway.upstream;
  return detectUpstream(gateway.baseUrl) ?? 'generic';
}

/** The subset of pi-ai's OpenAI compatibility flags an upstream decides. */
export interface UpstreamCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  supportsStrictMode?: boolean;
  supportsLongCacheRetention?: boolean;
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai';
  requiresReasoningContentOnAssistantMessages?: boolean;
  sessionAffinityFormat?: 'openai' | 'openrouter';
  cacheControlFormat?: 'anthropic';
}

const STANDARD: UpstreamCompat = {
  supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens', supportsStrictMode: true,
  supportsLongCacheRetention: true, thinkingFormat: 'openai', sessionAffinityFormat: 'openai',
};

/**
 * `generic` only withdraws the fields that a strict service is most likely to
 * reject and that only OpenAI is known to accept. Everything else stays at the
 * OpenAI-standard shape, because an unknown endpoint is usually modelled on it.
 */
const GENERIC: UpstreamCompat = {
  supportsStore: false, supportsDeveloperRole: false, supportsLongCacheRetention: false,
};

const UPSTREAM_COMPAT: Record<ResolvedUpstream, UpstreamCompat> = {
  openai: STANDARD,
  generic: GENERIC,
  nvidia: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: 'max_tokens', supportsStrictMode: false,
    supportsLongCacheRetention: false, thinkingFormat: 'openai', sessionAffinityFormat: 'openai',
  },
  deepseek: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    maxTokensField: 'max_tokens', supportsStrictMode: true,
    supportsLongCacheRetention: true, thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true, sessionAffinityFormat: 'openai',
  },
  openrouter: {
    supportsStore: true, supportsDeveloperRole: false, supportsReasoningEffort: true,
    maxTokensField: 'max_completion_tokens', supportsStrictMode: true,
    supportsLongCacheRetention: true, thinkingFormat: 'openrouter', sessionAffinityFormat: 'openrouter',
  },
  zai: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: 'max_tokens', supportsStrictMode: true,
    supportsLongCacheRetention: true, thinkingFormat: 'zai', sessionAffinityFormat: 'openai',
  },
  moonshot: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: 'max_tokens', supportsStrictMode: false,
    supportsLongCacheRetention: true, thinkingFormat: 'openai', sessionAffinityFormat: 'openai',
  },
  together: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: 'max_tokens', supportsStrictMode: false,
    supportsLongCacheRetention: false, thinkingFormat: 'together', sessionAffinityFormat: 'openai',
  },
  xai: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    maxTokensField: 'max_completion_tokens', supportsStrictMode: true,
    supportsLongCacheRetention: true, thinkingFormat: 'openai', sessionAffinityFormat: 'openai',
  },
  cerebras: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    maxTokensField: 'max_completion_tokens', supportsStrictMode: true,
    supportsLongCacheRetention: true, thinkingFormat: 'openai', sessionAffinityFormat: 'openai',
  },
};

/**
 * The compatibility flags to register a gateway's model with.
 *
 * Anthropic Messages has its own compatibility shape and its own cache
 * convention, so an upstream choice does not reshape it.
 *
 * Known limitation: on OpenAI Responses, pi-ai sends `prompt_cache_key` unless
 * caching is switched off entirely, so an upstream cannot withdraw it there.
 * That API is OpenAI-proprietary, so a strict non-OpenAI service is not expected
 * behind it.
 */
export function upstreamCompat(
  gateway: { baseUrl: string; protocol: string; modelId: string; upstream?: GatewayUpstream },
): UpstreamCompat {
  if (gateway.protocol === 'anthropic-messages') return {};
  const upstream = resolveUpstream(gateway);
  const compat = { ...UPSTREAM_COMPAT[upstream] };
  if (upstream === 'openrouter') {
    // OpenRouter passes the `developer` role through only for the vendors that accept it.
    const routed = gateway.modelId.startsWith('anthropic/') || gateway.modelId.startsWith('openai/');
    compat.supportsDeveloperRole = routed;
    if (gateway.modelId.startsWith('anthropic/')) compat.cacheControlFormat = 'anthropic';
  }
  return compat;
}
