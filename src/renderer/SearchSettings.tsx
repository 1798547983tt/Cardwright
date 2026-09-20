import { useEffect, useState } from 'react';
import { Check, ExternalLink, Globe, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { SearchConfig } from '../shared/types';
import { useApp } from './context';
import { Field, Row, Toggle } from './primitives';

export function SearchSettings({ onConfigureGateway }: { onConfigureGateway: () => void }) {
  const { data, api, t, run } = useApp();
  const saved = data.search;
  const [config, setConfig] = useState<Omit<SearchConfig, 'hasKey'>>({ enabled: saved.enabled, provider: saved.provider, baseUrl: saved.baseUrl });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => { setConfig({ enabled: saved.enabled, provider: saved.provider, baseUrl: saved.baseUrl }); }, [saved.enabled, saved.provider, saved.baseUrl]);
  const dirty = key.length > 0 || config.enabled !== saved.enabled || config.provider !== saved.provider || config.baseUrl !== saved.baseUrl;
  function update(changes: Partial<typeof config>) { setConfig(current => ({ ...current, ...changes })); setResult(null); }
  async function save() {
    setBusy('save'); setResult(null);
    const done = await run(async () => { await api.saveSearch({ ...config, baseUrl: config.baseUrl.trim() }, key || undefined); return true; }, t('Search settings saved', '联网搜索设置已保存'));
    if (done) setKey(''); setBusy(null);
  }
  async function test() {
    setBusy('test'); setResult(null);
    const response = await run(() => api.testSearch());
    if (response) setResult(response); setBusy(null);
  }
  return <div className="search-settings"><div className="search-service-heading"><Globe size={28} /><div><h3>{t('Research, alongside your code', '让搜索加入你的工作流')}</h3><p>{t('Use gateway-native search when available, with a keyless Exa fallback across models.', '优先使用网关原生搜索，也可跨模型使用无需额外密钥的 Exa 服务。')}</p></div></div>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Row title={t('Web search', '联网搜索')} description={t('Make web search available to new agent runs.', '向新启动的 Agent 提供联网搜索工具。')}><Toggle checked={config.enabled} disabled={busy !== null} onChange={enabled => update({ enabled })} label={t('Enable web search', '启用联网搜索')} /></Row>
      <fieldset className="search-config-fields" disabled={busy !== null}><Field label={t('Search provider', '搜索服务')}><select aria-label={t('Search provider', '搜索服务')} value={config.provider} onChange={event => update({ provider: event.target.value as SearchConfig['provider'] })}><option value="auto">{t('Automatic · native, then Exa', '自动 · 原生优先，Exa 后备')}</option><option value="native">{t('Gateway-native search', '网关原生搜索')}</option><option value="exa">{t('Exa · no extra key', 'Exa · 无需额外密钥')}</option><option value="brave">Brave Search</option><option value="searxng">SearXNG</option></select></Field>
        {(config.provider === 'auto' || config.provider === 'native' || config.provider === 'exa') && <div className="search-route-note"><p>{config.provider === 'auto' ? t('Automatically use native search on a gateway with that capability enabled; otherwise use Exa. Native search failures can also fall back to Exa.', '已声明搜索能力的网关优先使用原生搜索，否则使用 Exa；原生搜索失败时也可回退到 Exa。') : config.provider === 'native' ? t('Use only the selected gateway’s search capability. Enable it in the gateway editor after checking provider support.', '仅使用所选网关的搜索能力。确认服务商支持后，在网关编辑器中启用。') : t('Use the Exa search service without an additional API key. Availability and rate limits depend on its public service.', '使用 Exa 搜索服务，无需额外 API 密钥。可用性与速率限制取决于其公共服务。')}</p>{config.provider !== 'exa' && <button className="text-button" type="button" onClick={onConfigureGateway}>{t('Configure gateway capability', '配置网关能力')}<ExternalLink size={13} /></button>}</div>}
        {config.provider === 'brave' && <><Field label={t('Brave Search API key', 'Brave Search API 密钥')} hint={saved.hasKey ? t('A key is saved securely. Leave blank to keep it.', '已安全保存密钥，留空保留。') : t('Use a Brave Search API subscription key. This is separate from your model gateway.', '使用 Brave Search API 订阅密钥，与模型网关密钥相互独立。')}><input type="password" aria-label={t('Brave Search API key', 'Brave Search API 密钥')} autoComplete="off" spellCheck={false} value={key} required={config.enabled && !saved.hasKey} placeholder={saved.hasKey ? '••••••••••••••••' : t('Enter a search API key', '输入搜索 API 密钥')} onChange={event => { setKey(event.target.value); setResult(null); }} /></Field><button type="button" className="text-button external-help" onClick={() => void run(() => api.openExternal('https://brave.com/search/api/'))}>{t('Brave Search API', 'Brave Search API')}<ExternalLink size={13} /></button></>}
        {config.provider === 'searxng' && <><Field label={t('SearXNG instance URL', 'SearXNG 实例地址')} hint={t('Use an instance you control or have permission to use, with its JSON search API enabled.', '使用你拥有或获准使用的实例，并启用 JSON 搜索接口。')}><input type="url" aria-label={t('SearXNG instance URL', 'SearXNG 实例地址')} required={config.enabled} value={config.baseUrl} placeholder="https://search.example.org" spellCheck={false} onChange={event => update({ baseUrl: event.target.value })} /></Field><button type="button" className="text-button external-help" onClick={() => void run(() => api.openExternal('https://docs.searxng.org/dev/search_api.html'))}>{t('SearXNG API documentation', 'SearXNG API 文档')}<ExternalLink size={13} /></button></>}
      </fieldset>
      <div className="search-settings-actions"><button type="submit" className="button primary" disabled={busy !== null || !dirty}>{busy === 'save' ? <LoaderCircle className="spinning" size={15} /> : <Check size={15} />}{t('Save search settings', '保存搜索设置')}</button><button type="button" className="button" disabled={busy !== null || dirty || !saved.enabled} onClick={() => void test()}>{busy === 'test' ? t('Testing…', '测试中…') : t('Test search', '测试搜索')}</button>{dirty && <span>{t('Save before testing', '保存后可测试')}</span>}</div>
    </form>
    <p className="settings-footnote">{t('Test search sends the query “Electron documentation” to your saved search service.', '测试会向已保存的搜索服务发送「Electron documentation」查询。')}</p>
    {result && <p className={`search-test-result ${result.ok ? 'success' : 'failure'}`} role="status">{result.message}</p>}
    <div className="plain-note"><ShieldCheck size={18} /><p>{t('Search queries are sent to the selected search service. Ask and Auto-edit modes request approval; Full access runs searches automatically. Search results are reference material, and may contain inaccurate or malicious instructions.', '搜索词会发送到所选搜索服务。审批与自动编辑模式会请求许可，完全访问模式自动执行。搜索结果属于参考资料，可能包含错误或恶意指令。')}</p></div>
  </div>;
}
