import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Task } from '../shared/types';
import { useApp } from './context';
import { IconButton, Modal } from './primitives';
import { selectedModel } from './model-resolution';
import { lowerEffort, nextOutputLimit } from '../shared/output-limit';
import { availableEfforts } from '../shared/effort';
import { thinkingLabel } from './effort';

/** Shown on the truncated turn. Every action is explicit; nothing is resent automatically. */
export function TruncationNotice({ task, userMessageId }: { task: Task; userMessageId?: string }) {
  const { data, api, run, t } = useApp();
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false);
  const truncation = task.truncation;
  if (!truncation) return null;
  const model = selectedModel(data.gateways.find(item => item.id === task.gatewayId), task.modelId);
  const raised = model ? nextOutputLimit(model.maxTokens, model.contextWindow) : undefined;
  const lower = model?.reasoning ? lowerEffort(task.thinking, model.effortMap ?? {}, availableEfforts(model)) : undefined;
  const locale = data.preferences.language === 'zh' ? 'zh-CN' : 'en-US';
  const format = (value: number) => value.toLocaleString(locale);
  const act = async (action: () => Promise<void>) => { setBusy(true); await run(action); setBusy(false); };
  // Only the truncated response is guaranteed to have done nothing; earlier steps of the same turn may have run tools.
  const executed = task.tools.filter(tool => (!truncation.turnId || tool.turnId === truncation.turnId) && tool.status === 'completed').length;
  return <section className="truncation-notice" role="status" aria-label={t('Output limit reached', '输出被截断')}>
    <header className="hazard-head"><span><span className="code-tag" aria-hidden="true">OUTPUT LIMIT</span>{t('Output limit', '输出上限')}</span><span className="hazard-count">{format(truncation.outputTokens)} / {format(truncation.maxTokens)} Token</span></header>
    <div className="truncation-body">
      <strong>{t('Output was truncated', '输出被截断')}</strong>
      {executed === 0
        ? <p>{t('The model used this turn’s whole output limit before it could act.', '模型用完了这一轮的输出上限，还没来得及执行操作。')} <b>{t('No files were written.', '未写入任何文件。')}</b></p>
        : <p>{t(`This turn ran ${executed} tool calls before the output limit was reached.`, `这一轮在达到输出上限前执行了 ${executed} 次工具调用。`)} <b>{t('The truncated response itself ran nothing.', '被截断的那段回复没有执行任何操作。')}</b></p>}
      <div className="truncation-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void act(() => api.prompt(task.id, t('Continue the previous step (the last response hit the output limit).', '继续完成上一步（上一轮输出被截断）')))}>{t('Continue', '继续')}</button>
        <button type="button" className="button" disabled={busy || !raised || !userMessageId} title={raised ? `${format(raised)} Token` : t('Already at this model’s context window', '已达到该模型的上下文窗口')} onClick={() => setConfirm(true)}>{t('Raise limit & regenerate', '调高上限后重新生成')}</button>
        <button type="button" className="button" disabled={busy || !lower || !userMessageId} title={lower ? thinkingLabel(lower, t) : t('No lower effort sends a different value', '没有可用的更低强度')} onClick={() => void act(async () => { await api.updateTask(task.id, { thinking: lower! }); await api.regenerate(task.id, userMessageId!); })}>{t('Lower effort & regenerate', '降低强度后重新生成')}</button>
      </div>
    </div>
    {confirm && model && raised && <Modal title={t('Raise the output limit?', '调高输出上限？')} className="small-modal" onClose={() => { if (!busy) setConfirm(false); }}>
      <p className="modal-intro">{t(`Change ${model.modelId} from ${format(model.maxTokens)} to ${format(raised)} tokens, then regenerate this turn. Other models keep their settings.`, `把 ${model.modelId} 的最大输出从 ${format(model.maxTokens)} 调到 ${format(raised)} Token，然后重新生成这一轮。其他模型的设置不变。`)}</p>
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => setConfirm(false)}>{t('Cancel', '取消')}</button><button type="button" className="button primary" disabled={busy} onClick={() => void act(async () => { await api.setModelOutputLimit(task.gatewayId, model.modelId, raised); await api.regenerate(task.id, userMessageId!); setConfirm(false); })}>{t('Raise & regenerate', '调高并重新生成')}</button></div>
    </Modal>}
  </section>;
}

/** One-time notice after the 0.7.1 output limit migration. */
export function UpgradeNotice() {
  const { data, api, run, t, settings } = useApp();
  const notice = data.preferences.migrationNotice;
  if (!notice) return null;
  return <div className="upgrade-notice" role="status">
    <span className="code-tag" aria-hidden="true">UPDATE</span>
    <p>{t('Maximum output for these models changed from 8,192 to 128K (or their context window), so reasoning no longer uses up the reply:', '以下模型的最大输出已从 8,192 调到 128K（不超过其上下文窗口），避免思考占满整轮回复：')} <b>{notice.models.join('、')}</b></p>
    <button type="button" className="text-button" onClick={() => settings('code')}>{t('Review models', '查看模型设置')}</button>
    <IconButton label={t('Dismiss', '关闭')} onClick={() => void run(() => api.dismissNotice())}><X size={16} /></IconButton>
  </div>;
}

/** The version whose pill was closed, kept in localStorage; a later version brings the pill back. */
const RELEASE_CLOSED = 'cardwright.release-pill.closed';
let closedThisRun: string | null = null;
function closedRelease(): string | null {
  if (closedThisRun) return closedThisRun;
  try { return localStorage.getItem(RELEASE_CLOSED); } catch { return null; }
}
const HOUR = 60 * 60 * 1000;

/**
 * 新版本提醒 in the top bar of the workbench and of the card studio (1.1). The desktop notification waits for the
 * notification switch, which starts off, so the newer release the daily check found is also this quiet pill: it opens
 * the release page, and × hides it until a later version comes.
 */
export function ReleasePill() {
  const { data, api, run, t } = useApp();
  const enabled = data.preferences.releaseCheck !== false;
  const [release, setRelease] = useState<{ latest: string; url: string } | null>(null);
  const [closed, setClosed] = useState(closedRelease);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => void api.readReleaseCheck().then(view => { if (live) setRelease(view.newer && view.latest && view.url ? { latest: view.latest, url: view.url } : null); }, () => undefined);
    read();
    const timer = setInterval(read, HOUR);
    return () => { live = false; clearInterval(timer); };
  }, [api, enabled]);
  if (!enabled || !release || release.latest === closed) return null;
  const { latest, url } = release;
  function close() {
    closedThisRun = latest; setClosed(latest);
    try { localStorage.setItem(RELEASE_CLOSED, latest); } catch { /* without storage it stays closed until the app restarts */ }
  }
  return <div className="release-pill" role="status">
    <button type="button" className="release-pill-open" title={url} onClick={() => void run(() => api.openExternal(url))}><i aria-hidden="true" />{t(`New version ${latest} · Open the release page`, `有新版本 ${latest} · 打开发布页`)}</button>
    <button type="button" className="release-pill-close" aria-label={t(`Hide the reminder for ${latest}`, `不再提醒 ${latest}`)} title={t('Hide until a later version', '有更新的版本前不再显示')} onClick={close}><X size={12} /></button>
  </div>;
}
