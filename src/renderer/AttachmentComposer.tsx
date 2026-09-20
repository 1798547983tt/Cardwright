import { useEffect, useRef, useState, type RefObject } from 'react';
import { File, FileImage, Folder, LoaderCircle, Paperclip, X } from 'lucide-react';
import type { AttachmentInfo, FilePreview, WorkspaceEntry } from '../shared/studio-types';
import { useApp } from './context';
import { IconButton, Modal } from './primitives';
import './studio.css';

export function AttachmentPreview({ attachment, compact = false }: { attachment: AttachmentInfo; compact?: boolean }) {
  const { api, t, run } = useApp(); const [thumbnail, setThumbnail] = useState(''); const [preview, setPreview] = useState<FilePreview | null>(null); const [opening, setOpening] = useState(false);
  useEffect(() => { let disposed = false; if (attachment.kind === 'image') void api.attachmentPreview(attachment.id).then(value => { if (!disposed && value.kind === 'image') setThumbnail(value.dataUrl || ''); }).catch(() => undefined); return () => { disposed = true; }; }, [attachment.id, attachment.kind]);
  return <><button className={`attachment-preview ${compact ? 'compact' : ''}`} type="button" onClick={() => { setOpening(true); void run(() => api.attachmentPreview(attachment.id)).then(value => { if (value) setPreview(value); setOpening(false); }); }} aria-label={`${t('Preview', '预览')} ${attachment.name}`}>
    {opening ? <LoaderCircle size={18} className="spinning" /> : thumbnail ? <img src={thumbnail} alt="" /> : attachment.kind === 'image' ? <FileImage size={18} /> : <File size={18} />}<span><strong>{attachment.name}</strong>{!compact && <small>{attachment.kind === 'reference' ? t('Project reference', '项目引用') : `${Math.max(1, Math.round(attachment.bytes / 1024))} KB`}</small>}</span>
  </button>{preview && <Modal title={preview.name} onClose={() => setPreview(null)} className="attachment-modal">{preview.kind === 'image' && preview.dataUrl ? <img className="attachment-full-image" src={preview.dataUrl} alt={preview.name} /> : preview.kind === 'text' ? <><pre className="file-preview-text">{preview.text}</pre>{preview.truncated && <p className="muted">{t('Preview truncated.', '预览已截断。')}</p>}</> : <p className="muted">{t('This binary file cannot be displayed as text.', '此二进制文件无法显示为文本。')}</p>}</Modal>}</>;
}

export function MessageAttachments({ attachments }: { attachments?: AttachmentInfo[] }) { return attachments?.length ? <div className="message-attachments">{attachments.map(attachment => <AttachmentPreview key={attachment.id} attachment={attachment} />)}</div> : null; }

