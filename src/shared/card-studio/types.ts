/** Card studio data shared by the main process, the renderer and tests. */
import type { PreviewSegment, RegexStep } from './preview.ts';

export type CardKind = 'fan' | 'original';
export type CoverStyleId = 'vermilion' | 'archive' | 'terminal' | 'theatre' | 'gilded';
export type DispatchStatus = 'todo' | 'active' | 'done';
export type SectionState = 'todo' | 'active' | 'done';
export type PlanMode = 'scratch' | 'refine';

export interface CardDispatch {
  id: string; target: string; sectionId: string | null; title: string; requires: string; body: string;
  status: DispatchStatus; createdAt: string; updatedAt: string; sourceTaskId?: string;
}

/**
 * A handoff the app asked for: `requested` while the AI writes the summary in reply to message `requestId`; `ready` with the
 * formatted summary once it did; `failed` when the reply had none; `consumed` once a new conversation received it.
 */
export interface CardHandoffState { status: 'requested' | 'ready' | 'failed' | 'consumed'; at: string; requestId?: string; summary?: string; /** Requested by one-click making, which sends the summary itself; the UI opens no draft. */ auto?: boolean }
/** Stored on a task that is a section conversation of a card project. */
export interface CardTaskInfo { sectionId: string; dispatchId?: string; mode?: PlanMode; web?: boolean; handoff?: CardHandoffState; /** A read-only member of an Ultra planning squad, not a conversation of its own. */ member?: boolean; /** The conversation began with the (possibly overridden) kickoff line. */ kickoff?: boolean }

/** One built-in card studio prompt as developer mode lists it; `stale` means the shipped default changed since the override was saved. */
export type PromptGroup = 'rules' | 'board' | 'section' | 'kickoff';
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
}

/** 一键制作 covers one board; 全部开做 covers them all and ends with the assembly check. */
export type CardRunScope = 'all' | 'lore' | 'script' | 'regex' | 'greet';
export type CardRunStatus = 'running' | 'pausing' | 'paused' | 'stopped' | 'completed';
export type CardRunPause = 'question' | 'refusal' | 'tool-failures' | 'check-errors' | 'model-error' | 'approval' | 'interjection' | 'user' | 'restart';
export interface CardRunSettings { thinking: CardThinking; gatewayId: string; modelId?: string; permission: CardPermission; autoAnswer: boolean }
/**
 * One 一键制作 or 全部开做 run, stored on its card project. `queue` holds the dispatches still to do (the first is the
 * current one); `current.sent` are the messages the run itself sent for that dispatch, so anything else is the user's.
 */
export interface CardRun {
  id: string; scope: CardRunScope; status: CardRunStatus;
  pause?: { reason: CardRunPause; message: string; at: string };
  settings: CardRunSettings;
  queue: string[]; total: number; done: string[];
  current?: { dispatchId: string; taskId: string; stage: 'work' | 'fix'; sent: string[] };
  /** Every message the run sent or acknowledged, per conversation; anything else there is the user writing. */
  sentIds?: Record<string, string[]>;
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
  origin: 'new' | 'import'; createdAt: string; updatedAt: string; lastEditedAt: string;
  dispatches: CardDispatch[]; design: { exists: boolean; people: { written: number; total: number } | null };
  sources: number; error?: string;
  /** The card's 一键制作 / 全部开做 run, if any. */
  run?: CardRun;
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
export interface NewCardComponent { board: 'lore' | 'regex' | 'script' | 'greeting'; section?: string; name: string; keys?: string[]; order?: number; constant?: boolean; position?: number; depth?: number; kind?: 'first' | 'alternate' | 'group' }
export interface CardComponentResult { uid: number; paramsPath: string; bodyPath: string; section?: string }
/** One component as the section pages list it. */
export interface CardComponentSummary { uid: number; section: string; name: string; keys: number; chars: number; constant: boolean; disabled: boolean; order: number; bodyPath: string; paramsPath: string }
/** `report` comes with whole-card exports only and is not kept in the registration. */
export interface CardExportResult { kind: 'card' | 'lorebook' | 'png' | 'regex' | 'script' | 'pieces'; file: string; bytes: number; entries: number; at: string; report?: { file: string; text: string } }
/** What the assembly bench asks the author to confirm before exporting (§3.6 step 3). */
export interface CardMeta { name: string; creator: string; version: string; notes: string; tags: string[] }
/** One regex or 酒馆助手 script the project holds, for the section pages. */
export interface CardPieceSummary { kind: 'regex' | 'script'; name: string; title: string; chars: number; disabled: boolean; bodyPath: string }
/** What importing one regex or script piece did. */
export interface CardPieceImport { kind: 'regex' | 'script'; name: string; paramsPath: string; bodyPath: string; replaced: boolean }
/** One state of a local preview (a finished reply, or one still streaming): what each regex did, and the documents that show it. */
export interface CardPreviewState { label: string; steps: RegexStep[]; frames: Array<{ kind: PreviewSegment['kind']; url: string }>; external: string[] }
/** The local preview of 正文美化 or 变量更新. `notice` says why there is nothing to show. */
export interface CardPreview { kind: 'body' | 'update'; source: { from: 'sample' | 'variables'; path: string } | null; notice: string | null; states: CardPreviewState[] }
/** A picked image, already downsized for the crop dialog. */
export interface CoverSource { dataUrl: string; width: number; height: number }
export interface StartCardConversation { projectId: string; sectionId: string; title?: string; dispatchId?: string; mode?: PlanMode; kickoff?: boolean; prompt?: string; web?: boolean; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'; gatewayId?: string; modelId?: string; /** One-click making runs with its own permission mode. */ permission?: CardPermission }
