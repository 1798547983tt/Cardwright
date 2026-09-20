import { useApp } from '../context';
import { ModelPicker } from '../ModelPicker';
import { thinkingLabel } from '../effort';
import { selectedModel } from '../model-resolution';
import { availableEfforts } from '../../shared/effort';
import type { CardProjectView, CardSettings } from '../../shared/card-studio/types';
import type { ThinkingLevel } from '../../shared/types';

type Kickoff = NonNullable<CardSettings['kickoff']>;

/**
 * What 从零开始制卡 and 完善优化卡 start with: the card's remembered effort and model, else the default model, with Ultra
 * for the card's first planning (or the highest effort the model offers when it has no Ultra).
 */
export function useKickoffChoice(card: CardProjectView, firstPlanning: boolean) {
  const { data } = useApp();
  const saved = data.projects.find(project => project.id === card.projectId)?.cardSettings?.kickoff;
  const fallback = (data.gateways.find(item => item.id === data.preferences.defaultGatewayId) ?? data.gateways[0])?.id ?? '';
  const gatewayId = saved?.gatewayId && data.gateways.some(item => item.id === saved.gatewayId) ? saved.gatewayId : fallback;
  const gateway = selectedModel(data.gateways.find(item => item.id === gatewayId), saved?.gatewayId === gatewayId ? saved.modelId : gatewayId === data.preferences.defaultGatewayId ? data.preferences.defaultModelId : undefined);
  const efforts: ThinkingLevel[] = gateway ? availableEfforts(gateway) : ['off'];
  const preferred = saved?.thinking ?? (firstPlanning ? 'ultra' : data.preferences.defaultThinking);
  const thinking = efforts.includes(preferred) ? preferred : efforts[efforts.length - 1] ?? 'off';
  return { gatewayId, modelId: gateway?.modelId, thinking, efforts, ready: !!gateway };
}

/** The effort and model beside the kickoff buttons; each change is remembered for this card. */
export function KickoffOptions({ card, choice }: { card: CardProjectView; choice: ReturnType<typeof useKickoffChoice> }) {
  const { api, t, run } = useApp();
  const save = (kickoff: Kickoff) => void run(() => api.saveCardSettings(card.projectId, { kickoff }));
  return <div className="cs-kickoff-options">
    <label className="cs-kickoff-field"><span>{t('Effort', '思考强度')}</span>
      <select value={choice.thinking} disabled={!choice.ready} onChange={event => save({ thinking: event.target.value as ThinkingLevel })}>
        {choice.efforts.map(level => <option key={level} value={level}>{thinkingLabel(level, t)}</option>)}
      </select>
    </label>
    <span className="cs-kickoff-field"><span>{t('Model', '模型')}</span>
      <ModelPicker gatewayId={choice.gatewayId} modelId={choice.modelId} onChange={(gatewayId, modelId) => save({ gatewayId, modelId })} />
    </span>
    {choice.thinking === 'ultra' && <p className="cs-kickoff-note">{t('Ultra sends a squad to read the material; it costs noticeably more.', 'Ultra 会派小队读资料，花费明显更高。')}</p>}
  </div>;
}
