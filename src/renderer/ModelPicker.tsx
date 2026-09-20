import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search, Server, SlidersHorizontal } from 'lucide-react';
import { gatewayModels } from '../shared/gateway-models';
import { selectedModel } from './model-resolution';
import { useApp } from './context';
import { IconButton, Popover } from './primitives';

export function ModelPicker({ gatewayId, modelId, disabled = false, onChange }: { gatewayId: string; modelId?: string; disabled?: boolean; onChange: (gatewayId: string, modelId: string) => void | Promise<unknown> }) {
  const { data, t } = useApp();
  const gateway = data.gateways.find(item => item.id === gatewayId);
  const model = selectedModel(gateway, modelId);
  return <Popover label={t('Choose model', '选择模型')} align="right" className="model-picker" trigger={<><small className="module-label">{t('Model', '模型')}</small><span className="selected-model-label" title={gateway ? `${gateway.name} / ${model?.modelId || modelId || ''}` : undefined}>{model?.modelId || modelId || t('Connect a model', '连接模型')}</span>{modelId && !model && <small className="model-unavailable">{t('Unavailable', '不可用')}</small>}<ChevronDown size={12} /></>}>{close => <ModelMenu gatewayId={gatewayId} modelId={model?.modelId || modelId} disabled={disabled} close={close} onChange={onChange} />}</Popover>;
}

function ModelMenu({ gatewayId, modelId, disabled, close, onChange }: { gatewayId: string; modelId?: string; disabled: boolean; close: () => void; onChange: (gatewayId: string, modelId: string) => void | Promise<unknown> }) {
  const { data, t, settings } = useApp();
  const [openedGateway, setOpenedGateway] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null); const list = useRef<HTMLDivElement>(null);
  const gateway = data.gateways.find(item => item.id === openedGateway);
  useEffect(() => { input.current?.focus(); }, [openedGateway]);
  const needle = query.trim().toLocaleLowerCase();
  const gateways = data.gateways.filter(item => item.name.toLocaleLowerCase().includes(needle));
  const models = gateway ? gatewayModels(gateway).filter(item => `${item.id} ${item.name || ''}`.toLocaleLowerCase().includes(needle)) : [];
  function back() { setOpenedGateway(null); setQuery(''); }
  function keys(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft' && gateway && event.target !== input.current) { event.preventDefault(); back(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (['Home', 'End'].includes(event.key) && event.target === input.current) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  return <div className="model-menu" onKeyDown={keys}>
    <div className="model-menu-heading">{gateway ? <><IconButton label={t('Back to gateways', '返回网关')} onClick={back}><ArrowLeft size={16} /></IconButton><span title={gateway.name}>{gateway.name}</span><small>{models.length}</small></> : <><Server size={16} /><span>{t('Choose a gateway', '选择网关')}</span></>}</div>
    <label className="model-menu-search"><Search size={15} /><input ref={input} aria-label={gateway ? t('Search models', '搜索模型') : t('Search gateways', '搜索网关')} value={query} onChange={event => setQuery(event.target.value)} placeholder={gateway ? t('Search this gateway’s models', '搜索此网关的模型') : t('Search gateways', '搜索网关')} /></label>
    <div ref={list} className="model-menu-list" aria-label={gateway ? t('Models', '模型') : t('Gateways', '网关')}>
      {gateway ? models.map(model => <button type="button" key={model.id} className="model-menu-row" disabled={disabled} aria-pressed={gateway.id === gatewayId && model.id === modelId} onClick={() => { void onChange(gateway.id, model.id); close(); }}><span><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}{model.id === gateway.modelId && <small>{t('Gateway default', '网关默认模型')}</small>}</span>{gateway.id === gatewayId && model.id === modelId && <Check size={16} />}</button>) : gateways.map(item => <button type="button" className="model-menu-row gateway-choice" key={item.id} onClick={() => { setOpenedGateway(item.id); setQuery(''); }}><span><strong>{item.name}</strong><small>{gatewayModels(item).length} {t('models', '个模型')}{item.id === gatewayId ? ` · ${modelId || item.modelId}` : ''}</small></span>{item.id === gatewayId && <span className="model-current-dot" aria-label={t('Current gateway', '当前网关')} />}<ChevronRight size={15} /></button>)}
      {!(gateway ? models : gateways).length && <p className="model-menu-empty">{query ? t('No matches. Try another name.', '没有匹配项，请尝试其他名称。') : gateway ? t('Add models in gateway settings.', '请在网关设置中添加模型。') : t('Add your first gateway to begin.', '先添加一个网关。')}</p>}
    </div>
    {disabled && <p className="menu-footnote">{t('Change models after the current run ends.', '本次执行结束后可切换模型。')}</p>}
    <button type="button" className="model-menu-settings" onClick={() => { close(); settings('code'); }}><SlidersHorizontal size={15} />{t('Manage gateways and models', '管理网关与模型')}</button>
  </div>;
}
