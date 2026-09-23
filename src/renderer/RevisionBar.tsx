import { useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import type { Task } from '../shared/types';
import { useApp } from './context';

export function RevisionBar({ task, className = '' }: { task: Task; className?: string }) {
  const { api, run, t } = useApp(); const [busy, setBusy] = useState(false);
  if (!task.revisions?.length) return null;
  const active = ['running', 'queued', 'waiting'].includes(task.status) || !!task.workerActive;
  return <div className={`revision-bar ${className}`.trim()}><History size={14} /><label>{t('Conversation version', '对话版本')}<select aria-label={t('Conversation version', '对话版本')} disabled={active || busy} value={task.activeRevisionId || 'current'} onChange={event => { const id = event.target.value; setBusy(true); void run(() => api.switchRevision(task.id, id)).finally(() => setBusy(false)); }}><option value={task.activeRevisionId || 'current'}>{t('Current version', '当前版本')}</option>{task.revisions.map((revision, index) => <option key={revision.id} value={revision.id}>{revision.label || `${t('Version', '版本')} ${index + 1}`} · {new Date(revision.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>)}</select></label>{busy && <LoaderCircle className="spinning" size={13} />}<small>{t('Switches conversation history; existing file changes stay in place.', '切换对话历史；已执行的文件修改保持现状。')}</small></div>;
}
