import { useApp, type AppContextValue } from '../context';
import { sectionLabel } from '../../shared/card-studio/boards';
import { formatDispatch } from '../../shared/card-studio/dispatch';
import { nextDispatch } from '../../shared/card-studio/view';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { useStudio } from './CardStudio';

/**
 * 撤销本轮: the files a turn changed go back to its checkpoint. Files changed again after the turn are kept and named.
 * The checkpoint outlives the turn's messages, so a withdrawn turn can still be undone. Returns what to tell the user.
 */
export async function undoTurnWrites(api: AppContextValue['api'], t: AppContextValue['t'], taskId: string, turnId: string): Promise<string> {
  const checkpoint = (await api.checkpoints(taskId)).find(item => item.turnId === turnId);
  if (!checkpoint) throw new Error(t('This turn has no checkpoint, so it cannot be undone here.', '这一轮没有检查点，无法在这里撤销。'));
  const review = await api.checkpointDiff(taskId, checkpoint.id) as { checkpointId: string; files: Array<{ path: string; afterHash: string | null }> };
  const kept: string[] = [];
  for (const file of review.files) {
    try { await api.reviewAction(taskId, { checkpointId: review.checkpointId, path: file.path, action: 'revert', expectedHash: file.afterHash }); }
    catch { kept.push(file.path); }
  }
  const reverted = review.files.length - kept.length;
  return kept.length
    ? t(`Reverted ${reverted} files. ${kept.length} changed again after this turn and were kept: ${kept.join(', ')}`, `已撤销 ${reverted} 个文件。有 ${kept.length} 个文件在本轮之后又改过，已保留：${kept.join('、')}`)
    : t(`Reverted ${reverted} files from this turn.`, `已撤销本轮对 ${reverted} 个文件的改动。`);
}

/** Token counts the way the studio shows them: 86K, 1.2M. */
export function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M`;
  return `${Math.round(value / 1000)}K`;
}

/** What the conversation, the section page and the slash commands do the same way. */
export function useCardActions(card: CardProjectView) {
  const { api, t, run, notify } = useApp();
  const studio = useStudio();
  return {
    /** Opens the next dispatch not yet sent as a draft in its section; nothing is sent. */
    openNextDispatch() {
      const next = nextDispatch(card);
      if (!next?.sectionId) { notify(t('Every dispatch has been sent.', '派单都已经发出去了。')); return; }
      studio.startDraft(card.projectId, next.sectionId, { title: next.title, text: formatDispatch(next), dispatchId: next.id });
      studio.openSection(card.projectId, next.sectionId, 'draft');
      notify(t(`The next dispatch is in the ${sectionLabel(next.sectionId)} composer; press Send when ready.`, `下一条派单已填进「${sectionLabel(next.sectionId)}」的输入框，确认后按发送。`));
    },
    /** Asks this conversation's AI for a handoff summary; a new conversation opens with it when the reply arrives. */
    requestHandoff(task: Task) {
      return run(() => api.requestCardHandoff(task.id));
    },
  };
}
