import { useState, type FormEvent } from 'react';
import { FilePenLine, LoaderCircle } from 'lucide-react';
import { useApp } from '../context';
import { Modal } from '../primitives';
import { runIsOpen } from '../../shared/card-studio/run';
import { runningConversation } from '../../shared/card-studio/view';
import type { CardChangeKind, CardProjectView } from '../../shared/card-studio/types';
import { useStudio } from './CardStudio';
import { KickoffOptions, useKickoffChoice } from './Kickoff';

const clean = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * 提改动 (§5.4): one sentence, or an error log pasted in. The change AI starts in planning, reads the whole card and lists
 * the components the change affects as the 影响清单; nothing else is written until 照单开做.
 */
export function ChangeDialog({ card, initialText, onClose }: { card: CardProjectView; initialText: string; onClose: () => void }) {
  const { data, api, t } = useApp();
  const studio = useStudio();
  const [kind, setKind] = useState<CardChangeKind>('request');
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choice = useKickoffChoice(card, false);
  const running = runningConversation(data.tasks, card.projectId);
  const blocker = runIsOpen(card.run) ? t('This card has a run that is not finished; continue or stop it first.', '这张卡还有一次一键制作没做完，先继续或停止它。')
    : running ? t('A conversation of this card is running. Wait for it to finish or stop it first.', '这张卡有对话正在运行，等它结束或先停止它。')
    : !choice.ready ? t('Configure a model gateway in settings first.', '请先在设置里配置模型网关。') : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || blocker || !text.trim()) return;
    setBusy(true); setError('');
    try {
      const { task } = await api.startCardChange(card.projectId, { kind, text, thinking: choice.thinking, ...(choice.gatewayId ? { gatewayId: choice.gatewayId } : {}), ...(choice.modelId ? { modelId: choice.modelId } : {}) });
      onClose();
      studio.openSection(card.projectId, 'plan', task.id);
    } catch (reason) { setError(clean(reason)); setBusy(false); }
  }

  return <Modal title={t('Ask for a change', '提改动')} className="studio-modal cs-change-dialog" onClose={() => { if (!busy) onClose(); }}>
    <p className="modal-intro">{t(
      'Say it in one sentence, or paste the error from the tavern. The change AI reads the whole card and lists the components the change affects. Take out what you do not want, then 照单开做 runs the rest section by section, in dependency order.',
      '一句话说清要改什么，或者贴上酒馆里的报错。改动 AI 会读整张卡，列出要动的组件（影响清单）；删掉不要的条目后点「照单开做」，按分区依赖顺序一口气做完。')}</p>
    {!card.design.exists && <p className="cs-note">{t('This card has no design book; the change AI works from the components the card has.', '本卡没有设计书：改动 AI 以卡里现有的组件为准。')}</p>}
    <form className="cs-change-form" onSubmit={event => void submit(event)}>
      <fieldset className="cs-field">
        <legend>{t('Kind', '类型')}</legend>
        <span className="cs-segments">
          <label className="cs-segment"><input type="radio" name="change-kind" checked={kind === 'request'} onChange={() => setKind('request')} /><span>{t('A change', '改动')}</span></label>
          <label className="cs-segment"><input type="radio" name="change-kind" checked={kind === 'error'} onChange={() => setKind('error')} /><span>{t('An error', '报错')}</span></label>
        </span>
      </fieldset>
      <label className="cs-field">
        <span>{kind === 'error' ? t('The error', '报错内容') : t('What to change', '要改什么')}<small>{kind === 'error' ? t('The text of the F12 console helps most.', 'F12 控制台里的原文最有用。') : t('One sentence is enough.', '一句话就够。')}</small></span>
        <textarea className="cs-change-text" autoFocus rows={kind === 'error' ? 8 : 4} maxLength={100_000} value={text} onChange={event => setText(event.target.value)}
          placeholder={kind === 'error' ? t('Paste the error here', '把报错贴在这里') : t('For example: add a custom opening option to the creation page', '例如：创角页加自定义开局选项')} />
      </label>
      <KickoffOptions card={card} choice={choice} />
      {blocker && <p className="cs-form-error">{blocker}</p>}
      {error && <p className="cs-form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="cs-btn" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button>
        <button type="submit" className="cs-btn is-primary" disabled={busy || !!blocker || !text.trim()}>{busy ? <LoaderCircle size={14} className="spinning" /> : <FilePenLine size={14} />}{t('Start', '开始')}</button>
      </div>
    </form>
  </Modal>;
}
