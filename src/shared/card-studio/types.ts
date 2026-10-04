import type { VariableRow } from './variable-table.ts';
/**
 * 前端资源进卡的方式（编译选项）。
 * - `inline`：骨架、皮肤与 runtime 全部内联进替换内容（默认，向后兼容）。
 * - `cdn`：只写 `<link>`/`<script src>` 外链，指向一个**已发布的 https tag**；卡体积约减半，runtime 不再穿过酒馆的文本管线。
 */
export interface CardFrontendAssets { mode: 'inline' | 'cdn'; base: string }
/** 外链模式默认指向的已发布资产根：改 runtime 就发新 tag，并把这里（或卡项目里的 base）一起改掉。 */
export const DEFAULT_FRONTEND_ASSETS_BASE = 'https://testingcf.jsdelivr.net/gh/1798547983tt/Cardwright@v1.3.3/card-studio/frontend';
export const INLINE_FRONTEND_ASSETS: CardFrontendAssets = { mode: 'inline', base: '' };
/** Card studio data shared by the main process, the renderer and tests. */
import type { PreviewSegment, RegexStep } from './preview.ts';

export type CardKind = 'fan' | 'original';
export type CoverStyleId = 'vermilion' | 'archive' | 'terminal' | 'theatre' | 'gilded';
export type DispatchStatus = 'todo' | 'active' | 'done';
export type SectionState = 'todo' | 'active' | 'done';
/** How a planning conversation began: 从零开始制卡, 完善优化卡, or the change AI of a 改动单. */
export type PlanMode = 'scratch' | 'refine' | 'change';

export interface CardDispatch {
  id: string; target: string; sectionId: string | null; title: string; requires: string; body: string;
  status: DispatchStatus; createdAt: string; updatedAt: string; sourceTaskId?: string;
  /** A 改动派单: the 改动单 it came from. */ changeId?: string;
}

/** 改动单 (§5.4): a change asked for in one sentence (`request`), or an error log pasted in (`error`). */
export type CardChangeKind = 'request' | 'error';
/** `draft` while the 影响清单 waits for 照单开做; `running` and `paused` follow its one-click run; `dropped` once given up. */
export type CardChangeStatus = 'draft' | 'running' | 'paused' | 'done' | 'dropped';
/** One row of the 影响清单: a 派单 block the change AI wrote. It becomes a 改动派单 only at 照单开做. */
export interface CardChangeItem { id: string; target: string; sectionId: string | null; title: string; requires: string; body: string }
export interface CardChange {
  id: string; kind: CardChangeKind; text: string; status: CardChangeStatus;
  /** The planning conversation the change AI works in. */
  taskId?: string;
  items: CardChangeItem[];
  /** The 改动派单 照单开做 registered, in dependency order. */
  dispatchIds: string[];
  /** Only one component was affected: the files (project-relative) the change AI edited itself. */
  direct?: string[];
  /** The card had no design book when the change was asked for; the components are the reference. */
  noDesignBook?: boolean;
  /** 照单开做 asked the change AI to bring the design book in line; the run starts when that turn ends. */
  syncing?: boolean;
  /** What the change's run uses. */
  settings?: CardRunSettings;
  /** Why it paused, or what the final assembly check left. */
  note?: string;
  createdAt: string; updatedAt: string;
}

/**
 * A handoff the app asked for: `requested` while the AI writes the summary in reply to message `requestId`; `ready` with the
 * formatted summary once it did; `failed` when the reply had none; `consumed` once a new conversation received it.
 */
