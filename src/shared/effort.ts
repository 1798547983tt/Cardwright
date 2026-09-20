import type { Gateway, ThinkingLevel } from './types';

export const visibleEffortLevels: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Provider request defaults. Ultra changes orchestration and shares Maximum's effort. */
export const defaultEffortMap = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' } as const;
export type RuntimeEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const known = new Set<string>(['off', 'minimal', ...visibleEffortLevels]);
const extended = new Set<ThinkingLevel>(['xhigh', 'max', 'ultra']);
const legacyAnthropic = (gateway: Gateway) => gateway.protocol === 'anthropic-messages' && !gateway.adaptiveThinking;

/** A provider capability declaration, not a guess based on its model's name. */
export function validateGatewayEffort(gateway: Gateway): void {
  if (gateway.adaptiveThinking !== undefined && typeof gateway.adaptiveThinking !== 'boolean') throw new Error('Adaptive thinking must be enabled or disabled.');
  if (gateway.adaptiveThinking && gateway.protocol !== 'anthropic-messages') throw new Error('Adaptive thinking is available only with the Anthropic Messages protocol.');
  if (gateway.effortMap === undefined) return;
  if (!gateway.effortMap || typeof gateway.effortMap !== 'object' || Array.isArray(gateway.effortMap)) throw new Error('Reasoning mappings must be an object.');
  for (const [level, value] of Object.entries(gateway.effortMap)) {
    if (!known.has(level) || (value !== null && (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)))) throw new Error('Each reasoning mapping must contain a known level and a provider value of up to 64 letters, numbers, dots, dashes or underscores.');
    if (value !== null && extended.has(level as ThinkingLevel) && legacyAnthropic(gateway)) throw new Error('Extra high, Maximum and Ultra require an adaptive-thinking Anthropic gateway.');
  }
}

export function availableEfforts(gateway: Gateway): ThinkingLevel[] {
  if (!gateway.reasoning) return ['off'];
  return visibleEffortLevels.filter(level => {
    if (gateway.effortMap?.[level] === null) return false;
    if (!extended.has(level)) return true;
    return !legacyAnthropic(gateway);
  });
}

/** Ultra reuses the runtime's max slot in this task's private model registration. */
export function effectiveEffort(gateway: Gateway, selected: ThinkingLevel): { level: RuntimeEffort; providerValue?: string } {
  validateGatewayEffort(gateway);
  if (!known.has(selected)) throw new Error('Unknown reasoning level.');
  if (selected === 'off') {
    if (gateway.effortMap?.off === null) throw new Error('This gateway does not support disabling reasoning.');
    return { level: 'off', ...(gateway.protocol !== 'anthropic-messages' && gateway.effortMap?.off ? { providerValue: gateway.effortMap.off } : {}) };
  }
  // Minimal is accepted only to resume older saved tasks; new UI choices use Low.
  const legacyMinimal = selected === 'minimal' && gateway.reasoning && gateway.effortMap?.minimal !== null;
  if (!legacyMinimal && !availableEfforts(gateway).includes(selected)) throw new Error(`The gateway does not declare support for reasoning level "${selected}". Choose a supported level or configure its provider mapping.`);
  const level: RuntimeEffort = selected === 'ultra' ? 'max' : selected;
  if (legacyAnthropic(gateway)) return { level };
  return { level, providerValue: gateway.effortMap?.[selected] ?? (selected in defaultEffortMap ? defaultEffortMap[selected as keyof typeof defaultEffortMap] : selected) };
}
