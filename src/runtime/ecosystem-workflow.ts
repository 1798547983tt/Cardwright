import { createJiti } from 'jiti/static';
import { dirname, join } from 'node:path';
import { defineTool, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { chapterTitle } from '../shared/chapters.ts';
import type { AgentRole, Interaction, TodoItem, UserQuestion } from '../shared/types.ts';
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
  canDelegate: boolean; roles: AgentRole[]; isPlanMode: () => boolean;
  /** Present only in card studio section conversations. */
  card?: { newComponent: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>; check: (signal?: AbortSignal) => Promise<unknown>; searchSources: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
  /** Present only in workbench tasks; card studio conversations have no browser. */
  browser?: (action: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}
/**
 * The browser has its own gate: a site the user allowed, no password or payment typing. A second approval on every
 * click would only teach the user to click 允许, so these do not ask again; only the reads run in plan mode.
 */
export const BROWSER_READS = ['browser_read', 'browser_structure', 'browser_find', 'browser_screenshot', 'browser_console', 'browser_network'];
export const BROWSER_TOOLS = [...BROWSER_READS, 'browser_open', 'browser_click', 'browser_type'];
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
    defineTool({ name: 'card_new_component', label: 'New card component', description: 'Create one card component and get its uid from the application. Never invent a uid. board: lore (default, a world book entry), regex, script or greeting; section is a card studio section id such as lore-people; keys are the world book keywords.',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), board: Type.Optional(Type.String()), section: Type.Optional(Type.String()), keys: Type.Optional(Type.Array(Type.String())), order: Type.Optional(Type.Number()), constant: Type.Optional(Type.Boolean()), position: Type.Optional(Type.Number()), depth: Type.Optional(Type.Number()), kind: Type.Optional(Type.String()) }),
      execute: async (_id, args, signal) => textResult(await options.card!.newComponent(args as Record<string, unknown>, signal)) }),
    defineTool({ name: 'card_check', label: 'Card checks', description: 'Run the deterministic assembly checks over this card project and read the findings. Errors block the export.',
      parameters: Type.Object({}), execute: async (_id, _args, signal) => textResult(await options.card!.check(signal)) }),
    defineTool({ name: 'card_search_sources', label: 'Search material', description: 'Search the imported material chapters (资料/分章) for a person, event or phrase. Keywords: every word must appear in a line; regex: true for a regular expression. Returns file, material, chapter title, line number and snippet. Use it before reading chapters instead of running commands.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), regex: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), source: Type.Optional(Type.String()) }),
      execute: async (_id, args, signal) => textResult(await options.card!.searchSources(args as Record<string, unknown>, signal)) }),
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
  if (options.canDelegate) tools.push(
    defineTool({ name: 'agent', label: 'Subagent', description: 'Delegate one independent task with a Chinese name and clear deliverable. Roles: general-purpose, Explore (read-only), Plan. In a clean Git repository a writing member gets its own worktree; otherwise it writes in this same folder, so give it files no one else is changing. Collect its result before completing.', parameters: Type.Object({ subagent_type: Type.Optional(Type.String()), name: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })), prompt: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()), run_in_background: Type.Optional(Type.Boolean()) }), execute: async (_id, args, signal) => textResult(await options.delegate({ role: args.subagent_type || 'general-purpose', prompt: args.prompt, title: args.description, name: args.name }, signal)) }),
    defineTool({ name: 'agent_team', label: 'Subagent team', description: 'Delegate independent parts of substantial work to a temporary squad (up to 6). Give each member a distinct Chinese name and clear deliverable; collect results and integrate them. Without a clean Git repository writing members share this folder, so assign each member separate files. Use fewer members when the work is smaller.', parameters: Type.Object({ members: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 24 }), prompt: Type.String({ minLength: 1 }), role: Type.Optional(Type.String()) }), { minItems: 2, maxItems: 6 }) }), execute: async (_id, args, signal) => textResult(await options.team(args, signal)) }),
    defineTool({ name: 'get_subagent_result', label: 'Subagent results', description: 'Inspect child tasks or wait for selected children. IDs come from agent or agent_team. Omit agent_id to inspect or wait for all members of this task.', parameters: Type.Object({ agent_id: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }), execute: async (_id, args, signal) => textResult(await (args.wait ? options.wait : options.agents)({ ...(args.agent_id ? { taskIds: [args.agent_id] } : {}) }, signal)) }),
    defineTool({ name: 'steer_subagent', label: 'Steer subagent', description: 'Send a follow-up instruction to one of this task’s child agents.', parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }), execute: async (_id, args, signal) => textResult(await options.steer(args, signal)) }),
  );
  return {
    tools, publishTodos,
    restore(ctx: ExtensionContext) { state = replay.replayFromBranch(ctx); publishTodos(); },
    rolePrompt(role?: AgentRole): string { return role?.builtIn ? role.id === 'Explore' ? 'Role: Explore. Inspect the project and return findings; do not change files.' : role.id === 'Plan' ? 'Role: Plan. Inspect, clarify material decisions, and return an actionable plan.' : '' : role?.prompt || ''; },
    allowsInPlan(name: string, args: Record<string, unknown>): boolean {
      if (['read', 'ls', 'web_search', 'fetch_content', 'search_skills', 'use_skill', 'todo', 'ask_user_question', 'plan_mode_question', 'plan_mode_complete', 'ctx_search', 'ctx_memory', 'agent', 'agent_team', 'get_subagent_result', 'steer_subagent', 'card_check', 'card_search_sources', 'mark_chapter', ...BROWSER_READS].includes(name)) return true;
      return name === 'powershell' && policy.findBlockedPowerShellCommandSegment(String(args.command || ''), {}, options.cwd) === undefined;
    },
  };
}
