import type { Gateway } from '../shared/types';
import { resolveGatewayModel } from '../shared/gateway-models';

/** Keep unavailable historical selections visible without silently changing models. */
export function selectedModel(gateway?: Gateway, modelId?: string, contextWindow?: number): Gateway | undefined {
  if (!gateway) return undefined;
  try { return resolveGatewayModel(gateway, modelId, contextWindow); }
  catch { return undefined; }
}
