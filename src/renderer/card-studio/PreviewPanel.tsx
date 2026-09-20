import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useApp } from '../context';
import type { CardPreview, CardPreviewState, CardProjectView } from '../../shared/card-studio/types';

type Frame = CardPreviewState['frames'][number];

/**
 * One preview document. The frame is sandboxed without allow-same-origin: its scripts run with an opaque origin, no
 * bridge and no network. It reports only its height, its script errors and what its policy blocked.
 */
function PreviewFrame({ frame, title }: { frame: Frame; title: string }) {
  const { t } = useApp();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(frame.kind === 'frontend' ? 360 : 96);
  const [errors, setErrors] = useState<string[]>([]);
  const [blocked, setBlocked] = useState({ script: false, network: false });
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const data = event.data as { cardwrightPreview?: unknown; height?: unknown; error?: unknown; blocked?: unknown } | null;
      if (!data || typeof data !== 'object' || data.cardwrightPreview !== 1) return;
      if (typeof data.height === 'number' && Number.isFinite(data.height)) setHeight(Math.min(2400, Math.max(40, Math.ceil(data.height))));
      if (typeof data.error === 'string') { const message = data.error.slice(0, 300); setErrors(list => list.includes(message) || list.length >= 5 ? list : [...list, message]); }
      if (data.blocked === 'script' || data.blocked === 'network') { const kind = data.blocked; setBlocked(value => value[kind] ? value : { ...value, [kind]: true }); }
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
  </figure>;
}

const OUTCOME = { applied: ['Applied', '已替换'], 'no-match': ['No match', '没有命中'], skipped: ['Skipped', '跳过'] } as const;

/** 正文美化 or 变量更新, rendered from the format sample the way SillyTavern would show the latest reply. */
export function PreviewPanel({ card, kind, open }: { card: CardProjectView; kind: 'body' | 'update'; open: boolean }) {
  const { api, t, run } = useApp();
  const [expanded, setExpanded] = useState(open);
  const [preview, setPreview] = useState<CardPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const result = await run(() => api.previewCard(card.projectId, kind));
    if (result) setPreview(result);
    setBusy(false);
  }, [api, card.projectId, kind, run]);
  useEffect(() => { if (expanded) void load(); }, [expanded, load, card.updatedAt]);
  const label = kind === 'body' ? t('Body styling', '正文美化') : t('Update receipt', '变量更新');
  return <details className="cs-preview" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('Local preview', '本地预览')} · {label}<small>{kind === 'body' ? t('the format sample as the latest AI reply', '把正文格式的示例输出当作最新一条 AI 回复') : t('the <UpdateVariable> block, finished and still streaming', '<UpdateVariable> 块：生成完成和生成中')}</small></summary>
    {expanded && <div className="cs-preview-body">
      <div className="cs-preview-bar">
        <button type="button" className="cs-link" disabled={busy} onClick={() => void load()}>{busy ? <LoaderCircle size={13} className="spinning" /> : <RefreshCw size={13} />}{t('Refresh the preview', '刷新预览')}</button>
        {preview?.source && <span>{t('From ', '取自 ')}<code>{preview.source.path}</code>{preview.source.from === 'variables' ? t(' (the sample has none)', '（示例输出里没有，借用变量条目里的）') : ''}</span>}
      </div>
      {preview?.notice && <p className="cs-preview-notice">{preview.notice}</p>}
      {preview?.states.map(state => <section key={state.label} className="cs-preview-state" aria-label={`${label} · ${state.label}`}>
        {preview.states.length > 1 && <h4>{state.label}{state.label === '生成中' && <small>{t('before </UpdateVariable> has arrived', '还没有收到 </UpdateVariable>')}</small>}</h4>}
        {state.steps.length ? <ol className="cs-preview-steps">{state.steps.map((step, index) => <li key={`${step.name}-${index}`} className={`is-${step.outcome}`}>
          <b>{step.name}</b>
          <span>{t(OUTCOME[step.outcome][0], OUTCOME[step.outcome][1])}{step.outcome === 'applied' && step.stage === 'stored' ? t(' · changes the stored message', ' · 改写消息本身') : ''}</span>
          {step.outcome === 'skipped' && step.reason && <small>{step.reason}</small>}
        </li>)}</ol> : <p className="cs-note">{t('The card has no regex yet: this is the sample as it is.', '本卡还没有正则，下面是示例原样显示的样子。')}</p>}
        {state.frames.map((frame, index) => <PreviewFrame key={frame.url} frame={frame} title={`${label} · ${state.label} · ${index + 1}`} />)}
        {state.external.length > 0 && <p className="cs-preview-warn"><AlertTriangle size={13} />{t(`The preview stays offline: nothing from ${state.external.join(', ')} loads here.`, `预览不联网：${state.external.join('、')} 上的资源不会加载，酒馆里会。`)}</p>}
      </section>)}
      <p className="cs-note cs-preview-foot">{t(
        'Only this card\'s regex run, in SillyTavern 1.19.0 order (the ones that change the stored message, then the display-only ones at depth 0), with 酒馆助手 4.9.5 rendering documents in code blocks. The player\'s global and preset regex, the network and 酒馆助手\'s functions ($, getVariables…) are not here. {{char}} is the card name, {{user}} is 玩家.',
        '只跑本卡的正则，顺序同 SillyTavern 1.19.0：先跑改写消息本身的，再跑只改显示的（按最新一楼，深度 0）；代码块里的完整文档按酒馆助手 4.9.5 渲染成 iframe。玩家自己的全局正则和预设正则、网络、酒馆助手的函数（$、getVariables 等）都不在预览里。{{char}} 代入卡名，{{user}} 代入「玩家」。',
      )}</p>
    </div>}
  </details>;
}
