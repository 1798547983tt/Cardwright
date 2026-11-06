import { useEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, LoaderCircle, Plus, RefreshCw, Search, Star, Trash2, X } from 'lucide-react';
import type { Gateway, GatewayModel, GatewaySelfTest, ThinkingLevel } from '../shared/types';
import { GATEWAY_PRESETS, isLoopback, type GatewayPreset } from '../shared/gateway-presets';
import { gatewayModels } from '../shared/gateway-models';
import { GATEWAY_UPSTREAMS, UPSTREAM_LABELS, detectUpstream, type GatewayUpstream } from '../shared/gateway-upstream';
import { useApp } from './context';
import { Field, IconButton, Modal } from './primitives';
import { thinkingLabel, thinkingLevels } from './effort';
import { defaultEffortMap } from '../shared/effort';
import { STALL_SECONDS, validStall } from '../shared/gateway-traffic';
import { CODEX_PROXY_CONTEXT, UNMATCHED_CONTEXT, UNMATCHED_OUTPUT, applyModelMatch, looksLikeChatGpt, unmatchedModelDefaults, type ModelMatch } from '../shared/model-metadata';

const blankModel = (id: string, name: string | undefined, autoMatch: boolean): GatewayModel => ({
  id, ...(name && name !== id ? { name } : {}), reasoning: false, effortMap: { ...defaultEffortMap },
  contextWindow: UNMATCHED_CONTEXT, maxTokens: Math.min(UNMATCHED_OUTPUT, UNMATCHED_CONTEXT),
  autoMatch, inputModalities: ['text', 'image'],
});