export interface CardHandoffState { status: 'requested' | 'ready' | 'failed' | 'consumed'; at: string; requestId?: string; summary?: string; /** Requested by one-click making, which sends the summary itself; the UI opens no draft. */ auto?: boolean }
/** Stored on a task that is a section conversation of a card project. */
export interface CardTaskInfo { sectionId: string; dispatchId?: string; mode?: PlanMode; web?: boolean; handoff?: CardHandoffState; /** A squad member of a card conversation (查资料 or 写组件), not a conversation of its own. */ member?: boolean; /** A member's kind and the files it may write (spec §6.3); a 1.2 reading-squad member has none and counts as 查资料. */ squad?: CardSquadAssignment; /** The conversation began with the (possibly overridden) kickoff line. */ kickoff?: boolean; /** The change AI's conversation of this 改动单. */ changeId?: string }
/** 子代理开关 (spec Q9, §5.4): the most a card conversation may dispatch. */
export type CardSquadMode = 'off' | 'read' | 'write';
/** The studio's squad settings (spec §5.4); absent means `{ mode: 'off', selfDispatch: true }`. */
export interface CardSquadSettings { mode: CardSquadMode; selfDispatch: boolean }
/** The two built-in card subagents (spec §5.1): 查资料 reads and reports back, 写组件 writes the components it is given. */
export type CardMemberRole = 'researcher' | 'writer';
/** A component a 写组件 made with card_new_component (spec §6.3): its name and its files, card-relative. */
export interface CardMemberComponent { name: string; paths: string[] }
/**
 * What a member was sent as (spec §5.2): its kind, the existing component files it may write, the component names it may
 * create; and what it created, which stays its own to write when it is sent again.
 */
export interface CardSquadAssignment { role: CardMemberRole; files: string[]; create: string[]; created?: CardMemberComponent[] }

/** One built-in card studio prompt as developer mode lists it; `stale` means the shipped default changed since the override was saved. */
export type PromptGroup = 'rules' | 'board' | 'section' | 'kickoff' | 'squad';
export interface PromptOverrideItem { id: string; label: string; group: PromptGroup; overridden: boolean; stale: boolean }
export interface PromptOverrideDetail extends PromptOverrideItem { text: string; defaultText: string }

export type CardThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type CardPermission = 'ask' | 'edit' | 'full';

/** Remembered per card in the app's data (gateways are local, so this never goes into the card folder). */
export interface CardSettings {
  /** The permission mode new conversations of this card start with; 'edit' when unset. */
  permission?: CardPermission;
  /** What 从零开始制卡 / 完善优化卡 start with. */
  kickoff?: { thinking?: CardThinking; gatewayId?: string; modelId?: string };
  /** What 一键制作 / 全部开做 last ran with. */
  run?: Partial<CardRunSettings>;
  /** 破限: the pack every conversation of this card sends; absent means off. */
  jailbreak?: { pack: string };
}

/** What may be saved onto a card; `jailbreak: null` is how the toggle is switched off. */
export type CardSettingsChange = Omit<CardSettings, 'jailbreak'> & { jailbreak?: { pack: string } | null };

/** 一键制作 covers one board; 全部开做 covers them all and ends with the assembly check; `change` runs one 改动单's dispatches. */
export type CardRunScope = 'all' | 'lore' | 'script' | 'regex' | 'greet' | 'change';
export type CardRunStatus = 'running' | 'pausing' | 'paused' | 'stopped' | 'completed';
export type CardRunPause = 'question' | 'refusal' | 'tool-failures' | 'check-errors' | 'model-error' | 'approval' | 'interjection' | 'user' | 'restart' | 'incomplete' | 'continue-limit';
export interface CardRunSettings { thinking: CardThinking; gatewayId: string; modelId?: string; permission: CardPermission; autoAnswer: boolean }
/**
 * One 一键制作 or 全部开做 run, stored on its card project. `queue` holds the dispatches still to do (the first is the
 * current one); `current.sent` are the messages the run itself sent for that dispatch, so anything else is the user's.
 */
