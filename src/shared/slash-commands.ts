/** Slash commands shared by the workbench and card studio composers; what each one does lives with its composer. */
export type SlashScope = 'card' | 'workbench';
export interface SlashCommand { name: string; label: string; description: { en: string; zh: string }; scopes: SlashScope[]; /** Only offered inside a conversation. */ needsTask?: boolean }
export interface SlashItem { id: string; kind: 'skill' | 'command'; label: string; insert: string; description: string; manual?: boolean; command?: string }
export interface SlashSkill { id?: string; path?: string; name: string; description: string; disableModelInvocation?: boolean }

const COMMANDS: SlashCommand[] = [
  { name: 'clear', label: '/clear', description: { en: 'Start a new conversation in this project', zh: '在这个项目里开新对话' }, scopes: ['workbench'], needsTask: true },
  { name: 'compact', label: '/compact', description: { en: 'Compact the context now', zh: '立即压缩上下文' }, scopes: ['card', 'workbench'], needsTask: true },
  { name: 'context', label: '/context', description: { en: 'Show context usage', zh: '查看上下文用量' }, scopes: ['card', 'workbench'], needsTask: true },
  { name: 'cost', label: '/cost', description: { en: 'Show what this conversation cost', zh: '查看这次对话的花费' }, scopes: ['card', 'workbench'], needsTask: true },
  { name: 'model', label: '/model', description: { en: 'Switch the model', zh: '切换模型' }, scopes: ['card', 'workbench'] },
  { name: 'resume', label: '/resume', description: { en: 'Go back to an earlier conversation', zh: '回到以前的对话' }, scopes: ['workbench'] },
  { name: 'rewind', label: '/rewind', description: { en: 'Go back to a checkpoint of this conversation', zh: '回到这次对话的某个检查点' }, scopes: ['workbench'], needsTask: true },
  { name: 'init', label: '/init', description: { en: "Write or update the project's instruction file", zh: '写出或更新项目说明文件' }, scopes: ['workbench'], needsTask: true },
  { name: 'help', label: '/help', description: { en: 'Commands and shortcuts', zh: '命令与快捷键' }, scopes: ['card', 'workbench'] },
  { name: 'plan', label: '/plan', description: { en: 'Switch planning mode', zh: '切换规划模式' }, scopes: ['workbench'], needsTask: true },
  { name: 'todos', label: '/todos', description: { en: 'View the task checklist', zh: '查看任务清单' }, scopes: ['workbench'], needsTask: true },
  { name: 'memory', label: '/memory', description: { en: 'View project memory', zh: '查看项目记忆' }, scopes: ['workbench'], needsTask: true },
  { name: 'dream', label: '/dream', description: { en: 'Organize project memory', zh: '整理项目记忆' }, scopes: ['workbench'], needsTask: true },
  { name: '检查', label: '/检查', description: { en: 'Run the assembly checks', zh: '运行拼装检查' }, scopes: ['card'] },
  { name: '标记完成', label: '/标记完成', description: { en: "Mark this conversation's dispatch done", zh: '把这个对话的派单标记完成' }, scopes: ['card'] },
  { name: '换对话', label: '/换对话', description: { en: 'Ask for a handoff summary and start a new conversation', zh: '请 AI 写交接摘要，再开新对话' }, scopes: ['card'] },
  { name: '下一步', label: '/下一步', description: { en: 'Open the next dispatch', zh: '打开下一条派单' }, scopes: ['card'] },
  { name: '改动', label: '/改动', description: { en: 'Ask for a change or paste an error; the change AI lists what it affects', zh: '提改动或贴报错，改动 AI 列出影响清单' }, scopes: ['card'] },
];

export function commandsFor(scope: SlashScope, options: { task?: boolean } = {}): SlashCommand[] {
  const inConversation = options.task ?? true;
  return COMMANDS.filter(command => command.scopes.includes(scope) && (inConversation || !command.needsTask));
}

/**
 * The menu for what is typed so far: null unless the text is a single slash word. Skills come first, then commands;
 * both match on their name. Nothing is cut off: the menu scrolls, so many skills never hide the commands.
 */
export function slashSuggestions(text: string, input: { skills: SlashSkill[]; commands: SlashCommand[]; language: 'zh' | 'en' }): SlashItem[] | null {
  const match = /^\/(?:skill:)?([^\s]*)$/.exec(text);
  if (!match) return null;
  const query = match[1].toLocaleLowerCase();
  const skills: SlashItem[] = input.skills.filter(skill => skill.name.toLocaleLowerCase().includes(query))
    .map(skill => ({ id: skill.id || skill.path || skill.name, kind: 'skill', label: `/${skill.name}`, insert: `/skill:${skill.name} `, description: skill.description, ...(skill.disableModelInvocation ? { manual: true } : {}) }));
  const commands: SlashItem[] = input.commands.filter(command => command.name.toLocaleLowerCase().includes(query))
    .map(command => ({ id: `command:${command.name}`, kind: 'command', label: command.label, insert: command.label, description: command.description[input.language], command: command.name }));
  return [...skills, ...commands];
}

/** The command a whole message names exactly, if any; anything else is sent as text. */
export function matchCommand(text: string, commands: SlashCommand[]): SlashCommand | undefined {
  const value = text.trim();
  return commands.find(command => command.label === value);
}

/** `/改动` takes the rest of the message as what to change: the text after it (possibly empty), or null for any other message. */
export function changeCommandText(text: string): string | null {
  const match = /^\/改动(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}