export function GatewayEditor({ gateway, onClose }: { gateway?: Gateway; onClose: () => void }) {
  const { data, api, t, run } = useApp();
  const autoMatchMode = data.preferences.modelAutoMatch ?? 'online';
  /** A new model starts auto-matched unless the user turned the default off; local mode never goes online. */
  const autoMatchDefault = autoMatchMode !== 'off';
  const allowNetwork = autoMatchMode !== 'local';
  const [connection, setConnection] = useState(gateway
    ? { id: gateway.id, name: gateway.name, baseUrl: gateway.baseUrl, protocol: gateway.protocol, upstream: gateway.upstream ?? 'auto' as GatewayUpstream }
    : { id: crypto.randomUUID(), name: '', baseUrl: '', protocol: 'openai-completions' as Gateway['protocol'], upstream: 'auto' as GatewayUpstream });
  const [rateLimit, setRateLimit] = useState(gateway?.rateLimit ?? { enabled: false, perMinute: 20 });
  const [retries, setRetries] = useState(gateway?.retry?.maxRetries ?? 2);
  // 无响应断开: whole seconds, kept as typed so that an empty field means off.
  const [stall, setStall] = useState(gateway?.stall ? String(gateway.stall.seconds) : '');
  const [models, setModels] = useState<GatewayModel[]>(() => gateway ? gatewayModels(gateway).map(model => ({
    ...model,
    // `inputModalities` is only written once a model has been through matching. Without it,
    // the model predates this feature (or was saved before its first lookup), so leave it
    // editable instead of claiming a match that never ran.
    autoMatch: model.inputModalities === undefined ? false : (model.autoMatch ?? autoMatchDefault),
    effortMap: { ...defaultEffortMap, ...model.effortMap },
  })) : []);
  const [defaultId, setDefaultId] = useState(gateway?.modelId || '');
  const [selectedId, setSelectedId] = useState(gateway?.modelId || '');
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Array<{ id: string; name?: string }>>([]);
  const [fetching, setFetching] = useState(false); const [modelError, setModelError] = useState(''); const [loaded, setLoaded] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(!gateway); const [query, setQuery] = useState(''); const [selectedCatalog, setSelectedCatalog] = useState<string[]>([]);
  const [manualId, setManualId] = useState(''); const [formError, setFormError] = useState('');
  /** models.dev results by model id; `undefined` means "not looked up yet", `null` means "no match". */
  const [matches, setMatches] = useState<Record<string, ModelMatch | null>>({});
  const [manualMatch, setManualMatch] = useState<ModelMatch | null | undefined>(undefined);
  const codexOriginal = useRef<Record<string, number>>({});
  const request = useRef(0); const manualRequest = useRef(0); const active = models.find(model => model.id === selectedId);
  const autoMatched = active?.autoMatch === true;
  // A Codex reverse proxy keeps its window editable even while everything else is auto-matched.
  const contextLocked = autoMatched && !active?.codexProxy;
  // Local services (本地模型, 本地代理网关) live on this computer; a model server rarely checks a key.
  const [preset, setPreset] = useState<GatewayPreset | null>(null); const [selfTest, setSelfTest] = useState<GatewaySelfTest | null>(null); const [testing, setTesting] = useState(false);
  const local = isLoopback(connection.baseUrl.trim());
  const detected = detectUpstream(connection.baseUrl.trim());
  const validConnection = /^https?:\/\/[^\s]+$/i.test(connection.baseUrl.trim()) && (!!key.trim() || !!gateway?.hasKey || local);
  const shownCatalog = catalog.filter(model => `${model.id} ${model.name || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const existing = new Set(models.map(model => model.id));
  async function fetchModels() {
    if (!validConnection) return; const sequence = ++request.current; setFetching(true); setModelError('');
    try { const result = await api.fetchModels({ ...(gateway ? { id: gateway.id } : {}), baseUrl: connection.baseUrl.trim(), protocol: connection.protocol }, key || undefined); if (sequence !== request.current) return; setCatalog(result); setLoaded(true); }
    catch { if (sequence === request.current) { setCatalog([]); setLoaded(false); setModelError(t('The model list could not be loaded. Check the connection or add model IDs below.', '未能读取模型列表。请检查连接，或在下方手动添加模型 ID。')); } }
    finally { if (sequence === request.current) setFetching(false); }
  }
  useEffect(() => { request.current++; setCatalog([]); setSelectedCatalog([]); setLoaded(false); setModelError(''); setFetching(false); if (!validConnection) return; const timer = setTimeout(() => void fetchModels(), 800); return () => { clearTimeout(timer); request.current++; }; }, [connection.baseUrl, connection.protocol, key]);
  // Manual model IDs are matched after a short pause so a partial name does not trigger a lookup per keystroke.
  useEffect(() => {
    const id = manualId.trim();
    setManualMatch(undefined);
    if (!id || !autoMatchDefault) return;
    // The preview only reads the bundled snapshot, so typing does not download the catalog.
    // The sequence keeps a slower, older response from replacing the latest one.
    const sequence = ++manualRequest.current;
    const timer = setTimeout(() => {
      void api.matchModel({ modelId: id, allowNetwork: false })
        .then(result => { if (sequence === manualRequest.current) setManualMatch(result); })
        .catch(() => { if (sequence === manualRequest.current) setManualMatch(null); });
    }, 450);
    return () => { clearTimeout(timer); manualRequest.current++; };
  }, [manualId, autoMatchDefault]);
  function addModels(items: Array<{ id: string; name?: string }>) {
    const additions = items.map(item => ({ ...item, id: item.id.trim() })).filter((item, index, all) => item.id && !existing.has(item.id) && all.findIndex(other => other.id === item.id) === index).map(item => blankModel(item.id, item.name, autoMatchDefault));
    if (!additions.length) return;
    setModels(current => [...current, ...additions]); setSelectedId(additions[0].id); if (!defaultId) setDefaultId(additions[0].id); setSelectedCatalog([]); setFormError('');
    // A newly added model is matched once; editing an existing one never re-runs this.
    for (const addition of additions) if (addition.autoMatch !== false) void autoMatchModel(addition.id);
  }
  function addManual() { if (!manualId.trim()) return; if (existing.has(manualId.trim())) { setSelectedId(manualId.trim()); setFormError(t('This model is already in the gateway.', '此模型已添加到网关。')); return; } addModels([{ id: manualId }]); setManualId(''); setManualMatch(undefined); }
  /** Silent by design: unmatched or offline models keep or receive safe defaults. */
  async function autoMatchModel(id: string): Promise<void> {
    const result = await api.matchModel({ modelId: id, allowNetwork }).catch(() => null);
    setMatches(current => ({ ...current, [id]: result }));
    if (!result) {
      setModels(current => current.map(model => model.id === id && model.autoMatch !== false ? unmatchedModelDefaults(model) : model));
      return;
    }
    setModels(current => current.map(model => model.id === id ? applyModelMatch(model, result) : model));
  }
  function toggleAutoMatch(enabled: boolean) {
    if (!active) return;
    updateModel('autoMatch', enabled);
    if (enabled) void autoMatchModel(active.id);
  }
  /** Codex reverse proxies front a 258K window; the original value is restored on uncheck. */
  function toggleCodexProxy(enabled: boolean) {
    if (!active) return;
    if (enabled) codexOriginal.current[active.id] = active.contextWindow;
    const original = codexOriginal.current[active.id];
    const contextWindow = enabled ? CODEX_PROXY_CONTEXT : (original ?? active.contextWindow);
    setModels(current => current.map(model => model.id === active.id
      ? { ...model, codexProxy: enabled, contextWindow, maxTokens: Math.min(model.maxTokens, contextWindow) }
      : model));
    setFormError('');
  }
  function updateModel<K extends keyof GatewayModel>(name: K, next: GatewayModel[K]) { setModels(current => current.map(model => model.id === selectedId ? { ...model, [name]: next } : model)); setFormError(''); }
  /** The Codex window stays editable while max output is filled in, so keep the two in step. */
  function changeContextWindow(value: number) {
    if (!active) return;
    setModels(current => current.map(model => model.id === active.id
      ? { ...model, contextWindow: value, maxTokens: Number.isFinite(value) && value > 0 ? Math.min(model.maxTokens, value) : model.maxTokens }
      : model));
    setFormError('');
  }
  function removeModel(id: string) { const next = models.filter(model => model.id !== id); setModels(next); if (defaultId === id) setDefaultId(next[0]?.id || ''); if (selectedId === id) setSelectedId(next[0]?.id || ''); }
  function setMapping(level: ThinkingLevel, providerValue: string) { if (!active) return; const next = { ...active.effortMap }; if (providerValue.trim()) next[level] = providerValue.trim(); else delete next[level]; updateModel('effortMap', next); }
  function usePreset(next: GatewayPreset) {
    setPreset(next); setSelfTest(null);
    setConnection(current => ({ ...current, name: current.name.trim() ? current.name : t(next.name.en, next.name.zh), protocol: next.protocol, baseUrl: next.addresses[0].url }));
  }
  /** 一键自检: the model list, then one completion of a single token to the default model. */
  async function runSelfTest() {
    const modelId = defaultId || models[0]?.id; if (!modelId || !validConnection) return;
    setTesting(true); setSelfTest(null);
    const result = await run(() => api.selfTestGateway({ ...(gateway ? { id: gateway.id } : {}), baseUrl: connection.baseUrl.trim(), protocol: connection.protocol, modelId }, key.trim() || (local && !gateway?.hasKey ? 'local' : undefined)));
    if (result) setSelfTest(result); setTesting(false);
  }
  async function save() {
    if (!models.length) { setFormError(t('Add at least one model before saving.', '至少添加一个模型后再保存。')); return; }
    const invalid = models.find(model => model.contextWindow < 1024 || model.contextWindow > 10000000 || model.maxTokens < 1 || model.maxTokens > model.contextWindow);
    if (invalid) { setSelectedId(invalid.id); setFormError(t('Check the context window and output limit for', '请检查此模型的上下文与输出上限：') + ' ' + invalid.id); return; }
    const stallSeconds = stall.trim() ? Number(stall) : undefined;
    if (stallSeconds !== undefined && !validStall({ seconds: stallSeconds })) { setFormError(t('Disconnect when silent takes a whole number of seconds from 15 to 300, or leave it empty.', '无响应断开要填 15 到 300 之间的整数秒，或者留空。')); return; }
    setBusy(true);
    const cleaned = models.map(model => { const effortMap = { ...model.effortMap }; if (connection.protocol === 'anthropic-messages' && !model.adaptiveThinking) for (const level of ['xhigh', 'max', 'ultra'] as const) delete effortMap[level]; return { ...model, effortMap }; });
    const selectedDefault = cleaned.find(model => model.id === defaultId) || cleaned[0]; const { id: modelId, name: _modelName, ...capabilities } = selectedDefault;
    // A local service without a key gets the placeholder “local”, which model servers accept and ignore.
    const savedKey = key || (local && !gateway?.hasKey ? 'local' : undefined);
    const result = await run(async () => { await api.saveGateway({ ...connection, name: connection.name.trim(), baseUrl: connection.baseUrl.trim(), modelId, ...capabilities, models: cleaned, rateLimit, retry: { maxRetries: retries }, ...(stallSeconds !== undefined ? { stall: { seconds: stallSeconds } } : {}) }, savedKey); return true; }, t('Gateway saved', '网关已保存'));
    setBusy(false); if (result) onClose();
  }
  return <Modal title={gateway ? t('Edit gateway', '编辑网关') : t('Connect a model gateway', '连接模型网关')} onClose={() => { if (!busy) onClose(); }} className="gateway-modal gateway-multi-modal">
    <p className="modal-intro">{t('One connection, multiple models. Add the models you want and configure each separately.', '一个连接，多个模型。添加需要的模型，再分别调整配置。')}</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy} className="gateway-form-fields">
      {!gateway && <section className="gateway-presets" aria-label={t('Presets', '预设')}>
        <div className="gateway-preset-choices"><span>{t('Presets', '预设')}</span>{GATEWAY_PRESETS.map(item => <button key={item.id} type="button" className={`gateway-preset ${preset?.id === item.id ? 'active' : ''}`} aria-pressed={preset?.id === item.id} onClick={() => usePreset(item)}>{t(item.name.en, item.name.zh)}</button>)}{preset && <IconButton label={t('Clear the preset', '不用预设')} onClick={() => setPreset(null)}><X size={13} /></IconButton>}</div>
        {preset && <><div className="gateway-preset-addresses" role="group" aria-label={t('Address', '地址')}>{preset.addresses.map(address => <button key={address.url} type="button" aria-pressed={connection.baseUrl === address.url} onClick={() => setConnection(current => ({ ...current, baseUrl: address.url }))}>{address.label}<small>{address.url}</small></button>)}</div><p className="gateway-preset-note">{t(preset.note.en, preset.note.zh)}</p></>}
      </section>}
      <div className="form-grid"><Field label={t('Gateway name', '网关名称')}><input autoFocus required value={connection.name} onChange={event => setConnection(current => ({ ...current, name: event.target.value }))} placeholder={t('My gateway', '我的网关')} /></Field><Field label={t('API protocol', 'API 协议')}><select value={connection.protocol} onChange={event => setConnection(current => ({ ...current, protocol: event.target.value as Gateway['protocol'] }))}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></Field></div>
      <div className="form-grid gateway-connection-grid"><Field label="Base URL" hint={connection.protocol === 'anthropic-messages' ? t('Service origin without /v1.', '填写不含 /v1 的服务地址。') : t('API root, usually ending in /v1.', '填写 API 根路径，通常以 /v1 结尾。')}><input type="url" required value={connection.baseUrl} onChange={event => setConnection(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://your-gateway.example/v1" spellCheck={false} /></Field><Field label="API key" hint={gateway?.hasKey ? t('Leave blank to keep the saved key.', '留空则保留已保存的密钥。') : t('Shared by all models in this gateway.', '此网关下所有模型共用此密钥。')}><input type="password" required={!gateway?.hasKey && !local} autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder={gateway?.hasKey ? '••••••••••••••••' : local ? t('Optional on this computer', '本机服务可以不填') : t('Enter your API key', '输入 API 密钥')} /></Field></div>
      {connection.protocol !== 'anthropic-messages' && <Field
        label={t('Upstream service', '上游服务商')}
        hint={connection.upstream !== 'auto'
          ? t('Requests carry the fields this service accepts, whatever the address looks like.', '不论地址写的是什么，都按这家服务接受的参数发送。')
          : detected
            ? `${t('Recognised from the address:', '已从地址识别：')} ${t(UPSTREAM_LABELS[detected].en, UPSTREAM_LABELS[detected].zh)}`
            : t('This address is not a recognised vendor, so only widely accepted fields are sent. Behind a local relay or proxy, name the real service here.', '这个地址不是已知服务商，只发送通用参数。接本地轮询或中转时，请直接选出后面真正的服务商。')}>
        <select value={connection.upstream} onChange={event => setConnection(current => ({ ...current, upstream: event.target.value as GatewayUpstream }))}>
          {GATEWAY_UPSTREAMS.map(id => <option key={id} value={id}>{t(UPSTREAM_LABELS[id].en, UPSTREAM_LABELS[id].zh)}</option>)}
        </select>
      </Field>}
      <details className="reasoning-capabilities gateway-traffic"><summary><span>{t('Request rate and retries', '请求速率与重试')}</span><ChevronDown size={14} /></summary>
        <label className="checkbox-row"><input type="checkbox" checked={rateLimit.enabled} onChange={event => setRateLimit({ ...rateLimit, enabled: event.target.checked })} /><span>{t('Limit requests per minute', '限制每分钟请求数')}<small>{t('Off by default. Some services already limit you; turn this on only if yours does not, or refuses bursts.', '默认关闭。有些服务自己就有限制；只在你的服务没有、或者一多就报错时才打开。')}</small></span></label>
        {rateLimit.enabled && <Field label={t('Requests per minute', '每分钟请求上限')} hint={t('Counted over any rolling 60 seconds, across every task, squad member and retry on this gateway. A request over the limit waits on this computer.', '按任意 60 秒计算，这个网关下所有任务、小队成员和重试都算在内。超出的请求在本机排队等待。')}>
          <input type="number" min={1} max={10000} value={rateLimit.perMinute} onChange={event => setRateLimit({ ...rateLimit, perMinute: Math.max(1, Math.min(10000, Number(event.target.value) || 1)) })} />
        </Field>}
        <Field label={t('Retries after a failed request', '请求失败后的重试次数')} hint={t('Applies to timeouts, rate limits and server errors. When the service answers 429, the whole gateway pauses for as long as it asks.', '适用于超时、限流和服务器错误。服务器回 429 时，整个网关按它给的时间一起暂停。')}>
          <input type="number" min={0} max={10} value={retries} onChange={event => setRetries(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} />
        </Field>
        <Field label={t('Disconnect when silent (seconds)', '无响应断开（秒）')} hint={t('Empty means off. A model that thinks for a long time without streaming any output can be mistaken for a stall.', '留空为关。模型长时间思考、没有输出时，可能被误判为卡住。')}>
          <input type="number" min={STALL_SECONDS.min} max={STALL_SECONDS.max} step={1} value={stall} placeholder={t('Off', '关')} onChange={event => { setStall(event.target.value); setFormError(''); }} />
        </Field>
      </details>
      <section className="gateway-model-section" aria-label={t('Gateway models', '网关模型')}>
        <div className="model-discovery-heading"><h3>{t('Models', '模型')} <span className="badge">{models.length}</span></h3><button type="button" className="button small" aria-expanded={catalogOpen} onClick={() => setCatalogOpen(!catalogOpen)}><Plus size={14} />{t('Add models', '添加模型')}<ChevronDown size={13} className={catalogOpen ? 'rotated' : ''} /></button></div>
        {catalogOpen && <div className="gateway-catalog">
          <div className="gateway-catalog-tools"><label className="model-menu-search"><Search size={15} /><input aria-label={t('Search available models', '搜索可用模型')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search available models', '搜索可用模型')} /></label><button type="button" className="text-button" disabled={fetching || !validConnection} onClick={() => void fetchModels()}><RefreshCw size={13} className={fetching ? 'spinning' : ''} />{t('Refresh models', '刷新模型列表')}</button></div>
          <div className="model-discovery-status" role="status">{fetching ? <><LoaderCircle size={13} className="spinning" />{t('Reading available models…', '正在读取可用模型…')}</> : modelError ? <span className="model-discovery-error">{modelError}</span> : loaded ? `${catalog.length} ${t('available models · select multiple to add', '个可用模型 · 可多选添加')}` : t('The list loads after the URL and key are ready.', '连接地址和密钥填好后会自动读取列表。')}</div>
          {!!shownCatalog.length && <div className="gateway-catalog-list">{shownCatalog.map(model => <label key={model.id} className={existing.has(model.id) ? 'already-added' : ''}><input type="checkbox" aria-label={`${t('Select model', '选择模型')} ${model.id}`} checked={existing.has(model.id) || selectedCatalog.includes(model.id)} disabled={existing.has(model.id)} onChange={event => setSelectedCatalog(current => event.target.checked ? [...current, model.id] : current.filter(id => id !== model.id))} /><span title={model.id}>{model.name || model.id}{model.name && model.name !== model.id && <small>{model.id}</small>}</span>{existing.has(model.id) && <small>{t('Added', '已添加')}</small>}</label>)}</div>}
          {loaded && !shownCatalog.length && <p className="model-menu-empty">{t('No matches. Add a model ID manually below.', '没有匹配项，可在下方手动添加模型 ID。')}</p>}
          <div className="gateway-catalog-actions"><button type="button" className="text-button" disabled={!shownCatalog.some(model => !existing.has(model.id))} onClick={() => setSelectedCatalog(current => [...new Set([...current, ...shownCatalog.filter(model => !existing.has(model.id)).map(model => model.id)])])}>{t('Select visible models', '选择当前结果')}</button><button type="button" className="button small primary" disabled={!selectedCatalog.length} onClick={() => { addModels(catalog.filter(model => selectedCatalog.includes(model.id))); setCatalogOpen(false); }}>{t('Add selected', '添加所选模型')}{selectedCatalog.length > 0 && ` (${selectedCatalog.length})`}</button></div>
          <div className="gateway-manual-add"><input aria-label={t('Model ID', '模型 ID')} value={manualId} onChange={event => setManualId(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual(); } }} placeholder={t('Or enter a model ID manually', '也可以手动输入模型 ID')} spellCheck={false} /><button type="button" className="button small" disabled={!manualId.trim()} onClick={addManual}><Plus size={14} />{t('Add model ID', '添加模型 ID')}</button></div>
          {manualMatch && <p className="model-match-hint" role="status">{t('Matched', '匹配到')} <strong>{manualMatch.matchedId}</strong>{manualMatch.method === 'fuzzy' && <> · {Math.round(manualMatch.confidence * 100)}%</>}</p>}
        </div>}
        {models.length > 0 ? <div className="gateway-model-workspace"><div className="gateway-model-navigation" aria-label={t('Added models', '已添加模型')}>{models.map(model => <button type="button" key={model.id} className={`gateway-model-tab ${model.id === selectedId ? 'active' : ''}`} aria-pressed={model.id === selectedId} onClick={() => setSelectedId(model.id)}><span><strong title={model.id}>{model.name || model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}<small>{model.id === defaultId ? t('Default model', '默认模型') : `${model.contextWindow >= 1000000 ? '1M' : `${model.contextWindow / 1000}K`} · ${model.reasoning ? t('Reasoning', '推理') : t('Standard', '标准')}`}</small></span>{model.id === defaultId && <Star size={13} fill="currentColor" />}</button>)}</div>
          {active && <div className="gateway-model-detail"><div className="gateway-model-detail-heading"><h4 title={active.id}>{active.id}</h4><button type="button" className="text-button" disabled={defaultId === active.id} onClick={() => setDefaultId(active.id)}><Star size={13} fill={defaultId === active.id ? 'currentColor' : 'none'} />{defaultId === active.id ? t('Default', '默认') : t('Set default', '设为默认')}</button><IconButton label={`${t('Remove model', '移除模型')} ${active.id}`} onClick={() => removeModel(active.id)}><Trash2 size={15} /></IconButton></div>
            <Field label={t('Display name (optional)', '显示名称（可选）')}><input value={active.name || ''} onChange={event => updateModel('name', event.target.value)} placeholder={active.id} /></Field>
    <div className="model-auto-match">
      <label className="checkbox-row"><input type="checkbox" checked={active.autoMatch === true} onChange={event => toggleAutoMatch(event.target.checked)} /><span>{t('Fill model parameters automatically', '自动匹配模型参数')}<small>{t('Reads them from models.dev. Uncheck to edit.', '从 models.dev 读取，取消勾选后可编辑。')}</small></span></label>
      <label className="checkbox-row"><input type="checkbox" checked={!!active.codexProxy} onChange={event => toggleCodexProxy(event.target.checked)} /><span>{t('From a Codex reverse proxy', '来自 Codex 反代')}<small>{looksLikeChatGpt(active.id)
        ? t('Detected ChatGPT family. Check this if it is reached through a Codex proxy; the 258K window stays editable.', '已识别为 ChatGPT 系列。经 Codex 反代转发时勾选；258K 窗口保持可编辑。')
        : t('Check this when the model is reached through a Codex proxy. The 258K window stays editable.', '模型经 Codex 反代转发时勾选；258K 窗口保持可编辑。')}</small></span></label>
      {active.autoMatch === true && matches[active.id] && <p className="model-match-note" role="status" title={matches[active.id]!.generatedAt}>{t('Parameters from models.dev', '参数来自 models.dev')}{matches[active.id]!.matchedId !== active.id && <> · {matches[active.id]!.matchedId}</>}</p>}
      {matches[active.id] === null && active.autoMatch === true && <p className="model-match-note is-miss" role="status">{autoMatchMode === 'local'
        ? t('Not in the bundled data; safe defaults are filled in. Switch to online matching in Settings, or uncheck the box to edit.', '内置数据中没有这个模型，已填入默认值。可在设置中改为联网匹配，或取消勾选后手动填写。')
        : t('No models.dev match; safe defaults are filled in. Uncheck “Fill model parameters automatically” to edit them.', 'models.dev 中没有这个模型，已填入默认值。取消勾选「自动匹配模型参数」后可手动填写。')}</p>}
      <p id="auto-match-lock-hint" className="sr-only">{t('Auto-match is on. Uncheck “Fill model parameters automatically” to edit these fields.', '自动匹配已开启。取消勾选「自动匹配模型参数」后可编辑这些字段。')}</p>
    </div>
    <div className="form-grid"><div className={`context-window-field${contextLocked ? ' model-auto-locked' : ''}`} title={contextLocked ? t('Auto-match is on. Uncheck to edit.', '自动匹配已开启，取消勾选后可编辑。') : undefined}><Field label={t('Context window (tokens)', '上下文窗口（Token）')}><input aria-label={t('Context window (tokens)', '上下文窗口（Token）')} aria-describedby={contextLocked ? 'context-window-hint auto-match-lock-hint' : 'context-window-hint'} type="number" min={1024} max={10000000} required disabled={active.autoMatch === true && !active.codexProxy} value={active.contextWindow} onChange={event => changeContextWindow(Number(event.target.value))} /></Field><div className="context-presets" role="group" aria-label={t('Context window presets', '上下文窗口预设')}>{[300000, 500000, 1000000].map(size => <button key={size} type="button" disabled={active.autoMatch === true && !active.codexProxy} aria-pressed={active.contextWindow === size} onClick={() => changeContextWindow(size)}>{size === 1000000 ? '1M' : `${size / 1000}K`}</button>)}</div><small id="context-window-hint">{t('The conversation compacts automatically near 90% of this window.', '对话接近窗口的 90% 时自动压缩。')}</small></div><div className={autoMatched ? 'model-auto-locked' : undefined} title={autoMatched ? t('Auto-match is on. Uncheck to edit.', '自动匹配已开启，取消勾选后可编辑。') : undefined}><Field label={t('Maximum output tokens', '最大输出 Token')} hint={t('Reasoning and the answer share this limit.', '思考与正文共用这个上限。')}><input type="number" min={1} max={active.contextWindow} required disabled={active.autoMatch === true} aria-describedby={autoMatched ? 'auto-match-lock-hint' : undefined} value={active.maxTokens} onChange={event => updateModel('maxTokens', Number(event.target.value))} /></Field></div></div>
    <details className="reasoning-capabilities model-pricing"><summary><span>{t('Usage pricing', '用量单价')}</span><ChevronDown size={14} /></summary><label className="checkbox-row"><input type="checkbox" checked={!!active.pricing} onChange={event => updateModel('pricing', event.target.checked ? { currency: 'USD', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined)} /><span>{t('Configure model rates', '配置模型单价')}</span></label>{active.pricing && <><p>{t('Rates per one million tokens. Use the same currency across squad models for a comparable cost budget.', '每 100 万 Token 的价格。小队模型请使用相同币种，便于统一计算金额预算。')}</p><Field label={t('Currency', '币种')}><input maxLength={3} value={active.pricing.currency} onChange={event => updateModel('pricing', { ...active.pricing!, currency: event.target.value.toUpperCase() })} /></Field><div className="form-grid">{([{ key: 'input', label: t('Input', '输入') }, { key: 'output', label: t('Output', '输出') }, { key: 'cacheRead', label: t('Cache read', '缓存读取') }, { key: 'cacheWrite', label: t('Cache write', '缓存写入') }] as const).map(item => <Field key={item.key} label={item.label}><input type="number" min={0} step="any" value={active.pricing![item.key]} onChange={event => updateModel('pricing', { ...active.pricing!, [item.key]: Number(event.target.value) })} /></Field>)}</div></>}</details>
    <label className={`checkbox-row${autoMatched ? ' model-auto-locked' : ''}`} title={autoMatched ? t('Auto-match is on. Uncheck to edit.', '自动匹配已开启，取消勾选后可编辑。') : undefined}><input type="checkbox" checked={active.reasoning} disabled={active.autoMatch === true} aria-describedby={autoMatched ? 'auto-match-lock-hint' : undefined} onChange={event => updateModel('reasoning', event.target.checked)} /><span>{t('This model supports reasoning', '此模型支持推理')}<small>{t('Enables the effort control in conversations.', '在对话中启用思考强度控制。')}</small></span></label>
    {active.autoMatch === true && matches[active.id]?.reasoningNote && <p className="model-match-note">{t('This model only offers an on/off thinking switch, which the effort control cannot drive, so reasoning is off. Uncheck the box to change it.', '此模型只支持开关式思考，思考强度控件无法使用，已关闭推理。取消勾选后可手动开启。')}</p>}
    {active.reasoning && <details className="reasoning-capabilities"><summary><span>{t('Reasoning capabilities', '思考强度能力')}</span><ChevronDown size={14} /></summary><p>{t('Defaults: low / medium / high / xhigh / max / max. Ultra also enables coordinated agent squads. Ultra is fixed to max; other values can be adjusted for your gateway.', '默认值为 low / medium / high / xhigh / max / max。Ultra 固定使用 max 并启用子代理小队；其余档位可按网关调整。')}</p>{connection.protocol === 'anthropic-messages' && <label className={`checkbox-row${autoMatched ? ' model-auto-locked' : ''}`}><input type="checkbox" checked={!!active.adaptiveThinking} disabled={active.autoMatch === true} onChange={event => updateModel('adaptiveThinking', event.target.checked)} /><span>{t('Adaptive thinking', '自适应思考')}<small>{t('Required for the additional effort levels on this protocol.', '此协议使用更高强度时需要启用。')}</small></span></label>}<div className={`effort-mapping-grid${autoMatched ? ' model-auto-locked' : ''}`}>{thinkingLevels.map(level => <Field key={level} label={thinkingLabel(level, t)}><input aria-label={`${thinkingLabel(level, t)} ${t('provider value', '网关参数值')}`} value={level === 'ultra' ? (active.effortMap?.ultra === null ? '' : active.effortMap?.ultra ?? 'max') : active.effortMap?.[level] ?? ''} readOnly={level === 'ultra'} title={level === 'ultra' ? t('Ultra uses max reasoning and adds a coordinated agent squad.', 'Ultra 固定使用 max，并增加主代理统筹的子代理小队。') : undefined} placeholder={level === 'ultra' ? 'max' : level} disabled={active.autoMatch === true || (['xhigh', 'max', 'ultra'].includes(level) && connection.protocol === 'anthropic-messages' && !active.adaptiveThinking)} onChange={event => setMapping(level, event.target.value)} /></Field>)}</div></details>}
    <label className="checkbox-row"><input type="checkbox" checked={!!active.nativeSearch?.enabled} onChange={event => updateModel('nativeSearch', { ...active.nativeSearch, enabled: event.target.checked })} /><span>{t('This model supports native web search', '此模型支持原生联网搜索')}<small>{t('Reuses this connection’s API key on compatible gateways.', '在兼容网关上复用此连接的 API 密钥。')}</small></span></label>{active.nativeSearch?.enabled && <Field label={t('Responses endpoint override (optional)', 'Responses 端点覆盖（可选）')} hint={t('Must use the same origin as the gateway URL.', '必须与网关地址同源。')}><input type="url" value={active.nativeSearch.responsesUrl || ''} onChange={event => updateModel('nativeSearch', { enabled: true, responsesUrl: event.target.value })} placeholder="https://your-gateway.example/v1/responses" spellCheck={false} /></Field>}
          </div>}
        </div> : <div className="gateway-model-empty">{t('Add models from the list above, or enter a model ID.', '从上方列表添加模型，也可以手动填写模型 ID。')}</div>}
      </section>
      {selfTest && <div className={`gateway-self-test ${selfTest.ok ? 'is-ok' : 'is-failed'}`} role="status">{selfTest.steps.map(step => <p key={step.step}>{step.ok ? <Check size={13} /> : <X size={13} />}<b>{step.step === 'models' ? t('Model list', '模型列表') : t('One-token completion', '一次极短补全')}</b><span>{step.ok ? step.step === 'models' ? step.detail.replace(' models', t(' models', ' 个模型')) : t(`replied “${step.detail}”`, `回复了“${step.detail}”`) : step.detail}</span><small>{step.ms} ms</small></p>)}</div>}
      {formError && <p className="gateway-form-error" role="alert">{formError}</p>}
      <div className="modal-actions gateway-save-actions"><span>{models.length} {t('models · one shared connection', '个模型 · 共用一个连接')}</span><button type="button" className="button" disabled={testing || !validConnection || !models.length} title={t('Lists the models, then sends one completion of a single token to the default model.', '先读模型列表，再给默认模型发一次只生成一个 Token 的补全。')} onClick={() => void runSelfTest()}>{testing ? <LoaderCircle size={14} className="spinning" /> : <Activity size={14} />}{t('Self-test', '一键自检')}</button><button type="button" className="button" onClick={onClose}>{t('Cancel', '取消')}</button><button className="button primary" disabled={!models.length}>{busy ? t('Saving…', '保存中…') : t('Save gateway', '保存网关')}</button></div>
    </fieldset></form>
  </Modal>;
}
