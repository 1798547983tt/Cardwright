import { useState, type ReactNode } from 'react';
import { Archive, ChevronRight, FolderOpen, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { useApp } from './context';
import { Field, Modal } from './primitives';
import { ContextMenu, type ContextAction, type MenuPosition } from './ContextMenu';

type Target = { kind: 'project' | 'task'; id: string };

/** Shared project/task context menus and rename dialog for the channel strip and task column. */
export function useNavActions({ selectedId, onNewTask }: { selectedId: string | null; onNewTask: (projectId: string) => void }): { openMenu: (target: Target, element: HTMLElement, point?: { x: number; y: number }) => void; element: ReactNode } {
  const { data, api, t, run, navigate } = useApp();
  const [menu, setMenu] = useState<(Target & { position: MenuPosition }) | null>(null);
  const [rename, setRename] = useState<(Target & { value: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  function openMenu(target: Target, element: HTMLElement, point?: { x: number; y: number }) {
    const rect = element.getBoundingClientRect();
    setMenu({ ...target, position: { x: point?.x ?? rect.right, y: point?.y ?? rect.bottom + 4, origin: element } });
  }
  const project = menu?.kind === 'project' ? data.projects.find(item => item.id === menu.id) : undefined;
  const task = menu?.kind === 'task' ? data.tasks.find(item => item.id === menu.id) : undefined;
  const actions: ContextAction[] = project ? [
    { label: t('New task', '新建任务'), icon: <Plus size={15} />, action: () => onNewTask(project.id) },
    { label: project.collapsed ? t('Expand project', '展开项目') : t('Collapse project', '折叠项目'), icon: <ChevronRight size={15} />, action: () => void run(() => api.updateProject(project.id, { collapsed: !project.collapsed })) },
    { label: t('Rename project', '重命名项目'), icon: <Pencil size={15} />, action: () => setRename({ kind: 'project', id: project.id, value: project.name }) },
    { label: project.pinned ? t('Unpin project', '取消置顶项目') : t('Pin project', '置顶项目'), icon: project.pinned ? <PinOff size={15} /> : <Pin size={15} />, action: () => void run(() => api.updateProject(project.id, { pinned: !project.pinned })) },
    { label: t('Open folder', '打开文件夹'), icon: <FolderOpen size={15} />, separator: true, action: () => void run(() => api.openPath(project.path)) },
  ] : task ? [
    { label: t('Open task', '打开任务'), icon: <ChevronRight size={15} />, action: () => navigate(task.id) },
    { label: t('Rename task', '重命名任务'), icon: <Pencil size={15} />, action: () => setRename({ kind: 'task', id: task.id, value: task.title }) },
    { label: task.pinned ? t('Unpin task', '取消置顶任务') : t('Pin task', '置顶任务'), icon: task.pinned ? <PinOff size={15} /> : <Pin size={15} />, action: () => void run(() => api.updateTask(task.id, { pinned: !task.pinned })) },
    { label: t('Open working folder', '打开工作目录'), icon: <FolderOpen size={15} />, action: () => void run(() => api.openPath(task.cwd)) },
    { label: t('Archive task', '归档任务'), icon: <Archive size={15} />, separator: true, disabled: ['running', 'waiting', 'queued'].includes(task.status), action: () => void run(async () => { await api.updateTask(task.id, { archived: true }); if (selectedId === task.id) navigate(null); }) },
  ] : [];
  const element = <>
    {menu && actions.length > 0 && <ContextMenu position={menu.position} actions={actions} label={menu.kind === 'project' ? t('Project actions', '项目操作') : t('Task actions', '任务操作')} onClose={() => setMenu(null)} />}
    {rename && <Modal title={rename.kind === 'project' ? t('Rename project', '重命名项目') : t('Rename task', '重命名任务')} className="small-modal" onClose={() => { if (!saving) setRename(null); }}>
      <form onSubmit={event => { event.preventDefault(); setSaving(true); void run(async () => { if (rename.kind === 'project') await api.updateProject(rename.id, { name: rename.value.trim() }); else await api.updateTask(rename.id, { title: rename.value.trim() }); setRename(null); }).finally(() => setSaving(false)); }}>
        <Field label={t('Name', '名称')}><input autoFocus required maxLength={160} value={rename.value} onChange={event => setRename({ ...rename, value: event.target.value })} /></Field>
        <div className="modal-actions"><button type="button" className="button" disabled={saving} onClick={() => setRename(null)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={saving || !rename.value.trim()}>{saving ? t('Saving…', '保存中…') : t('Save', '保存')}</button></div>
      </form>
    </Modal>}
  </>;
  return { openMenu, element };
}

/** Keyboard access to the same menu: Shift+F10 or the context-menu key. */
export const isMenuKey = (event: React.KeyboardEvent) => (event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu';