export interface CardRun {
  id: string; scope: CardRunScope; status: CardRunStatus;
  /** Scope `change`: the 改动单 whose dispatches this run does. */
  changeId?: string;
  pause?: { reason: CardRunPause; message: string; at: string };
  settings: CardRunSettings;
  queue: string[]; total: number; done: string[];
  /** The dispatches that were already 进行中 when the run started, left there by a run that was stopped: the run goes on with them in their conversation instead of sending them whole. */
  pickedUp?: string[];
  current?: { dispatchId: string; taskId: string; stage: 'work' | 'fix'; sent: string[] };
  /** Every message the run sent or acknowledged, per conversation; anything else there is the user writing. */
  sentIds?: Record<string, string[]>;
  /** 分批写: the dispatch the run carries on with after the section AI said it was not finished, and how many 继续 the run sent for it since the user last pressed 继续 (CONTINUE_LIMIT). */
  continued?: { dispatchId: string; count: number };
  /** A change of conversation in progress: the old conversation writes its summary before this dispatch. */
  handoff?: { fromTaskId: string; dispatchId: string };
  /** The run's conversation in each section it worked in. */
  conversations: Record<string, string>;
  autoAnswered: Array<{ dispatchId: string; text: string }>;
  finalCheck?: { errors: number; warnings: number; at: string };
  startedAt: string; updatedAt: string; finishedAt?: string;
}

/** What the card library and the card project pages show for one registered card project. */
export interface CardProjectView {
  projectId: string; path: string; cardId: string; name: string; kind: CardKind; source?: string;
  coverStyle: CoverStyleId; cover?: string; stylePreset: { id: string; name: string } | null;
  /** 前端资源进卡的方式（编译选项）：内联，或者外链到一个已发布的 tag。 */
  frontendAssets: CardFrontendAssets;
  origin: 'new' | 'import'; createdAt: string; updatedAt: string; lastEditedAt: string;
  dispatches: CardDispatch[]; design: { exists: boolean; people: { written: number; total: number } | null };
  /** The card's 改动单, oldest first. */
  changes: CardChange[];
  sources: number; error?: string;
  /** World book entries in 世界书/未分类, which no section took on import (整理未分类). */
  unclassified: number;
  /** The card's 一键制作 / 全部开做 run, if any. */
  run?: CardRun;
  /** The card's 变量表: the authored one, or one derived from an imported card; `error` when the authored one does not parse. */
  variableTable?: { source: 'authored' | 'derived'; rows: number; error?: string };
}
export interface CardStudioSnapshot { resourceRoot: string; cards: CardProjectView[] }

/** One imported material file as recorded in the card project's source manifest. */
export interface SourceChapter { index: number; title: string; volume?: string; chars: number; path: string }
export type SourceSplit = { mode: 'headings'; level: string; parts: number } | { mode: 'fixed'; parts: number; size: number; manual: boolean };
export interface SourceRecord {
  name: string; kind: 'text' | 'json' | 'card-png' | 'image'; original: string; bytes: number; importedAt: string;
  encoding?: string; chars?: number; split?: SourceSplit; chapters?: SourceChapter[]; note?: string;
}
export interface SourceImportReport { imported: SourceRecord[]; rejected: Array<{ name: string; reason: string }> }
export interface NewCardProject { name: string; kind: CardKind; source?: string; folder: string }

