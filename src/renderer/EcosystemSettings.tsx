import { useEffect, useRef, useState } from 'react';
import { Archive, Brain, Check, Cloud, Download, ExternalLink, Layers3, LoaderCircle, Pencil, Play, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, Users } from 'lucide-react';
import type { AgentRole, BackupPreview, McpServerConfig, MemoryItem } from '../shared/types';
import { useApp } from './context';
import { Empty, Field, IconButton, Modal, Row, Toggle } from './primitives';
import { HookSettings } from './HookSettings';

type EcosystemPage = 'preferences' | 'memory' | 'mcp' | 'roles' | 'hooks' | 'backup';

export function EcosystemSettings() {
  const { t } = useApp();
  const [page, setPage] = useState<EcosystemPage>('preferences');
  const pages = [
    { id: 'preferences' as const, label: t('Preferences', '运行偏好'), icon: Layers3 },
    { id: 'memory' as const, label: t('Memory', '项目记忆'), icon: Brain },
    { id: 'mcp' as const, label: 'MCP', icon: Plug },
    { id: 'roles' as const, label: t('Subagents', '子代理'), icon: Users },
    { id: 'hooks' as const, label: t('Hooks', '钩子'), icon: Play },
    { id: 'backup' as const, label: 'WebDAV', icon: Cloud },
  ];
  return <div className="ecosystem-settings"><nav className="ecosystem-tabs" aria-label={t('Workspace capabilities', '工作区能力')}>{pages.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><item.icon size={15} />{item.label}</button>)}</nav>
    {page === 'preferences' && <RuntimePreferences />}{page === 'memory' && <MemorySettings />}{page === 'mcp' && <McpSettings />}{page === 'roles' && <RoleSettings />}{page === 'hooks' && <HookSettings />}{page === 'backup' && <WebdavSettings />}
  </div>;
}

function RuntimePreferences() {
  const { data, api, t, run } = useApp();
  const toggles = [
    { key: 'memoryEnabled' as const, title: t('Automatic project memory', '自动项目记忆'), description: t('Carry useful context across sessions. Conversation compaction runs automatically; Dreamer starts only when you request it.', '在会话间保留有用上下文；对话自动压缩，Dreamer 深度整理仅在你主动启动时运行。') },
    { key: 'cacheEnabled' as const, title: t('Prompt cache optimization', '提示词缓存优化'), description: t('Optimize cache use on supported providers. Actual cache hits depend on the gateway.', '在支持的服务上优化缓存利用；实际命中取决于网关。') },
    { key: 'showStatusline' as const, title: t('Agent statusline', 'Agent 状态栏'), description: t('Keep model, run state, and reported usage visible below the composer.', '在输入框下显示模型、运行状态和已报告用量。') },
    { key: 'compactTools' as const, title: t('Compact tool records', '精简工具记录'), description: t('Use smaller tool rows; arguments and results remain expandable.', '缩小工具日志行，参数和结果仍可展开。') },
  ];
  return <><div className="section-heading"><div><h3>{t('Make the workspace yours', '让工作区更懂你')}</h3><p>{t('Choose how Cardwright keeps context and presents progress.', '选择 Cardwright 如何保留上下文、呈现工作进度。')}</p></div></div>{toggles.map(item => <Row key={item.key} title={item.title} description={item.description}><Toggle checked={data.ecosystem[item.key]} label={item.title} onChange={enabled => void run(() => api.saveEcosystem({ [item.key]: enabled }))} /></Row>)}
  </>;
}

