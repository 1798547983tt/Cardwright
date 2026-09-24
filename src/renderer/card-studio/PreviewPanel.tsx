import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, Monitor, RefreshCw, Smartphone, Tablet, Play } from 'lucide-react';
import { useApp } from '../context';
import { SIM_MESSAGE } from '../../shared/card-studio/tavern-sim';
import type { CardPreview, CardPreviewKind, CardPreviewState, CardProjectView } from '../../shared/card-studio/types';

type Frame = CardPreviewState['frames'][number];
type Width = 'phone' | 'tablet' | 'desktop';
interface Write { id: number; kind: string; detail: string; count?: number }
/** The panel keeps the newest writes: startup noise must not push the creation page's own writes out. */
const WRITE_LIMIT = 60;
const WIDTHS: Array<{ id: Width; icon: typeof Smartphone; label: [string, string] }> = [{ id: 'phone', icon: Smartphone, label: ['375', '375'] }, { id: 'tablet', icon: Tablet, label: ['768', '768'] }, { id: 'desktop', icon: Monitor, label: ['Desktop', '桌面'] }];
/** 'body' and 'update' run the card's regex over the format sample; 'status' and 'start' run a compiled sheet in the 模拟酒馆. */
const LABELS: Record<CardPreviewKind, [string, string]> = { 'body': ['Body styling', '正文美化'], 'update': ['Update receipt', '变量更新'], 'status': ['Status bar', '状态栏'], 'start': ['Creation page', '开局创角页'] };
const HINTS: Record<CardPreviewKind, [string, string]> = {
  'body': ['the format sample as the latest AI reply', '把正文格式的示例输出当作最新一条 AI 回复'],
  'update': ['the <UpdateVariable> block, finished and still streaming', '<UpdateVariable> 块：生成完成和生成中'],
  'status': ['the compiled status bar over the sample variables, inside the 模拟酒馆', '编译后的状态栏读样例变量，跑在模拟酒馆里'],
  'start': ['the compiled creation page; writes are recorded, not executed', '编译后的创角页；写入只记录，不执行'],
};

/**
 * One preview document. The frame is sandboxed without allow-same-origin: its scripts run with an opaque origin, no
 * bridge and no network. It reports its height, its script errors, what its policy blocked and, through the 模拟酒馆,
 * the writes it would make; `register` hands the element up so the panel can post sample variables into it.
 */
function PreviewFrame({ frame, title, register }: { frame: Frame; title: string; register: (url: string, element: HTMLIFrameElement | null) => void }) {
  const { t } = useApp();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(frame.kind === 'frontend' ? 360 : 96);
  const [errors, setErrors] = useState<string[]>([]);
  const [blocked, setBlocked] = useState({ script: false, network: false });
  const [log, setLog] = useState<{ items: Write[]; dropped: number }>({ items: [], dropped: 0 });
  const [simulated, setSimulated] = useState(0);
  useEffect(() => { register(frame.url, ref.current); return () => register(frame.url, null); }, [frame.url, register]);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const data = event.data as { cardwrightPreview?: unknown; height?: unknown; error?: unknown; blocked?: unknown; write?: unknown; simulated?: unknown } | null;
      if (!data || typeof data !== 'object' || data.cardwrightPreview !== 1) return;
      if (typeof data.height === 'number' && Number.isFinite(data.height)) setHeight(Math.min(2400, Math.max(40, Math.ceil(data.height))));
      if (typeof data.error === 'string') { const message = data.error.slice(0, 300); setErrors(list => list.includes(message) || list.length >= 5 ? list : [...list, message]); }
      if (data.blocked === 'script' || data.blocked === 'network') { const kind = data.blocked; setBlocked(value => value[kind] ? value : { ...value, [kind]: true }); }
      const write = data.write as Write | undefined;
      if (write && typeof write.id === 'number' && typeof write.kind === 'string' && typeof write.detail === 'string') {
        const entry: Write = { id: write.id, kind: write.kind.slice(0, 20), detail: write.detail.slice(0, 400), ...(typeof write.count === 'number' ? { count: write.count } : {}) };
        // A merged record comes back with the same id and a higher count: replace it in place. The frame is untrusted, so the panel caps on its own side.
        setLog(current => {
          const at = current.items.findIndex(item => item.id === entry.id);
          if (at >= 0) return { ...current, items: current.items.map((item, index) => index === at ? entry : item) };
          const next = [...current.items, entry];
          return { items: next.slice(-WRITE_LIMIT), dropped: current.dropped + Math.max(0, next.length - WRITE_LIMIT) };
        });
      }
      if (data.simulated === 1) setSimulated(value => value + 1);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);
  return <figure className={`cs-preview-frame is-${frame.kind}`}>
    <figcaption>{frame.kind === 'frontend' ? t('酒馆助手 iframe · a document in a code block', '酒馆助手 iframe · 代码块里的完整文档') : t('Message text', '消息正文')}</figcaption>
    <iframe ref={ref} src={frame.url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ height }} />
    {errors.map(message => <p key={message} className="cs-preview-warn"><AlertTriangle size={13} />{t(`Script error in the preview: ${message}`, `预览里的脚本报错：${message}`)}</p>)}
    {blocked.script && <p className="cs-preview-warn"><AlertTriangle size={13} />{t('Scripts in the message text did not run: SillyTavern runs scripts only in the iframe of a document in a code block.', '消息正文里的脚本没有运行：酒馆只在代码块里的完整 HTML 文档（酒馆助手 iframe）里运行脚本。')}</p>}
    {blocked.network && <p className="cs-preview-warn"><AlertTriangle size={13} />{t('The preview blocked a request to the network.', '预览拦下了联网请求。')}</p>}
    {simulated > 0 && <p className="cs-note cs-preview-simulated">{t(`Sent ${simulated} simulated update(s) into this frame.`, `已向这个框发送 ${simulated} 次模拟更新。`)}</p>}
    {log.items.length > 0 && <section className="cs-preview-writes" aria-label={t('Would write', '将写入')}>
      <h5>{t('Would write', '将写入')}<small>{t('recorded by the 模拟酒馆, nothing was written', '模拟酒馆记录的，没有真的写')}{log.dropped > 0 ? t(` · ${log.dropped} older ones not shown`, ` · 更早的 ${log.dropped} 条没有显示`) : ''}</small></h5>
      <ol>{log.items.map(write => <li key={write.id}><b>{write.kind}</b><span>{write.detail}</span>{/* the sim already ends a merged record with ×N */}</li>)}</ol>
    </section>}
  </figure>;
}