/** What an import file turns out to be, shown before the card project is created. */
/** `mismatch`: a PNG whose chara and ccv3 payloads disagree; ccv3 is the one imported. */
export interface CardImportPreview { kind: 'card' | 'lorebook'; format: 'json' | 'png'; name: string; entries: number; regex: number; scripts: number; greetings: number; file: string; mismatch?: boolean }
export interface CardImportReport { lore: number; regex: number; scripts: number; greetings: number; issues: Array<{ level: 'error' | 'warning'; code: string; message: string; path?: string }> }
/** One finding of the assembly check. Errors block the export. */
export interface CardCheckFinding { level: 'error' | 'warning' | 'info'; code: string; message: string; path?: string; uid?: number }
export interface CardCheckReport { ok: boolean; findings: CardCheckFinding[]; stats: { entries: number; constantChars: number; constantTokens: number; sections: Record<string, number> }; checkedAt: string }
export interface NewCardComponent { board: 'lore' | 'regex' | 'script' | 'greeting'; section?: string; name: string; keys?: string[]; order?: number; constant?: boolean; position?: number; depth?: number; kind?: 'first' | 'alternate' | 'group'; format?: 'sheet' }
export interface CardComponentResult { uid: number; paramsPath: string; bodyPath: string; section?: string }
/** AI 归类建议: the section a model suggests for one unclassified world book entry, and why. Nothing moves until the author confirms. */
export interface CardLoreSuggestion { uid: number; section: string; reason: string }
/** One component as the section pages list it. */
export interface CardComponentSummary { uid: number; section: string; name: string; keys: number; chars: number; constant: boolean; disabled: boolean; order: number; bodyPath: string; paramsPath: string }
/** `report` comes with whole-card exports only and is not kept in the registration. */
export interface CardExportResult { kind: 'card' | 'lorebook' | 'png' | 'regex' | 'script' | 'pieces'; file: string; bytes: number; entries: number; at: string; report?: { file: string; text: string } }
/** What the assembly bench asks the author to confirm before exporting (§3.6 step 3). */
export interface CardMeta { name: string; creator: string; version: string; notes: string; tags: string[] }
/** One regex or 酒馆助手 script the project holds, for the section pages. */
export interface CardPieceSummary { kind: 'regex' | 'script'; name: string; title: string; chars: number; disabled: boolean; bodyPath: string; /** Compiled from a sheet (the floating status app); it has no file of its own. */ synthesized?: boolean }
/** What importing one regex or script piece did. */
export interface CardPieceImport { kind: 'regex' | 'script'; name: string; paramsPath: string; bodyPath: string; replaced: boolean }
/** One state of a local preview (a finished reply, or one still streaming): what each regex did, and the documents that show it. */
export interface CardPreviewState { label: string; steps: RegexStep[]; frames: Array<{ kind: PreviewSegment['kind']; url: string }>; external: string[] }
/** What a local preview shows: 正文美化, 变量更新, the status bar, the creation page. */
export type CardPreviewKind = 'body' | 'update' | 'status' | 'start';
/** The local preview of one kind. `notice` says why there is nothing to show. */
export interface CardPreview {
  kind: CardPreviewKind;
  /** Status previews: which form the sheet compiles to. */ form?: 'placeholder' | 'header' | 'floating';
  /** The stat_data the 模拟酒馆 starts from, as JSON. */ variables?: string;
  source: { from: 'sample' | 'variables' | 'sheet'; path: string } | null; notice: string | null; states: CardPreviewState[];
}
/** A picked image, already downsized for the crop dialog. */
export interface CoverSource { dataUrl: string; width: number; height: number }
/** 提改动: what to change, or the error log; the change AI starts with the effort and model the card's planning uses. */
export interface NewCardChange { kind: CardChangeKind; text: string; thinking?: CardThinking; gatewayId?: string; modelId?: string }
export interface StartCardConversation { projectId: string; sectionId: string; title?: string; dispatchId?: string; mode?: PlanMode; kickoff?: boolean; prompt?: string; web?: boolean; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; gatewayId?: string; modelId?: string; /** One-click making runs with its own permission mode. */ permission?: CardPermission }

/** One row of the 变量表 as the brief shows it. */
export interface CardVariableRowView { path: string; type: string; default: string; owner: string; when: string; note: string }
/** The 变量表 for the section brief; `stale` means the table changed after the variable files were generated. */
export interface CardVariableTableView { source: 'authored' | 'derived' | null; path: string; rows: CardVariableRowView[]; error?: string; stale?: boolean }
/** The 变量表 as data, for the table editor; `derived` is offered as a starting point and is never edited in place. */
export interface CardVariableTableEdit { source: 'authored' | 'derived' | null; path: string; rows: VariableRow[]; note?: string; error?: string }
/** What `card_sync_variables` wrote. */
export interface CardVariableSyncResult { rows: number; created: string[]; written: string[]; unchanged: string[] }