function MemorySettings() {
  const { data, api, t, run, navigate } = useApp();
  const [projectId, setProjectId] = useState(data.projects[0]?.id || '');
  const [query, setQuery] = useState(''); const [content, setContent] = useState('');
  const [items, setItems] = useState<MemoryItem[]>([]); const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); const [dream, setDream] = useState(false); const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setItems([]); setError('');
    if (!projectId) return;
    setLoading(true);
    const timer = setTimeout(() => { void api.listMemories(projectId, query || undefined).then(result => { if (alive) setItems(result); }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (alive) setLoading(false); }); }, query ? 180 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, projectId, query, revision]);
  async function saveMemory() {
    if (!projectId || !content.trim() || busy) return;
    setBusy(true);
    const result = await run(async () => { await api.writeMemory(projectId, content.trim()); return true; });
    if (result) { setContent(''); setRevision(value => value + 1); } setBusy(false);
  }
  if (!data.projects.length) return <Empty icon={<Brain size={28} />} title={t('Memory belongs to a project', '记忆跟随项目')} text={t('Add a project folder before viewing and maintaining its memories.', '添加项目文件夹后，即可查看和维护对应记忆。')} />;
  return <><div className="section-heading"><div><h3>{t('Useful context that stays with your project', '留住项目中有用的上下文')}</h3><p>{t('Inspect, add, and archive memories. Dreamer is always started manually.', '查看、补充或归档记忆；Dreamer 始终由你手动启动。')}</p></div><IconButton label={t('Refresh memory', '刷新记忆')} disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? 'spinning' : ''} /></IconButton></div>
    <div className="memory-controls"><select aria-label={t('Memory project', '记忆所属项目')} value={projectId} onChange={event => { setProjectId(event.target.value); setContent(''); }}>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button className="button small" disabled={busy} onClick={() => setDream(true)}><Brain size={15} />{t('Run Dreamer', '运行 Dreamer')}</button></div>
    <form className="memory-composer" onSubmit={event => { event.preventDefault(); void saveMemory(); }}><Field label={t('Add a project memory', '添加项目记忆')} hint={t('Write stable decisions, conventions, or project facts worth remembering.', '记录值得保留的稳定决策、规范或项目事实。')}><textarea rows={3} value={content} onChange={event => setContent(event.target.value)} placeholder={t('For example: all API responses use the shared Result type.', '例如：所有 API 响应统一使用 Result 类型。')} disabled={busy} /></Field><button className="button small" disabled={busy || !content.trim()}><Plus size={14} />{t('Save memory', '保存记忆')}</button></form>
    <div className="search-field memory-search"><Search size={16} /><input aria-label={t('Search memory', '搜索记忆')} value={query} placeholder={t('Search project memories…', '搜索项目记忆…')} onChange={event => setQuery(event.target.value)} /></div>
    {loading ? <p className="ecosystem-loading"><LoaderCircle size={16} className="spinning" />{t('Loading memories…', '加载记忆中…')}</p> : error ? <p role="alert" className="search-test-result failure">{error}</p> : items.length ? <div className="memory-list">{items.map(item => <article key={item.id}><div className="memory-item-content">{item.category && <span className="badge">{item.category}</span>}<p>{item.content}</p><small>{[item.source, item.createdAt ? new Date(item.createdAt).toLocaleString() : ''].filter(Boolean).join(' · ')}</small></div><IconButton label={t('Archive memory', '归档记忆')} disabled={busy || item.source === 'journal'} onClick={() => { setBusy(true); void run(async () => { await api.archiveMemory(projectId, item.id); setRevision(value => value + 1); }).finally(() => setBusy(false)); }}><Archive size={16} /></IconButton></article>)}</div> : <p className="ecosystem-empty">{query ? t('No memories match this search.', '没有匹配的记忆。') : t('No memories yet. Add one above or start a conversation in this project.', '暂时没有记忆。可在上方添加，或在该项目中开始对话。')}</p>}
    {dream && <Modal title={t('Organize project memory?', '整理项目记忆？')} onClose={() => { if (!busy) setDream(false); }} className="small-modal"><p className="modal-intro">{t('Dreamer starts an agent task using your default model to consolidate this project’s memory. This uses model tokens and follows the task’s permission controls.', 'Dreamer 将使用默认模型启动 Agent 任务，整理该项目的记忆。这会消耗模型 Token，并遵循任务权限控制。')}</p><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setDream(false)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={busy || !data.gateways.length} onClick={() => { setBusy(true); void run(() => api.dreamMemory(projectId)).then(task => { setBusy(false); if (task) { setDream(false); navigate(task.id); } }); }}>{busy ? t('Starting…', '启动中…') : t('Start Dreamer task', '启动 Dreamer 任务')}</button></div></Modal>}
  </>;
}