export function AttachmentComposer({ projectId, taskId, attachments, onChange, text, onText, textareaRef, disabled }: { projectId?: string; taskId?: string; attachments: AttachmentInfo[]; onChange: (items: AttachmentInfo[]) => void; text: string; onText: (text: string) => void; textareaRef: RefObject<HTMLTextAreaElement | null>; disabled?: boolean }) {
  const { api, t, run } = useApp(); const [busy, setBusy] = useState(false); const [dragging, setDragging] = useState(false); const [entries, setEntries] = useState<WorkspaceEntry[]>([]); const [selected, setSelected] = useState(0); const [closed, setClosed] = useState(false);
  const itemsRef = useRef(attachments); itemsRef.current = attachments; const currentText = useRef(text); currentText.current = text; const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const mention = /(?:^|\s)@([^\s@]*)$/.exec(text); const query = mention?.[1]; const choices = mention && !closed ? entries.slice(0, 8) : [];
  function append(items: AttachmentInfo[]) { const seen = new Set(itemsRef.current.map(item => item.id)); const next = [...itemsRef.current, ...items.filter(item => !seen.has(item.id))]; onChange(next); }
  async function importItems(action: () => Promise<AttachmentInfo[]>) { if (disabledRef.current) return; setBusy(true); const values = await run(action); if (values) append(values); setBusy(false); }
  useEffect(() => {
    const textarea = textareaRef.current; const region = textarea?.closest('.composer-region'); if (!textarea || !region) return;
    const paste = (event: ClipboardEvent) => { if (disabledRef.current || !Array.from(event.clipboardData?.items || []).some(item => item.type.startsWith('image/'))) return; event.preventDefault(); void importItems(async () => { const image = await api.pasteImage(); return image ? [image] : []; }); };
    const drag = (event: Event) => { const value = event as DragEvent; if (value.dataTransfer?.types.includes('Files')) { event.preventDefault(); setDragging(true); } };
    const leave = (event: Event) => { const value = event as DragEvent; if (!region.contains(value.relatedTarget as Node | null)) setDragging(false); };
    const drop = (event: Event) => { const value = event as DragEvent; if (!value.dataTransfer?.files.length) return; event.preventDefault(); setDragging(false); const paths = Array.from(value.dataTransfer.files).map(file => api.filePathForDrop(file)).filter(Boolean); if (paths.length) void importItems(() => api.importAttachments(paths)); };
    textarea.addEventListener('paste', paste); region.addEventListener('dragover', drag); region.addEventListener('dragleave', leave); region.addEventListener('drop', drop);
    return () => { textarea.removeEventListener('paste', paste); region.removeEventListener('dragover', drag); region.removeEventListener('dragleave', leave); region.removeEventListener('drop', drop); };
  }, [api, textareaRef, onChange]);
  useEffect(() => { setSelected(0); setClosed(false); if (query === undefined || !projectId) { setEntries([]); return; } let cancelled = false; const timer = setTimeout(() => { void api.workspaceFiles(projectId, '', query, taskId).then(values => { if (!cancelled) setEntries(values); }).catch(() => { if (!cancelled) setEntries([]); }); }, 140); return () => { cancelled = true; clearTimeout(timer); }; }, [query, projectId, taskId]);
  async function choose(entry: WorkspaceEntry) {
    if (!projectId) return; setClosed(true); onText(currentText.current.replace(/@([^\s@]*)$/, `@${entry.path} `)); await importItems(async () => [await api.attachReference(projectId, entry.path, taskId)]); textareaRef.current?.focus();
  }
  useEffect(() => {
    const textarea = textareaRef.current; if (!textarea || !choices.length) return;
    const key = (event: KeyboardEvent) => { if (event.isComposing) return; if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') setClosed(true); else if (event.key === 'Enter' || event.key === 'Tab') void choose(choices[Math.min(selected, choices.length - 1)]); else setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); } };
    textarea.addEventListener('keydown', key, true); return () => textarea.removeEventListener('keydown', key, true);
  }, [choices, selected, projectId]);
  return <div className={`attachment-composer ${dragging ? 'dragging' : ''}`}>
    {dragging && <div className="attachment-drop-target"><Paperclip size={20} />{t('Drop files to attach', '松开以添加附件')}</div>}
    {choices.length > 0 && <div className="reference-suggestions" role="listbox" aria-label={t('Project files', '项目文件')}><div className="slash-heading"><span>{t('Reference a file or folder', '引用文件或文件夹')}</span><small>↑ ↓ · Enter · Esc</small></div>{choices.map((entry, index) => <button key={entry.path} type="button" role="option" aria-selected={selected === index} className={selected === index ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => void choose(entry)}>{entry.directory ? <Folder size={16} /> : <File size={16} />}<span>{entry.path}</span></button>)}</div>}
    <div className="attachment-tray"><IconButton label={t('Attach files', '添加附件')} disabled={disabled || busy} onClick={() => void importItems(() => api.pickAttachments())}>{busy ? <LoaderCircle size={16} className="spinning" /> : <Paperclip size={16} />}</IconButton>{attachments.length === 0 ? <span className="attachment-hint">{t('Drop files · paste images · @ files', '拖入文件 · 粘贴截图 · @ 引用')}</span> : attachments.map(attachment => <div className="attachment-chip" key={attachment.id}><AttachmentPreview attachment={attachment} compact /><IconButton label={`${t('Remove attachment', '移除附件')} ${attachment.name}`} disabled={disabled} onClick={() => onChange(attachments.filter(item => item.id !== attachment.id))}><X size={12} /></IconButton></div>)}</div>
  </div>;
}
