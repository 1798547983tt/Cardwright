import { useState } from 'react';
import { ArrowRight, Check, LoaderCircle, Pause, Play, Square, X, Zap } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { ModelPicker } from '../ModelPicker';
import { thinkingLabel } from '../effort';
import { selectedModel } from '../model-resolution';
import { availableEfforts } from '../../shared/effort';
import { BOARDS, sectionLabel, sortByDependency } from '../../shared/card-studio/boards';
import { RUN_PAUSE_LABELS, runIsOpen, runQueue, runUsage, runnableSection } from '../../shared/card-studio/run';
import { runningConversation } from '../../shared/card-studio/view';
import type { CardChange, CardPermission, CardProjectView, CardRun, CardRunScope } from '../../shared/card-studio/types';
import type { ThinkingLevel } from '../../shared/types';
import { useStudio } from './CardStudio';
import { cardPermissionLabels } from './StudioComposer';
import { tokenCount } from './actions';

const PERMISSIONS: CardPermission[] = ['ask', 'edit', 'full'];
const errorText = (reason: unknown) => reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason);

/** 一键制作 names its board; 全部开做 covers them all; a 改动单's run is named for it. */
export function runTitle(scope: CardRunScope, t: (en: string, zh: string) => string): string {
  if (scope === 'all') return t('Run everything', '全部开做');
  if (scope === 'change') return t('Change order', '改动单');
  const board = BOARDS.find(item => item.id === scope);
  return t(`One-click making · ${board?.en ?? scope}`, `一键制作 · ${board?.name ?? scope}`);
}

/**
 * The panel before a run: effort, model, permission and 遇到提问自动按推荐, remembered per card once the run starts.
 * The first time it offers 高, the default model, 项目内自动编辑 and no automatic answers. Scope `change` with a draft
 * `change` is 照单开做; with a paused one it is 继续跑.
 */