function McpSettings() {
  const { data, api, t, run } = useApp();
  const [editing, setEditing] = useState<McpServerConfig | 'new' | null>(null);
  const [deleting, setDeleting] = useState<McpServerConfig | null>(null);
  return <><div className="section-heading"><div><h3>{t('Connect your tools with MCP', '通过 MCP 连接工具')}</h3><p>{t('Connect an existing local command or HTTP server. Server tools follow task permissions.', '连接已有的本地命令或 HTTP 服务；服务工具遵循任务权限。')}</p></div><button className="button small" onClick={() => setEditing('new')}><Plus size={15} />{t('Add server', '添加服务')}</button></div>
    {data.ecosystem.mcpServers.length ? <div className="ecosystem-config-list">{data.ecosystem.mcpServers.map(server => <article key={server.id}><Plug size={19} /><div><h4>{server.name}<span className="badge">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span></h4><p>{server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url}</p>{server.hasSecrets && <small>{t('Private credentials saved', '已保存私密凭据')}</small>}</div><div className="ecosystem-row-actions"><Toggle label={`${t('Enable', '启用')} ${server.name}`} checked={server.enabled} onChange={enabled => void run(() => api.saveMcpServer({ ...server, enabled }))} /><IconButton label={`${t('Edit', '编辑')} ${server.name}`} onClick={() => setEditing(server)}><Pencil size={15} /></IconButton><IconButton label={`${t('Remove', '移除')} ${server.name}`} onClick={() => setDeleting(server)}><Trash2 size={15} /></IconButton></div></article>)}</div> : <Empty icon={<Plug size={27} />} title={t('Your tools, connected', '连接自己的工具')} text={t('No MCP servers configured. Add one you already use; Cardwright does not automatically install servers.', '尚未配置 MCP 服务。可添加已有服务，Cardwright 不会自动安装服务。')} />}
    <p className="settings-footnote">{t('MCP changes apply to new agent runs. Private environment values and HTTP headers stay in encrypted desktop storage.', 'MCP 配置对新启动的 Agent 生效。私密环境变量与 HTTP 请求头保存在桌面端的加密存储中。')}</p>
    {editing && <McpEditor key={editing === 'new' ? 'new' : editing.id} server={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {deleting && <Modal title={t('Remove MCP server?', '移除 MCP 服务？')} className="small-modal" onClose={() => setDeleting(null)}><p className="modal-intro">{deleting.name} · {t('Remove its connection settings and saved credentials.', '移除其连接设置及已保存的凭据。')}</p><div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>{t('Cancel', '取消')}</button><button className="button danger" onClick={() => void run(async () => { await api.removeMcpServer(deleting.id); setDeleting(null); })}>{t('Remove server', '移除服务')}</button></div></Modal>}
  </>;
}

function McpEditor({ server, onClose }: { server?: McpServerConfig; onClose: () => void }) {
  const { api, t, run } = useApp();
  const [value, setValue] = useState<McpServerConfig>(server || { id: crypto.randomUUID(), name: '', enabled: true, transport: 'stdio', command: '', args: [] });
  const [args, setArgs] = useState(JSON.stringify(server?.args || [], null, 2));
  const [secrets, setSecrets] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save() {
    setError(''); let argumentList: string[]; let privateConfig: { env?: Record<string, string>; headers?: Record<string, string> } | undefined;
    try {
      argumentList = value.transport === 'stdio' ? JSON.parse(args) : [];
      if (!Array.isArray(argumentList) || argumentList.some(argument => typeof argument !== 'string')) throw new Error(t('Arguments must be a JSON array of strings.', '参数必须是 JSON 字符串数组。'));
      if (secrets.trim()) {
        privateConfig = JSON.parse(secrets);
        if (!privateConfig || typeof privateConfig !== 'object' || Array.isArray(privateConfig) || Object.keys(privateConfig).some(key => !['env', 'headers'].includes(key))) throw new Error(t('Use an object with env and/or headers.', '请使用包含 env 和／或 headers 的对象。'));
        for (const map of Object.values(privateConfig)) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(item => typeof item !== 'string')) throw new Error(t('Private values must be string-to-string maps.', '私密配置必须是键和值均为字符串的映射。'));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    setBusy(true);
    const result = await run(async () => { await api.saveMcpServer({ ...value, name: value.name.trim(), command: value.transport === 'stdio' ? value.command?.trim() : undefined, args: argumentList, url: value.transport === 'http' ? value.url?.trim() : undefined }, privateConfig); return true; }, t('MCP server saved', 'MCP 服务已保存'));
    setBusy(false); if (result) onClose();
  }
  return <Modal title={server ? t('Edit MCP server', '编辑 MCP 服务') : t('Add MCP server', '添加 MCP 服务')} onClose={() => { if (!busy) onClose(); }} className="gateway-modal"><form onSubmit={event => { event.preventDefault(); void save(); }}><div className="form-grid"><Field label={t('Server name', '服务名称')}><input autoFocus required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field><Field label={t('Transport', '连接方式')}><select value={value.transport} onChange={event => setValue({ ...value, transport: event.target.value as McpServerConfig['transport'] })}><option value="stdio">{t('Local command (stdio)', '本地命令（stdio）')}</option><option value="http">HTTP</option></select></Field></div>
    {value.transport === 'stdio' ? <><Field label={t('Command', '命令')} hint={t('An installed executable, such as node. Put each argument in the array below.', '已安装的可执行程序，例如 node。每项参数填写在下方数组中。')}><input required value={value.command || ''} onChange={event => setValue({ ...value, command: event.target.value })} placeholder="node" spellCheck={false} /></Field><Field label={t('Arguments (JSON array)', '参数（JSON 数组）')}><textarea value={args} onChange={event => setArgs(event.target.value)} rows={3} spellCheck={false} placeholder={'["C:/tools/server.mjs"]'} /></Field></> : <Field label={t('MCP server URL', 'MCP 服务地址')}><input type="url" required value={value.url || ''} onChange={event => setValue({ ...value, url: event.target.value })} placeholder="https://tools.example.com/mcp" spellCheck={false} /></Field>}
    <Field label={t('Private environment and headers (JSON)', '私密环境变量及请求头（JSON）')} hint={server?.hasSecrets ? t('Credentials are saved. Leave blank to keep them; {} clears them.', '已有凭据。留空保留，填写 {} 清除。') : t('Optional. Values are encrypted by the desktop process and never returned to this editor.', '可选。内容由桌面进程加密，不会返回此编辑器。')}><textarea className="private-config" aria-label={t('MCP private configuration', 'MCP 私密配置')} autoComplete="off" value={secrets} onChange={event => setSecrets(event.target.value)} rows={4} spellCheck={false} placeholder={'{"env": {"API_TOKEN": "..."}, "headers": {"Authorization": "Bearer ..."}}'} /></Field><label className="checkbox-row"><input type="checkbox" checked={value.enabled} onChange={event => setValue({ ...value, enabled: event.target.checked })} /><span>{t('Enable this server', '启用此服务')}</span></label>{error && <p role="alert" className="search-test-result failure">{error}</p>}<div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button><button className="button primary" disabled={busy}>{busy ? t('Saving…', '保存中…') : t('Save server', '保存服务')}</button></div></form></Modal>;
}

function RoleSettings() {
  const { data, api, t, run } = useApp();
  const [editing, setEditing] = useState<AgentRole | 'new' | null>(null);
  const [removing, setRemoving] = useState<AgentRole | null>(null);
  const sourceLabel = (role: AgentRole) => role.source === 'project' ? t('Project · .claude/agents', '项目 · .claude/agents')
    : role.source === 'user' ? t('You · .claude/agents', '用户 · .claude/agents')
    : role.builtIn ? t('Built-in', '内置') : t('Your own', '自建');
  const shadow = (role: AgentRole) => data.ecosystem.roles.find(item => item.id === role.shadowedBy);
  return <><div className="section-heading"><div><h3>{t('Subagents', '子代理')}</h3><p>{t('Pick one when you start a task or send a parallel agent. Cardwright also reads the agents in ~/.claude/agents and each project’s .claude/agents.', '新建任务或派并行 Agent 时可以选一个。Cardwright 也会读取 ~/.claude/agents 和每个项目的 .claude/agents 里的子代理。')}</p></div><button className="button small" onClick={() => setEditing('new')}><Plus size={15} />{t('Add subagent', '添加子代理')}</button></div>
    <div className="ecosystem-config-list">{data.ecosystem.roles.map(role => <article key={role.id} className={role.enabled === false || role.shadowedBy ? 'is-off' : ''}><Users size={18} /><div>
      <h4>{role.name}<span className="badge">{sourceLabel(role)}</span>{role.readOnly && <span className="badge">{t('Read only', '只读')}</span>}{role.model && <span className="badge">{role.model}</span>}</h4>
      <p>{role.description || role.prompt}</p>
      {role.path && <small className="agent-path" title={role.path}>{role.path}{role.tools?.length ? ` · ${t('tools', '工具')}: ${role.tools.join(', ')}` : ''}</small>}
      {role.shadowedBy && <small className="agent-shadow">{t(`Another subagent of this name takes precedence: ${shadow(role)?.name ?? role.shadowedBy}`, `同名子代理优先：${shadow(role)?.name ?? role.shadowedBy}`)}</small>}
    </div><div className="ecosystem-row-actions">
      <Toggle label={`${t('Enable', '启用')} ${role.name}`} checked={role.enabled !== false} onChange={enabled => void run(() => api.setAgentEnabled(role.id, enabled))} />
      {!role.builtIn && !role.source?.match(/project|user/) && <><IconButton label={`${t('Edit', '编辑')} ${role.name}`} onClick={() => setEditing(role)}><Pencil size={15} /></IconButton><IconButton label={`${t('Remove', '移除')} ${role.name}`} onClick={() => setRemoving(role)}><Trash2 size={15} /></IconButton></>}
    </div></article>)}</div>
    {editing && <RoleEditor role={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    {removing && <Modal title={t('Remove this subagent?', '移除这个子代理？')} onClose={() => setRemoving(null)} className="small-modal"><p className="modal-intro">{removing.name}</p><div className="modal-actions"><button className="button" onClick={() => setRemoving(null)}>{t('Cancel', '取消')}</button><button className="button danger" onClick={() => void run(async () => { await api.removeAgentRole(removing.id); setRemoving(null); })}>{t('Remove subagent', '移除子代理')}</button></div></Modal>}
  </>;
}

function RoleEditor({ role, onClose }: { role?: AgentRole; onClose: () => void }) {
  const { api, t, run } = useApp();
  const [value, setValue] = useState<AgentRole>(role || { id: '', name: '', prompt: '', readOnly: false });
  const [busy, setBusy] = useState(false);
  return <Modal title={role ? t('Edit subagent', '编辑子代理') : t('Add subagent', '添加子代理')} onClose={() => { if (!busy) onClose(); }} className="gateway-modal"><form onSubmit={event => { event.preventDefault(); setBusy(true); void run(async () => { await api.saveAgentRole({ ...value, id: value.id.trim(), name: value.name.trim(), prompt: value.prompt.trim() }); return true; }).then(result => { setBusy(false); if (result) onClose(); }); }}><div className="form-grid"><Field label={t('Role ID', '角色 ID')} hint={t('Stable lowercase identifier, e.g. reviewer.', '稳定的小写标识，例如 reviewer。')}><input autoFocus={!role} required disabled={!!role} pattern="[a-z0-9][a-z0-9-]*" value={value.id} onChange={event => setValue({ ...value, id: event.target.value })} /></Field><Field label={t('Display name', '显示名称')}><input autoFocus={!!role} required value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></Field></div><Field label={t('Role instructions', '角色指令')}><textarea required rows={7} value={value.prompt} onChange={event => setValue({ ...value, prompt: event.target.value })} /></Field><label className="checkbox-row"><input type="checkbox" checked={value.readOnly} onChange={event => setValue({ ...value, readOnly: event.target.checked })} /><span>{t('Read-only role', '只读角色')}<small>{t('Restrict the agent to inspection and analysis.', '将此 Agent 限定为检查和分析。')}</small></span></label><div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>{t('Cancel', '取消')}</button><button className="button primary" disabled={busy}>{busy ? t('Saving…', '保存中…') : t('Save subagent', '保存子代理')}</button></div></form></Modal>;
}

function WebdavSettings() {
  const { data, api, t, run } = useApp();
  const saved = data.ecosystem.webdav;
  const [url, setUrl] = useState(saved.url); const [username, setUsername] = useState(saved.username); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<{ source: 'local' | 'remote'; value: BackupPreview } | null>(null);
  const [message, setMessage] = useState(''); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = url !== saved.url || username !== saved.username || !!password;
  async function showPreview(source: 'local' | 'remote') {
    setBusy(true); setMessage('');
    const result = await run(() => api.previewBackup(source));
    if (mounted.current) { if (result) setPreview({ source, value: result }); setBusy(false); }
  }
  async function sync() {
    if (!preview || busy) return;
    setBusy(true);
    const result = await run(() => preview.source === 'local' ? api.pushBackup() : api.pullBackup());
    if (mounted.current) { setBusy(false); if (result) { setMessage(result.message); setPreview(null); } }
  }
  return <><div className="section-heading"><div><h3>{t('Your knowledge, ready to move', '让知识资料随时可迁移')}</h3><p>{t('Manually sync settings without secrets, skills, roles, and memories. Review the file list before each transfer.', '手动同步无密钥配置、技能、角色和记忆；每次传输前查看文件清单。')}</p></div><span className="badge">{t('Manual sync', '手动同步')}</span></div><form onSubmit={event => { event.preventDefault(); setBusy(true); void run(async () => { await api.saveWebdav({ url: url.trim(), username: username.trim() }, password || undefined); return true; }, t('WebDAV settings saved', 'WebDAV 设置已保存')).then(result => { if (result) setPassword(''); setBusy(false); }); }}><Field label={t('WebDAV folder URL', 'WebDAV 文件夹地址')}><input type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://dav.example.com/cardwright/" spellCheck={false} /></Field><div className="form-grid"><Field label={t('Username', '用户名')}><input value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" /></Field><Field label={t('Password / app password', '密码／应用密码')} hint={saved.hasPassword ? t('A password is saved. Leave blank to keep it.', '已保存密码，留空保留。') : t('Stored encrypted on this computer.', '在本机加密保存。')}><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder={saved.hasPassword ? '••••••••••••' : ''} autoComplete="off" /></Field></div><button className="button" disabled={busy || !dirty}><Check size={15} />{t('Save WebDAV', '保存 WebDAV')}</button></form>
    <div className="plain-note"><ShieldCheck size={18} /><p>{t('Credential files, private configuration, conversation history, and project source files are excluded. Review your skills, instructions, and memories for secrets before uploading. Nothing uploads automatically.', '备份排除凭据文件、私密配置、对话历史和项目源码。上传前请审阅技能、指令和记忆，确认未手动写入密钥。不会自动上传资料。')}</p></div><div className="webdav-actions"><button className="button" disabled={busy || dirty || !saved.url} onClick={() => void showPreview('local')}><Upload size={16} />{t('Preview upload', '预览上传')}</button><button className="button" disabled={busy || dirty || !saved.url} onClick={() => void showPreview('remote')}><Download size={16} />{t('Preview restore', '预览恢复')}</button>{busy && !preview && <LoaderCircle size={16} className="spinning" />}</div>{dirty && <p className="settings-footnote">{t('Save connection settings before previewing a transfer.', '保存连接设置后，可预览传输。')}</p>}{message && <p className="search-test-result success" role="status">{message}</p>}
    {preview && <Modal title={preview.source === 'local' ? t('Review upload', '确认上传内容') : t('Review restore', '确认恢复内容')} onClose={() => { if (!busy) setPreview(null); }} className="backup-modal"><p className="modal-intro">{preview.source === 'local' ? t('Upload this backup to the saved WebDAV folder. An existing remote backup may be replaced.', '将此备份上传至已保存的 WebDAV 文件夹，可能替换已有远程备份。') : t('Restore these files from the saved WebDAV folder. Matching local settings and knowledge files may be replaced.', '从已保存的 WebDAV 文件夹恢复这些文件，可能替换本机对应设置与知识资料。')}</p><div className="backup-summary"><span>{preview.value.files.length} {t('files', '个文件')}</span><span>{preview.value.bytes.toLocaleString()} {t('bytes', '字节')}</span><time>{new Date(preview.value.createdAt).toLocaleString()}</time></div><ul className="backup-file-list">{preview.value.files.map(path => <li key={path}>{path}</li>)}</ul><p className="settings-footnote">{t('Excluded', '已排除')}：{preview.value.excludes.join(' · ')}</p><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setPreview(null)}>{t('Cancel', '取消')}</button><button className="button primary" disabled={busy} onClick={() => void sync()}>{busy ? t('Transferring…', '传输中…') : preview.source === 'local' ? t('Upload these files', '上传这些文件') : t('Restore these files', '恢复这些文件')}</button></div></Modal>}
  </>;
}
