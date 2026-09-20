import { useState } from 'react';
import { Download, LoaderCircle, Play, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useApp } from './context';
import { Empty, Field, IconButton, Modal } from './primitives';
import { HOOK_EVENTS, countHooks, type HookEvent, type HooksConfig } from '../core/hooks-config';

const DESCRIPTIONS: Record<HookEvent, { en: string; zh: string }> = {
  SessionStart: { en: 'When a task starts or resumes its agent', zh: '任务启动或恢复 Agent 时' },
  UserPromptSubmit: { en: 'Before your message goes to the model · exit 2 stops it', zh: '你的消息发给模型之前 · 退出码 2 可拦下' },
  PreToolUse: { en: 'Before a tool runs · exit 2 refuses the call', zh: '工具执行之前 · 退出码 2 可拒绝这次调用' },
  PostToolUse: { en: 'After a tool ran · exit 2 sends a note back to the model', zh: '工具执行之后 · 退出码 2 的说明回给模型' },
  Stop: { en: 'When a round ends', zh: '一轮结束时' },
  SubagentStop: { en: 'When a subagent task ends', zh: '子代理任务结束时' },
  Notification: { en: 'When Cardwright notifies you', zh: '应用要发通知时' },
};

/** Hooks run the user's own commands, so this page says so plainly and never imports anything on its own (§6.2). */
export function HookSettings() {
  const { data, api, t, run } = useApp();
  const hooks = data.hooks || {};
  const [event, setEvent] = useState<HookEvent>('PreToolUse');
  const [matcher, setMatcher] = useState('');
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<string>('');
  const [importing, setImporting] = useState(false);

  async function save(next: HooksConfig) { await run(() => api.saveHooks(next), t('Hooks saved', '钩子已保存')); }
  async function add() {
    if (!command.trim() || busy) return;
    setBusy(true);
    const entry = { ...(matcher.trim() ? { matcher: matcher.trim() } : {}), hooks: [{ type: 'command' as const, command: command.trim(), ...(timeout.trim() ? { timeout: Number(timeout) } : {}) }] };
    const next: HooksConfig = { ...hooks, [event]: [...(hooks[event] ?? []), entry] };
    const done = await run(() => api.saveHooks(next), t('Hook added', '钩子已添加'));
    if (done !== undefined) { setCommand(''); setMatcher(''); setTimeoutValue(''); }
    setBusy(false);
  }
  async function remove(target: HookEvent, entryIndex: number, hookIndex: number) {
    const entries = (hooks[target] ?? []).map((entry, index) => index !== entryIndex ? entry : { ...entry, hooks: entry.hooks.filter((_, position) => position !== hookIndex) }).filter(entry => entry.hooks.length);
    const next: HooksConfig = { ...hooks };
    if (entries.length) next[target] = entries; else delete next[target];
    await save(next);
  }
  async function test(target: HookEvent, value: string, seconds?: number) {
    setBusy(true); setTested('');
    const result = await run(() => api.testHook(target, value, seconds, data.projects[0]?.id));
    if (result) setTested(result.decision === 'deny' ? t(`Blocked: ${result.reason ?? ''}`, `会拦下：${result.reason ?? ''}`) : result.messages.join('\n') || t('Ran with no output.', '运行完成，没有输出。'));
    setBusy(false);
  }

  return <>
    <div className="section-heading"><div><h3>{t('Hooks', '钩子')}</h3><p>{t('Run your own commands around the agent’s work, in the same shape as Claude Code’s settings.json. They run as you, in PowerShell, in the task’s folder.', '在 Agent 工作的前后运行你自己的命令，写法与 Claude Code 的 settings.json 相同。命令以你的身份、在任务目录里用 PowerShell 运行。')}</p></div><button className="button small" onClick={() => setImporting(true)}><Download size={15} />{t('Import from Claude Code', '从 Claude Code 导入')}</button></div>
    <p className="hook-warning"><ShieldAlert size={15} />{t('A hook is a command on this computer. Cardwright never adds one by itself and never runs the hooks in your Claude Code settings unless you import them here.', '钩子就是本机命令。Cardwright 不会自己添加钩子，也不会运行你 Claude Code 设置里的钩子，除非你在这里导入。')}</p>
    {countHooks(hooks) === 0 ? <Empty icon={<Play size={26} />} title={t('No hooks yet', '还没有钩子')} text={t('Add one below, or import what you already use in Claude Code.', '在下面添加一个，或导入你在 Claude Code 里已经在用的钩子。')} />
      : <div className="ecosystem-config-list hook-list">{HOOK_EVENTS.filter(item => hooks[item]?.length).map(item => <article key={item}><div>
        <h4>{item}<span className="badge">{data.preferences.language === 'zh' ? DESCRIPTIONS[item].zh : DESCRIPTIONS[item].en}</span></h4>
        {(hooks[item] ?? []).map((entry, entryIndex) => entry.hooks.map((hook, hookIndex) => <div key={`${entryIndex}-${hookIndex}`} className="hook-row">
          {entry.matcher && <code className="hook-matcher">{entry.matcher}</code>}
          <code className="hook-command">{hook.command}</code>
          {hook.timeout && <small>{hook.timeout}s</small>}
          <IconButton label={t('Try it', '试跑')} disabled={busy} onClick={() => void test(item, hook.command, hook.timeout)}><Play size={14} /></IconButton>
          <IconButton label={t('Remove hook', '移除钩子')} disabled={busy} onClick={() => void remove(item, entryIndex, hookIndex)}><Trash2 size={14} /></IconButton>
        </div>))}
      </div></article>)}</div>}
    {tested && <pre className="hook-test-output">{tested}</pre>}
    <form className="hook-form" onSubmit={submit => { submit.preventDefault(); void add(); }}>
      <div className="form-grid">
        <Field label={t('Event', '事件')}><select value={event} onChange={change => setEvent(change.target.value as HookEvent)}>{HOOK_EVENTS.map(item => <option key={item} value={item}>{item}</option>)}</select></Field>
        <Field label={t('Tool matcher (PreToolUse / PostToolUse)', '工具匹配器（PreToolUse / PostToolUse）')} hint={t('A pattern over the tool name, for example write|edit. Empty means every tool.', '对工具名的匹配式，例如 write|edit。留空表示所有工具。')}><input value={matcher} onChange={change => setMatcher(change.target.value)} placeholder="write|edit" spellCheck={false} /></Field>
      </div>
      <Field label={t('Command', '命令')} hint={t('The event arrives as JSON on standard input. Exit 0 passes, 2 blocks where blocking is possible, anything else is reported.', '事件以 JSON 从标准输入进入。退出码 0 通过，2 在可拦下的事件里拦下，其他算出错并提示。')}><textarea required rows={3} value={command} onChange={change => setCommand(change.target.value)} spellCheck={false} placeholder={'$e = [Console]::In.ReadToEnd() | ConvertFrom-Json; Write-Output $e.tool_name'} /></Field>
      <div className="form-grid">
        <Field label={t('Timeout (seconds)', '超时（秒）')} hint={t('60 seconds when empty.', '留空为 60 秒。')}><input type="number" min={1} max={600} value={timeout} onChange={change => setTimeoutValue(change.target.value)} /></Field>
        <div className="hook-form-actions"><button className="button primary small" disabled={busy || !command.trim()}><Plus size={15} />{t('Add hook', '添加钩子')}</button>{busy && <LoaderCircle size={15} className="spinning" />}</div>
      </div>
    </form>
    {importing && <ImportDialog onClose={() => setImporting(false)} />}
  </>;
}