export function RunDialog({ card, scope, change, onClose }: { card: CardProjectView; scope: CardRunScope; change?: CardChange; onClose: () => void }) {
  const { data, api, t } = useApp();
  const saved = data.projects.find(project => project.id === card.projectId)?.cardSettings?.run;
  const [choice, setChoice] = useState(() => {
    const fallback = (data.gateways.find(item => item.id === data.preferences.defaultGatewayId) ?? data.gateways[0])?.id ?? '';
    const known = !!saved?.gatewayId && data.gateways.some(item => item.id === saved.gatewayId);
    return {
      gatewayId: known ? saved!.gatewayId! : fallback,
      modelId: known ? saved?.modelId : fallback === data.preferences.defaultGatewayId ? data.preferences.defaultModelId : undefined,
      thinking: saved?.thinking ?? 'high' as ThinkingLevel,
      permission: saved?.permission ?? 'edit' as CardPermission,
      autoAnswer: saved?.autoAnswer ?? false,
    };
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const gateway = selectedModel(data.gateways.find(item => item.id === choice.gatewayId), choice.modelId);
  // Ultra brings the reading squad, which belongs to planning; a run never plans.
  const efforts: ThinkingLevel[] = (gateway ? availableEfforts(gateway) : ['off' as ThinkingLevel]).filter(level => level !== 'ultra');
  const thinking = efforts.includes(choice.thinking) ? choice.thinking : efforts.includes('high') ? 'high' : efforts[efforts.length - 1] ?? 'off';
  const labels = cardPermissionLabels(t);
  const confirming = scope === 'change' && change?.status === 'draft';
  const queue: Array<{ id: string; target: string; sectionId: string | null; title: string }> = scope !== 'change' ? runQueue(card.dispatches, scope).flatMap(id => card.dispatches.filter(item => item.id === id))
    : !change ? [] : confirming ? sortByDependency(change.items) : change.dispatchIds.flatMap(id => card.dispatches.filter(item => item.id === id && item.status !== 'done'));
  const stray = scope === 'change' ? queue.find(item => !runnableSection(item.sectionId)) : undefined;
  const busy = runningConversation(data.tasks, card.projectId);
  const blocker = runIsOpen(card.run) ? t('This card already has a run that is not finished.', '这张卡还有一次一键制作没做完。')
    : scope !== 'change' && !card.design.exists ? t('There is no design book yet. Planning writes it together with the dispatches.', '还没有设计书。先在规划写出设计书和派单。')
    : !queue.length ? scope === 'change' ? t('Nothing is left to do for this change.', '这个改动没有要做的改动派单。') : t('No unsent dispatches here.', '这里没有未派的派单。')
    : stray ? t(`「${stray.title}」 targets ${stray.target}, which one-click making cannot go to. Take it off the list first.`, `「${stray.title}」的目标「${stray.target}」不是一键制作能去的分区，先把这一条删掉。`)
    : busy ? t('A conversation of this card is running. Wait for it to finish or stop it first.', '这张卡有对话正在运行，等它结束或先停止它。')
    : !gateway ? t('Configure a model gateway in settings first.', '请先在设置里配置模型网关。') : '';

  async function start() {
    if (starting || blocker || !gateway) return;
    setStarting(true); setError('');
    try {
      const settings = { thinking, gatewayId: gateway.id, modelId: gateway.modelId, permission: choice.permission, autoAnswer: choice.autoAnswer };
      if (scope !== 'change') await api.startCardRun(card.projectId, scope, settings);
      else if (change) await (confirming ? api.confirmCardChange(card.projectId, change.id, settings) : api.resumeCardChange(card.projectId, change.id, settings));
      onClose();
    } catch (reason) { setError(errorText(reason)); }
    finally { setStarting(false); }
  }

  return <Modal title={confirming ? t('Go ahead with the list', '照单开做') : runTitle(scope, t)} className="studio-modal cs-run-dialog" onClose={() => { if (!starting) onClose(); }}>
    {scope === 'change' ? <p className="modal-intro">{t(
      'The change dispatches below go to their sections in dependency order, one conversation per section, with the same pause rules as one-click making. When the card has a design book, the change AI first brings it in line with the list. The run ends with the assembly check.',
      '下面的改动派单按分区依赖顺序代发给对应分区，一个分区一个对话，暂停规则和一键制作相同。卡有设计书时，改动 AI 先把设计书改到与清单一致再开跑。全部做完后跑一次拼装检查。')}</p>
      : <p className="modal-intro">{t(
      'Sends the unsent dispatches below to their sections in order, one conversation per section. A dispatch is marked done once it is delivered and the assembly check finds no errors in what it wrote. Questions, refusals, errors and approvals pause the run and notify you.',
      '按派单顺序，把下面这些未派的派单代发给对应分区，一个分区用一个对话接连做完。交付后拼装检查没有这条派单的错误，就自动标记完成；遇到提问、拒绝开工、出错或需要批准时暂停，并通知你。')}{scope === 'all' && t(' The run ends with the assembly check.', '全部做完后再跑一次拼装检查。')}</p>}
    {queue.length > 0 && <ol className="cs-run-queue" aria-label={t('Dispatches to do', '将要做的派单')}>
      {queue.slice(0, 8).map(dispatch => <li key={dispatch.id}><span>{dispatch.sectionId ? sectionLabel(dispatch.sectionId) : dispatch.target}</span><b>{dispatch.title}</b></li>)}
      {queue.length > 8 && <li className="is-more">{t(`and ${queue.length - 8} more`, `还有 ${queue.length - 8} 条`)}</li>}
    </ol>}
    <div className="cs-run-fields">
      <label className="cs-field"><span>{t('Effort', '思考强度')}</span>
        <select value={thinking} disabled={!gateway} onChange={event => setChoice(current => ({ ...current, thinking: event.target.value as ThinkingLevel }))}>
          {efforts.map(level => <option key={level} value={level}>{thinkingLabel(level, t)}</option>)}
        </select>
      </label>
      <div className="cs-field"><span>{t('Model', '模型')}</span>
        <ModelPicker gatewayId={choice.gatewayId} modelId={gateway?.modelId} onChange={(gatewayId, modelId) => setChoice(current => ({ ...current, gatewayId, modelId }))} />
      </div>
      <fieldset className="cs-field">
        <legend>{t('Permission', '权限')}</legend>
        <div className="cs-run-options">{PERMISSIONS.map(mode => <label key={mode} className={`cs-run-option is-${mode}`}>
          <input type="radio" name="cs-run-permission" checked={choice.permission === mode} onChange={() => setChoice(current => ({ ...current, permission: mode }))} />
          <span><b>{labels[mode].name}</b><small>{labels[mode].description}</small></span>
        </label>)}</div>
      </fieldset>
      <label className="cs-run-option is-check">
        <input type="checkbox" checked={choice.autoAnswer} onChange={event => setChoice(current => ({ ...current, autoAnswer: event.target.checked }))} />
        <span><b>{t('Answer questions with the recommendations', '遇到提问自动按推荐')}</b><small>{t('When a section AI asks, the run replies 全部按推荐 and lists what it answered in the results.', '分区 AI 提问时直接回「全部按推荐」，答过的题记在结果里。')}</small></span>
      </label>
    </div>
    {choice.permission === 'ask' && <p className="cs-note">{t('Each approval pauses the run until you answer it in the conversation.', '每次需要批准都会暂停运行，等你在对话里批准。')}</p>}
    {blocker && <p className="cs-form-error">{blocker}</p>}
    {error && <p className="cs-form-error" role="alert">{error}</p>}
    <div className="modal-actions">
      <button type="button" className="cs-btn" disabled={starting} onClick={onClose}>{t('Cancel', '取消')}</button>
      <button type="button" className="cs-btn is-primary" disabled={!!blocker || starting} onClick={() => void start()}>{starting ? <LoaderCircle size={14} className="spinning" /> : <Zap size={14} />}{confirming ? t(`Go ahead · ${queue.length}`, `照单开做 · ${queue.length} 条`) : scope === 'change' ? t(`Carry on · ${queue.length}`, `继续跑 · ${queue.length} 条`) : t(`Start · ${queue.length}`, `开始 · ${queue.length} 条`)}</button>
    </div>
  </Modal>;
}

/**
 * The run's progress on the card project home and the section pages: the dispatch in hand, how far it got, what it used,
 * and 暂停 / 继续 / 停止. A paused run says why; a finished one shows its results until closed.
 */
export function RunBar({ card, here }: { card: CardProjectView; here?: string }) {
  const { data, api, t, run: perform } = useApp();
  const studio = useStudio();
  const [busy, setBusy] = useState(false);
  const run: CardRun | undefined = card.run;
  if (!run) return null;
  const act = (work: () => Promise<unknown>) => { setBusy(true); void perform(work).finally(() => setBusy(false)); };
  const usage = runUsage(run, data.tasks);
  const currency = selectedModel(data.gateways.find(item => item.id === run.settings.gatewayId), run.settings.modelId)?.pricing?.currency;
  const current = run.current ? card.dispatches.find(item => item.id === run.current!.dispatchId) : undefined;
  const conversation = data.tasks.find(item => item.id === (run.current?.taskId ?? run.handoff?.fromTaskId));
  const position = Math.min(run.done.length + (run.current || run.handoff ? 1 : 0), run.total);
  const usageText = `${tokenCount(usage.tokens)} Token${currency ? ` · ${usage.cost.toFixed(4)} ${currency}` : ''}`;
  const openConversation = conversation?.card && conversation.id !== here ? () => studio.openSection(card.projectId, conversation.card!.sectionId, conversation.id) : undefined;
  const progress = <div className="cs-run-progress" role="progressbar" aria-label={t('Dispatches done', '已完成的派单')} aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done.length}><i style={{ width: `${run.total ? run.done.length / run.total * 100 : 0}%` }} /></div>;

  if (!runIsOpen(run)) {
    const answered = run.autoAnswered.length;
    return <section className={`cs-run-bar is-${run.status}`} aria-label={runTitle(run.scope, t)}>
      <header>
        {run.status === 'completed' ? <Check size={15} className="cs-run-icon" /> : <Square size={13} className="cs-run-icon" />}
        <b>{runTitle(run.scope, t)}</b>
        <span className="cs-run-state">{run.status === 'completed' ? t(`Finished · ${run.done.length} dispatches done`, `已完成 · 做完 ${run.done.length} 条派单`) : t(`Stopped · ${run.done.length} of ${run.total} done`, `已停止 · 做完 ${run.done.length} / ${run.total} 条`)}</span>
        <span className="cs-run-usage">{usageText}</span>
        <button type="button" className="cs-run-close" aria-label={t('Close the results', '关闭结果')} disabled={busy} onClick={() => act(() => api.dismissCardRun(card.projectId))}><X size={14} /></button>
      </header>
      {progress}
      {run.finalCheck && <p className={`cs-run-check ${run.finalCheck.errors ? 'is-bad' : 'is-good'}`}>
        {run.finalCheck.errors ? t(`Assembly check: ${run.finalCheck.errors} errors, ${run.finalCheck.warnings} warnings. Errors block the export.`, `拼装检查：${run.finalCheck.errors} 个错误、${run.finalCheck.warnings} 个警告。有错误时不能导出。`) : t(`Assembly check: no errors, ${run.finalCheck.warnings} warnings.`, `拼装检查：没有错误，${run.finalCheck.warnings} 个警告。`)}
        <button type="button" className="cs-link" onClick={() => studio.openSection(card.projectId, 'build')}>{t('Open the assembly bench', '打开拼装台')}<ArrowRight size={12} /></button>
      </p>}
      {answered > 0 && <details className="cs-run-answers">
        <summary>{t(`Answered with the recommendations ${answered} times`, `自动按推荐答过 ${answered} 次`)}</summary>
        <ol>{run.autoAnswered.map((item, index) => <li key={index}><span>{card.dispatches.find(dispatch => dispatch.id === item.dispatchId)?.title ?? item.dispatchId}</span><p>{item.text}</p></li>)}</ol>
      </details>}
    </section>;
  }

  const paused = run.status === 'paused' && run.pause;
  return <section className={`cs-run-bar is-${run.status}`} role="status" aria-label={runTitle(run.scope, t)}>
    <header>
      {paused ? <Pause size={14} className="cs-run-icon" /> : <LoaderCircle size={14} className="cs-run-icon spinning" />}
      <b>{runTitle(run.scope, t)}</b>
      <span className="cs-run-state">{paused ? t(`Paused: ${RUN_PAUSE_LABELS[paused.reason].en}`, `已暂停：${RUN_PAUSE_LABELS[paused.reason].zh}`) : run.status === 'pausing' ? t('Pausing after this round…', '这一轮做完后暂停…') : t('Running', '进行中')}</span>
      <span className="cs-run-count">{t(`${position} of ${run.total}`, `第 ${position} / ${run.total} 条`)}</span>
      <span className="cs-run-usage">{usageText}</span>
    </header>
    {progress}
    <div className="cs-run-body">
      {openConversation ? <button type="button" className="cs-run-current" onClick={openConversation}>
        <span>{current ? `${sectionLabel(current.sectionId!)}｜${current.title}` : run.handoff ? t('Changing conversation', '正在换对话') : t('Preparing', '准备中')}</span><ArrowRight size={13} />
      </button> : <span className="cs-run-current is-here">{current ? `${sectionLabel(current.sectionId!)}｜${current.title}` : run.handoff ? t('Changing conversation', '正在换对话') : t('Preparing', '准备中')}</span>}
      <span className="cs-run-actions">
        {run.status === 'running' && <button type="button" className="cs-btn is-small" disabled={busy} onClick={() => act(() => api.pauseCardRun(card.projectId))}><Pause size={12} />{t('Pause', '暂停')}</button>}
        {paused && <button type="button" className="cs-btn is-small is-primary" disabled={busy} onClick={() => act(() => api.resumeCardRun(card.projectId))}><Play size={12} />{t('Continue', '继续')}</button>}
        <button type="button" className="cs-btn is-small is-danger" disabled={busy} onClick={() => act(() => api.stopCardRun(card.projectId))}><Square size={11} />{t('Stop', '停止')}</button>
      </span>
    </div>
    {paused && <div className="cs-run-pause">
      <p>{paused.message}</p>
      {paused.reason === 'question' && <small>{t('Answer in the conversation and press Continue, or press Continue to take the recommendations.', '去对话里回答后点【继续】；直接点【继续】就全部按推荐。')}</small>}
      {(paused.reason === 'refusal' || paused.reason === 'tool-failures' || paused.reason === 'model-error' || paused.reason === 'restart') && <small>{t('Continue asks the section AI to go on with this dispatch.', '点【继续】会请分区 AI 接着做这条派单。')}</small>}
      {paused.reason === 'check-errors' && <small>{t('Fix the files yourself or press Continue for another fix round.', '可以自己改好文件，或者点【继续】再修一轮。')}</small>}
    </div>}
  </section>;
}
