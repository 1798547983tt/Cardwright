import { useApp } from '../context';
import { sectionLabel } from '../../shared/card-studio/boards';
import { formatDispatch } from '../../shared/card-studio/dispatch';
import { nextDispatch } from '../../shared/card-studio/view';
import type { CardProjectView } from '../../shared/card-studio/types';
import type { Task } from '../../shared/types';
import { useStudio } from './CardStudio';

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