const OUTCOME = { applied: ['Applied', '已替换'], 'no-match': ['No match', '没有命中'], skipped: ['Skipped', '跳过'] } as const;

/**
 * 正文美化 and 变量更新 rendered from the format sample the way SillyTavern would show the latest reply; 状态栏 and
 * 开局创角页 compiled from their sheets and run inside the 模拟酒馆 over the sample variables.
 */
export function PreviewPanel({ card, kind, open }: { card: CardProjectView; kind: CardPreviewKind; open: boolean }) {
  const { api, t, run, notify } = useApp();
  const [expanded, setExpanded] = useState(open);
  const [preview, setPreview] = useState<CardPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState<Width>('phone');
  const [variables, setVariables] = useState('');
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const register = useCallback((url: string, element: HTMLIFrameElement | null) => { if (element) frames.current.set(url, element); else frames.current.delete(url); }, []);
  const load = useCallback(async () => {
    setBusy(true);
    const result = await run(() => api.previewCard(card.projectId, kind));
    if (result) { setPreview(result); if (result.variables !== undefined) setVariables(result.variables); }
    setBusy(false);
  }, [api, card.projectId, kind, run]);
  useEffect(() => { if (expanded) void load(); }, [expanded, load, card.updatedAt]);
  const simulate = () => {
    let statData: unknown;
    try { statData = JSON.parse(variables); } catch { notify(t('The sample variables are not valid JSON.', '样例变量不是合法的 JSON。')); return; }
    // The 模拟酒馆 takes only a plain object of variables and ignores anything else without a word.
    if (!statData || typeof statData !== 'object' || Array.isArray(statData)) { notify(t('The sample variables must be one JSON object.', '样例变量要是一个 JSON 对象。')); return; }
    for (const frame of frames.current.values()) frame.contentWindow?.postMessage({ [SIM_MESSAGE]: 1, statData }, '*');
    notify(t('Sent one variable update into the preview.', '已向预览发送一次变量更新。'));
  };
  const label = t(...LABELS[kind]);
  const simulated = kind === 'status' || kind === 'start';
  return <details className="cs-preview" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('Local preview', '本地预览')} · {label}<small>{t(...HINTS[kind])}</small></summary>
    {expanded && <div className="cs-preview-body">
      <div className="cs-preview-bar">
        <button type="button" className="cs-link" disabled={busy} onClick={() => void load()}>{busy ? <LoaderCircle size={13} className="spinning" /> : <RefreshCw size={13} />}{t('Refresh the preview', '刷新预览')}</button>
        <span className="cs-preview-widths" role="group" aria-label={t('Preview width', '预览宽度')}>{WIDTHS.map(item => { const Icon = item.icon; return <button key={item.id} type="button" className={`cs-link${width === item.id ? ' is-on' : ''}`} aria-pressed={width === item.id} onClick={() => setWidth(item.id)}><Icon size={13} />{t(...item.label)}</button>; })}</span>
        {preview?.form && <span className="cs-preview-form">{t('Form', '形态')} · {preview.form}</span>}
        {preview?.source && <span>{t('From ', '取自 ')}<code>{preview.source.path}</code>{preview.source.from === 'variables' ? t(' (the sample has none)', '（示例输出里没有，借用变量条目里的）') : ''}</span>}
      </div>
      {preview?.notice && <p className="cs-preview-notice">{preview.notice}</p>}
      {preview?.variables !== undefined && preview.states.some(state => state.frames.some(frame => frame.kind === 'frontend')) && <details className="cs-preview-vars">
        <summary>{t('Sample variables', '样例变量')}<small>{t('from [initvar] or the table defaults; edit, then send one update', '来自 [initvar] 或变量表默认值；改完发送一次更新')}</small></summary>
        <textarea value={variables} spellCheck={false} onChange={event => setVariables(event.target.value)} rows={Math.min(24, Math.max(6, variables.split('\n').length))} />
        <button type="button" className="cs-btn" onClick={simulate}><Play size={13} />{t('Send one update', '模拟一次更新')}</button>
      </details>}
      <div className={`cs-preview-frames is-${width}`}>
        {preview?.states.map(state => <section key={state.label} className="cs-preview-state" aria-label={`${label} · ${state.label}`}>
          {preview.states.length > 1 && <h4>{state.label}{state.label === '生成中' && <small>{t('before </UpdateVariable> has arrived', '还没有收到 </UpdateVariable>')}</small>}</h4>}
          {state.steps.length > 0 && <ol className="cs-preview-steps">{state.steps.map((step, index) => <li key={`${step.name}-${index}`} className={`is-${step.outcome}`}>
            <b>{step.name}</b>
            <span>{t(OUTCOME[step.outcome][0], OUTCOME[step.outcome][1])}{step.outcome === 'applied' && step.stage === 'stored' ? t(' · changes the stored message', ' · 改写消息本身') : ''}</span>
            {step.outcome === 'skipped' && step.reason && <small>{step.reason}</small>}
          </li>)}</ol>}
          {!simulated && !state.steps.length && <p className="cs-note">{t('The card has no regex yet: this is the sample as it is.', '本卡还没有正则，下面是示例原样显示的样子。')}</p>}
          {state.frames.map((frame, index) => <PreviewFrame key={frame.url} frame={frame} title={`${label} · ${state.label} · ${index + 1}`} register={register} />)}
          {state.external.length > 0 && <p className="cs-preview-warn"><AlertTriangle size={13} />{t(`The preview stays offline: nothing from ${state.external.join(', ')} loads here.`, `预览不联网：${state.external.join('、')} 上的资源不会加载，酒馆里会。`)}</p>}
        </section>)}
      </div>
      <p className="cs-note cs-preview-foot">{simulated ? t(
        'The 酒馆助手 functions here come from the 模拟酒馆: variables from [initvar] or the table defaults, MVU events on demand, and every write (chat world book, composer, clipboard, variables) recorded as 「将写入」 instead of done. $ (jQuery), _, z, YAML and the SillyTavern page (window.parent.document) are not here. The real SillyTavern is the last word.',
        '这里的酒馆助手函数由模拟酒馆提供：变量来自 [initvar] 或变量表默认值，MVU 更新事件按需触发；写聊天世界书、填输入框、剪贴板、写变量都只记录成「将写入」，不会真的做。没有 $（jQuery）、_、z、YAML，读不到酒馆页面（window.parent.document）；用到它们的手写前端要到酒馆里看。最终以真实酒馆为准。',
      ) : t(
        'Only this card\'s regex run, in SillyTavern 1.19.0 order (the ones that change the stored message, then the display-only ones at depth 0), with 酒馆助手 4.9.5 rendering documents in code blocks. The player\'s global and preset regex and the network are not here; 酒馆助手 functions come from the 模拟酒馆. {{char}} is the card name, {{user}} is 玩家.',
        '只跑本卡的正则，顺序同 SillyTavern 1.19.0：先跑改写消息本身的，再跑只改显示的（按最新一楼，深度 0）；代码块里的完整文档按酒馆助手 4.9.5 渲染成 iframe。玩家自己的全局正则和预设正则、网络都不在预览里；酒馆助手的函数由模拟酒馆提供。{{char}} 代入卡名，{{user}} 代入「玩家」。',
      )}</p>
    </div>}
  </details>;
}
