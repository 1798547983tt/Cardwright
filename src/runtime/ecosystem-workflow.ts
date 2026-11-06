import { createJiti } from 'jiti/static';
import { dirname, join } from 'node:path';
import { defineTool, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { chapterTitle } from '../shared/chapters.ts';
import { DISPATCH_BATCH_LIMIT } from '../shared/card-studio/dispatch.ts';
import type { AgentRole, Interaction, TodoItem, UserQuestion } from '../shared/types.ts';
import { canonicalRoleId, type RoleSummary } from '../shared/agents.ts';
import { resolveEcosystemPackage } from './ecosystem-skills.ts';

type Result = { content: Array<{ type: 'text'; text: string }>; details: unknown; terminate?: boolean };
interface NativeTodo { id: number; subject: string; description?: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted'; blockedBy?: number[] }
interface TodoState { tasks: NativeTodo[]; nextId: number }
interface NativeQuestion { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }
export interface WorkflowOptions {
  cwd: string; ask: (interaction: Omit<Interaction, 'id' | 'taskId'>, signal?: AbortSignal) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => void;
  delegate: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  team: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  agents: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  wait: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  steer: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  canDelegate: boolean; roles: RoleSummary[]; isPlanMode: () => boolean;
  /** The lead's 成员额度, as the app holds it: how many members it may have at once. The dispatch tools say so. */
  squadSize: number;
  /** Present only in card studio section conversations. */
  card?: { newComponent: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>; check: (signal?: AbortSignal) => Promise<unknown>; syncVariables: (signal?: AbortSignal) => Promise<unknown>; searchSources: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>; /** Planning that starts or refines a card: card_add_dispatches (§5.6). */ addDispatches?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
  /** Present only in workbench tasks; card studio conversations have no browser. */
  browser?: (action: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}
/**
 * The browser has its own gate: a site the user allowed, no password or payment typing. A second approval on every
 * click would only teach the user to click 允许, so these do not ask again; only the reads run in plan mode.
 */
export const BROWSER_READS = ['browser_read', 'browser_structure', 'browser_find', 'browser_screenshot', 'browser_console', 'browser_network'];
export const BROWSER_TOOLS = [...BROWSER_READS, 'browser_open', 'browser_click', 'browser_type'];
/** The squad tools by the names the model sees (1.3.0 §5.2). Task histories from 1.2 keep the old names as recorded. */
export const MEMBER_TOOLS: readonly string[] = ['dispatch_member', 'dispatch_team', 'member_result', 'message_member'];
/** The ones that start or steer a member; none of them may run while a lead sums up its squad's final reports. */
export const DISPATCH_TOOLS: readonly string[] = ['dispatch_member', 'dispatch_team', 'message_member'];

/** The role list in the dispatch tools' descriptions, one line each: `编号`（界面名）：一句说明 (§5.2). The caller picks the roles. */
export function describeRoles(roles: { id: string; label: string; description: string; readOnly: boolean }[]): string {
  return roles.map(role => `- \`${role.id}\`（${role.label}）：${role.description.replace(/[。.]\s*$/, '')}${role.readOnly ? '；只读' : ''}`).join('\n');
}
const textResult = (value: unknown): Result => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: value });

/** Field names and constraints are the contract; upstream tutorial prose is not. */
function leanSchema(schema: TSchema): TSchema {
  return JSON.parse(JSON.stringify(schema, (key, value: unknown) => key === 'description' && typeof value === 'string' ? undefined : value)) as TSchema;
}

export async function createWorkflow(options: WorkflowOptions) {
  const jiti = createJiti(process.argv[1], { interopDefault: false });
  async function upstream<T>(name: string, path: string): Promise<T> { return await jiti.import(join(dirname(resolveEcosystemPackage(name)), path)) as T; }
  const todo = await upstream<{ TodoParamsSchema: TSchema }>('@juicesharp/rpiv-todo', 'tool/types.ts');
  const reducer = await upstream<{ applyTaskMutation(state: TodoState, action: string, args: Record<string, unknown>): { state: TodoState; op: unknown } }>('@juicesharp/rpiv-todo', 'state/state-reducer.ts');
  const replay = await upstream<{ replayFromBranch(ctx: ExtensionContext): TodoState }>('@juicesharp/rpiv-todo', 'state/replay.ts');
  const envelope = await upstream<{ buildToolResult(action: string, args: Record<string, unknown>, state: TodoState, operation: unknown): Result }>('@juicesharp/rpiv-todo', 'tool/response-envelope.ts');
  const question = await upstream<{ QuestionParamsSchema: TSchema }>('@juicesharp/rpiv-ask-user-question', 'tool/types.ts');
  const questionValidator = await upstream<{ validateQuestionnaire(value: { questions: NativeQuestion[] }): { ok: boolean; message?: string } }>('@juicesharp/rpiv-ask-user-question', 'tool/validate-questionnaire.ts');
  const questionResponse = await upstream<{ buildQuestionnaireResponse(answer: unknown, params: unknown): Result }>('@juicesharp/rpiv-ask-user-question', 'tool/response-envelope.ts');
  const completion = await upstream<{ PLAN_MODE_COMPLETE_PARAMS: TSchema; normalizePlanModeCompletion(input: unknown): { ok: boolean; plan?: string; error?: string }; planModeCompleted(plan: string): Result }>('@narumitw/pi-plan-mode', 'src/completion-tool.ts');
  const planQuestion = await upstream<{ PLAN_MODE_QUESTION_PARAMS: TSchema }>('@narumitw/pi-plan-mode', 'src/question-tool.ts');
  const policy = await upstream<{ findBlockedPowerShellCommandSegment(command: string, safe?: object, cwd?: string): string | undefined }>('@narumitw/pi-plan-mode', 'src/tool-policy.ts');
  let state: TodoState | undefined;
  function publishTodos() {
    const todos: TodoItem[] = (state?.tasks || []).filter(task => task.status !== 'deleted').map(task => ({ id: String(task.id), content: task.subject, status: task.status === 'deleted' ? 'cancelled' : task.status, dependsOn: task.blockedBy?.map(String) }));
    options.emit({ type: 'workflow_todos', todos }); return todos;
  }
  const cardTools: ToolDefinition[] = options.card ? [
    defineTool({ name: 'card_new_component', label: 'New card component', description: "Create one card component and get its uid from the application. Never invent a uid. board: lore (default, a world book entry), regex, script or greeting; section is a card studio section id such as lore-people; keys are the world book keywords. format: 'sheet' creates a 装配单 (.yaml) instead of an HTML body for a regex.",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), board: Type.Optional(Type.String()), section: Type.Optional(Type.String()), keys: Type.Optional(Type.Array(Type.String())), order: Type.Optional(Type.Number()), constant: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Number()), depth: Type.Optional(Type.Number()), kind: Type.Optional(Type.String()), format: Type.Optional(Type.Literal('sheet')) }),
      execute: async (_id, args, signal) => textResult(await options.card!.newComponent(args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'card_check', label: 'Card checks', description: 'Run the deterministic assembly checks over this card project and read the findings. Errors block the export.',
      parameters: Type.Object({}), execute: async (_id, _args, signal) => textResult(await options.card!.check(signal)) }),
    defineTool({ name: 'card_sync_variables', label: 'Generate variable files', description: 'After writing or changing 变量表.yaml in the card project root: the application generates the Zod script, the disabled [initvar] entry, the fixed 变量列表 and 变量输出格式 entries, the path list at the end of 变量规则 and the prompt-cleanup regex, then runs the checks. Returns what it created or rewrote and the check errors and warnings. Never write those files by hand.',
      parameters: Type.Object({}), execute: async (_id, _args, signal) => textResult(await options.card!.syncVariables(signal)) }),
    defineTool({ name: 'card_search_sources', label: 'Search material', description: 'Search the imported material chapters (资料/分章) for a person, event or phrase. Keywords: every word must appear in a line; regex: true for a regular expression. Returns file, material, chapter title, line number and snippet. Use it before reading chapters instead of running commands.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), regex: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), source: Type.Optional(Type.String()) }),
      execute: async (_id, args, signal) => textResult(await options.card!.searchSources(args as Record<string, unknown>, signal)) }),
    // One-click making sends dispatches in the order they were registered, so two calls in one reply must not run side by side:
    // `executionMode` is the agent loop's own flag and never reaches the model request (pi-agent-core, executeToolCalls).
    ...(options.card.addDispatches ? [defineTool({ name: 'card_add_dispatches', label: 'Register dispatches', description: `Planning only, after the design book is written: register dispatches for the sections, 1-${DISPATCH_BATCH_LIMIT} per call, one board per call, in the planned order. target is 板块/分区 such as 世界书/人设 (a board with one section: just its name, such as 开场白); title is new within its section; prerequisite is optional; body is everything the section AI needs. brief is a short summary of what this dispatch needs. references name the design book headings, the variable table or the source index the section should read: give path and heading (the app finds the lines) or an explicit offset and lines. Returns a result for each item: fix and resend only the refused ones.`,
      parameters: Type.Object({ dispatches: Type.Array(Type.Object({
        target: Type.String(), title: Type.String(), prerequisite: Type.Optional(Type.String()), body: Type.String(),
        brief: Type.Optional(Type.String({ description: 'Short summary of what this dispatch needs; shown to the section before it reads anything.' })),
        references: Type.Optional(Type.Array(Type.Object({
          path: Type.String({ description: 'Project-relative file, such as 设计书.md or 变量表.yaml.' }),
          heading: Type.Optional(Type.String({ description: 'Heading in that file; the app resolves it to its line range.' })),
          offset: Type.Optional(Type.Integer({ minimum: 1 })),
          lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          summary: Type.Optional(Type.String({ description: 'Why the section needs these lines.' })),
        }), { maxItems: 8 })),
      }), { minItems: 1, maxItems: DISPATCH_BATCH_LIMIT }) }),
      executionMode: 'sequential',
      execute: async (_id, args, signal) => textResult(await options.card!.addDispatches!(args as Record<string, unknown>, signal)) })] : []),
  ] : [];
  // The built-in browser, for workbench tasks only (§6.4); every call still goes through tool approval.
  const browserTools: ToolDefinition[] = options.browser ? [
    defineTool({ name: 'browser_open', label: 'Open a page', description: 'Open a web page in the built-in browser. Local addresses open straight away; any other site needs the user to allow it once in the browser panel. Returns the tab id.',
      parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2000 }), tabId: Type.Optional(Type.String()) }),
      execute: async (_id, args, signal) => textResult(await options.browser!('open', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_read', label: 'Read the page', description: 'The visible text of the page in the built-in browser.',
      parameters: Type.Object({ tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('read', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_structure', label: 'Read the elements', description: 'The interactive elements of the page: role, name and a ref to click or type into.',
      parameters: Type.Object({ tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('structure', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_find', label: 'Find an element', description: 'Find elements whose name contains this text; returns their refs.',
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 200 }), tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('find', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_click', label: 'Click', description: 'Click the element with this ref (from browser_structure or browser_find).',
      parameters: Type.Object({ ref: Type.String({ minLength: 1, maxLength: 20 }), tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('click', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_type', label: 'Type', description: 'Type text into the element with this ref. Password and payment fields are always refused; ask the user to fill those in.',
      parameters: Type.Object({ ref: Type.String({ minLength: 1, maxLength: 20 }), text: Type.String({ maxLength: 4000 }), tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('type', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_screenshot', label: 'Screenshot', description: 'A picture of the page as it looks now.',
      parameters: Type.Object({ tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => {
        const shot = await options.browser!('screenshot', args as Record<string, unknown>, signal) as { data: string; width: number; height: number };
        return { content: [{ type: 'image', mimeType: 'image/png', data: shot.data }, { type: 'text', text: `页面截图 ${shot.width}×${shot.height}。` }] } as unknown as Result;
      } }),
    defineTool({ name: 'browser_console', label: 'Console messages', description: 'What the page printed to its console.',
      parameters: Type.Object({ tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('console', args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'browser_network', label: 'Network requests', description: 'The requests the page made, with their status.',
      parameters: Type.Object({ tabId: Type.Optional(Type.String()) }), execute: async (_id, args, signal) => textResult(await options.browser!('network', args as Record<string, unknown>, signal)) }),
  ] : [];
  const tools: ToolDefinition[] = [
    ...cardTools,
    ...browserTools,
    // Long conversations read better with the phases marked; the workbench turns these into chapters (§6.3).
    defineTool({ name: 'mark_chapter', label: 'Mark chapter', description: 'Mark the start of a new phase of this conversation, such as moving from investigating to fixing. One short title (up to 40 characters), only when the work really changes phase; a second mark in the same turn replaces the first.',
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 40 }) }),
      execute: async (_id, args) => { const title = chapterTitle(String((args as Record<string, unknown>).title ?? '')); if (!title) return textResult('A chapter needs a short title.'); options.emit({ type: 'workflow_chapter', title }); return textResult(`Chapter marked: ${title}`); } }),
    defineTool({ name: 'todo', label: 'Todo', description: 'Track multi-step work. Create with subject; update id/status; use blockedBy for dependencies. Never mark incomplete work completed.', parameters: leanSchema(todo.TodoParamsSchema),
      execute: async (_id, params, _signal, _update, ctx) => {
        state ??= replay.replayFromBranch(ctx);
        const args = params as Record<string, unknown>; const action = String(args.action);
        const next = reducer.applyTaskMutation(state, action, args); state = next.state; publishTodos();
        return envelope.buildToolResult(action, args, state, next.op);
      } }),
    defineTool({ name: 'ask_user_question', label: 'Ask user', description: 'Ask up to four questions when a user decision is needed. Supply concise choices; the UI adds free text. Always wait for real answers.', parameters: leanSchema(question.QuestionParamsSchema),
      execute: async (_id, params, signal) => {
        const typed = params as { questions: NativeQuestion[] }; const valid = questionValidator.validateQuestionnaire(typed);
        if (!valid.ok) throw new Error(valid.message || 'Invalid questionnaire.');
        const questions: UserQuestion[] = typed.questions.map((q, i) => ({ ...q, id: String(i) }));
        const answers = await options.ask({ type: 'questionnaire', title: 'Questions / 需要你的选择', questions }, signal);
        if (!answers || typeof answers !== 'object') return questionResponse.buildQuestionnaireResponse({ cancelled: true, answers: [] }, typed);
        const answerMap = answers as Record<string, unknown>;
        return questionResponse.buildQuestionnaireResponse({ cancelled: false, answers: typed.questions.map((q, i) => {
          const value = answerMap[String(i)];
          return { questionIndex: i, question: q.question, kind: Array.isArray(value) ? 'multi' : q.options.some(o => o.label === value) ? 'option' : 'custom', answer: Array.isArray(value) ? null : String(value ?? ''), ...(Array.isArray(value) ? { selected: value.map(String) } : {}) };
        }) }, typed);
      } }),
    defineTool({ name: 'plan_mode_question', label: 'Plan questions', description: 'Ask concise structured questions while making a plan.', parameters: leanSchema(planQuestion.PLAN_MODE_QUESTION_PARAMS),
      execute: async (_id, params, signal) => {
        const questions = (params as { questions: UserQuestion[] }).questions;
        const answer = await options.ask({ type: 'questionnaire', title: 'Plan decisions / 计划决策', questions }, signal);
        return textResult({ questions, answers: answer, cancelled: answer === null });
      } }),
    defineTool({ name: 'plan_mode_complete', label: 'Submit plan', description: 'Submit the complete implementation plan for user review. This stops the planning run; implementation only starts after user approval.', parameters: leanSchema(completion.PLAN_MODE_COMPLETE_PARAMS),
      execute: async (_id, params) => {
        if (!options.isPlanMode()) throw new Error('Enable plan mode before submitting a plan.');
        const result = completion.normalizePlanModeCompletion(params); if (!result.ok || !result.plan) throw new Error(result.error || 'Invalid plan.');
        options.emit({ type: 'workflow_plan', text: result.plan, status: 'pending' }); return completion.planModeCompleted(result.plan);
      } }),
  ];
  // The app passes the subagents this lead may dispatch, already one line each (stage 3).
  const roleList = describeRoles(options.roles);
  // The lead's 成员额度 (Q26), told where it picks members. A squad is still 2 to 6 members per call, within what the quota leaves.
  const quota = Number.isInteger(options.squadSize) && options.squadSize >= 1 && options.squadSize <= 6 ? options.squadSize : 6;
  const memberQuota = `Your member quota is ${quota}: you may hold at most ${quota === 1 ? '1 member' : `${quota} members`} at once (working or queued); a member that has returned frees its place.`;
  const teamQuota = quota === 1
    ? 'Your member quota is 1: you may hold only one member at a time, so a squad of 2 or more is refused. Use dispatch_member to send one member at a time.'
    : `Your member quota is ${quota}: you may hold at most ${quota} members at once (working or queued, counting those you dispatched earlier), so a squad that does not fit is refused; a member that has returned frees its place.`;
  // Card members work in the lead's card folder with what files and create give a 写组件 (spec §6.3); the workbench has worktrees.
  const whereMember = options.card
    ? 'Members work in this card folder: a 写组件 writes only the files and new components you give it in files and create, never the shared files, so give no two of them the same file.'
    : 'In a clean Git repository a writing member gets its own worktree; otherwise it writes in this same folder, so give it files no one else is changing.';
  const whereTeam = options.card
    ? 'Members work in this card folder: give each 写组件 its own files and new components in files and create.'
    : 'Without a clean Git repository writing members share this folder, so assign each member separate files.';
  const filesField = Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: options.card ? 'For a 写组件 only: existing component files it may change, as paths relative to the card folder, such as 世界书/人设/120-红孩儿.md.' : 'For card studio members only; leave it out here.' }));
  const createField = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20, description: options.card ? 'For a 写组件 only: names of the new components it may make with card_new_component.' : 'For card studio members only; leave it out here.' }));
  if (options.canDelegate) tools.push(
    defineTool({ name: 'dispatch_member', label: 'Dispatch member', description: `Dispatch one squad member for one independent task, with a Chinese name and a clear deliverable. ${whereMember} ${memberQuota} Collect its result with member_result before completing. role is one of:\n${roleList}`,
      parameters: Type.Object({ role: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })), title: Type.Optional(Type.String()), files: filesField, create: createField }),
      execute: async (_id, args, signal) => textResult(await options.delegate({ role: args.role, prompt: args.task, title: args.title, name: args.name, files: args.files, create: args.create }, signal)) }),
    defineTool({ name: 'dispatch_team', label: 'Dispatch team', description: `Dispatch independent parts of substantial work to a temporary squad of 2 to 6 members per call. ${teamQuota} Give each member a distinct Chinese name and a clear deliverable; collect the results and integrate them. ${whereTeam} Use fewer members when the work is smaller. A member's role is one of:\n${roleList}`,
      parameters: Type.Object({ members: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 24 }), task: Type.String({ minLength: 1 }), role: Type.Optional(Type.String()), files: filesField, create: createField }), { minItems: 2, maxItems: 6 }) }),
      execute: async (_id, args, signal) => textResult(await options.team({ members: args.members.map(member => ({ name: member.name, prompt: member.task, ...(member.role ? { role: member.role } : {}), ...(member.files ? { files: member.files } : {}), ...(member.create ? { create: member.create } : {}) })) }, signal)) }),
    defineTool({ name: 'member_result', label: 'Member results', description: 'Inspect squad members or wait for them. IDs come from dispatch_member or dispatch_team. Omit member_id to inspect or wait for every member of this task.',
      parameters: Type.Object({ member_id: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args, signal) => textResult(await (args.wait ? options.wait : options.agents)({ ...(args.member_id ? { taskIds: [args.member_id] } : {}) }, signal)) }),
    defineTool({ name: 'message_member', label: 'Message member', description: 'Send a follow-up instruction to one of this task’s squad members.',
      parameters: Type.Object({ member_id: Type.String(), message: Type.String() }),
      execute: async (_id, args, signal) => textResult(await options.steer({ agent_id: args.member_id, message: args.message }, signal)) }),
  );
  return {
    tools, publishTodos,
    restore(ctx: ExtensionContext) { state = replay.replayFromBranch(ctx); publishTodos(); },
    rolePrompt(role?: AgentRole): string {
      if (!role?.builtIn) return role?.prompt || '';
      const id = canonicalRoleId(role.id);
      return id === 'explorer' ? 'Role: explorer. Inspect the project and return findings; do not change files.' : id === 'planner' ? 'Role: planner. Inspect, clarify material decisions, and return an actionable plan.' : '';
    },
    allowsInPlan(name: string, args: Record<string, unknown>): boolean {
      if (['read', 'ls', 'web_search', 'fetch_content', 'search_skills', 'use_skill', 'todo', 'ask_user_question', 'plan_mode_question', 'plan_mode_complete', 'ctx_search', 'ctx_memory', ...MEMBER_TOOLS, 'card_check', 'card_search_sources', 'mark_chapter', ...BROWSER_READS].includes(name)) return true;
      return name === 'powershell' && policy.findBlockedPowerShellCommandSegment(String(args.command || ''), {}, options.cwd) === undefined;
    },
  };
}