/** The import preview: what each settings file holds, what Cardwright cannot run, and nothing applied until asked. */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const { data, api, t, run } = useApp();
  const [found, setFound] = useState<Array<{ source: string; path: string; hooks: HooksConfig; skipped: string[] }> | null>(null);
  const [projectId, setProjectId] = useState(data.projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  async function look() { setBusy(true); const result = await run(() => api.claudeCodeHooks(projectId || undefined)); setFound(result ?? []); setBusy(false); }
  async function apply() {
    if (!found?.length) return;
    setBusy(true);
    const merged: HooksConfig = { ...(data.hooks || {}) };
    for (const file of found) for (const [event, entries] of Object.entries(file.hooks)) merged[event as HookEvent] = [...(merged[event as HookEvent] ?? []), ...entries];
    const done = await run(() => api.saveHooks(merged), t('Hooks imported', '钩子已导入'));
    setBusy(false);
    if (done !== undefined) onClose();
  }
  return <Modal title={t('Import hooks from Claude Code', '从 Claude Code 导入钩子')} onClose={() => { if (!busy) onClose(); }} className="gateway-modal">
    <p className="modal-intro">{t('Cardwright reads ~/.claude/settings.json and the project’s .claude/settings.json, shows what they hold, and adds nothing until you say so.', 'Cardwright 会读取 ~/.claude/settings.json 和项目的 .claude/settings.json，先列出内容，你确认后才写入。')}</p>
    <Field label={t('Project', '项目')}><select value={projectId} onChange={change => setProjectId(change.target.value)}><option value="">{t('User settings only', '只看用户设置')}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
    <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => void look()}>{busy ? <LoaderCircle size={15} className="spinning" /> : <Download size={15} />}{t('Look', '查看')}</button></div>
    {found && (found.length ? <div className="hook-import-list">{found.map(file => <article key={file.path}>
      <h4>{file.source === 'project' ? t('Project', '项目') : t('User', '用户')}<small>{file.path}</small></h4>
      {Object.entries(file.hooks).map(([event, entries]) => <div key={event} className="hook-row"><code>{event}</code><span>{entries.reduce((sum, entry) => sum + entry.hooks.length, 0)} {t('commands', '条命令')}</span></div>)}
      {file.skipped.length > 0 && <small className="hook-skipped">{t(`Not supported here: ${file.skipped.join(', ')}`, `这里不支持：${file.skipped.join('、')}`)}</small>}
    </article>)}</div> : <p className="ecosystem-empty">{t('No hooks found in those files.', '这些文件里没有钩子。')}</p>)}
    {found && found.length > 0 && <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button><button type="button" className="button primary" disabled={busy} onClick={() => void apply()}>{t('Add these hooks', '添加这些钩子')}</button></div>}
  </Modal>;
}
