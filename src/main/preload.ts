import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, Bridge } from '../shared/types.ts';
import { studioBridge } from './studio-preload.ts';
import { applyAppUpdate, appUpdateRevision, type AppUpdate } from '../shared/app-updates.ts';

const invoke = <T>(name: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`cardwright:${name}`, ...args);
let current: AppSnapshot | null = null; let refreshing: Promise<AppSnapshot> | undefined;
const listeners = new Set<(snapshot: AppSnapshot) => void>(); const updateListeners = new Set<(update: AppUpdate) => void>(); const pending: AppUpdate[] = [];
function emit(update: AppUpdate) {
  if (current) for (const listener of listeners) listener(current);
  for (const listener of updateListeners) listener(update);
}
function refresh(): Promise<AppSnapshot> {
  if (refreshing) return refreshing;
  refreshing = invoke<AppSnapshot>('snapshot').then(snapshot => {
    const known = current ? appUpdateRevision(current) ?? 0 : 0;
    let replaced = false;
    if (!current || (snapshot.publicationRevision ?? 0) > known) { current = applyAppUpdate(null, { type: 'snapshot', snapshot, revision: snapshot.publicationRevision }); replaced = true; }
    for (const update of pending.splice(0)) if ((update.revision ?? 0) > (current ? appUpdateRevision(current) ?? 0 : 0)) { current = applyAppUpdate(current, update); replaced = true; }
    if (replaced) emit({ type: 'snapshot', snapshot: current!, revision: appUpdateRevision(current!) });
    // WeakMap revision metadata does not cross contextBridge. Snapshot callers
    // need the explicit current watermark even after many accepted patches.
    return { ...current!, publicationRevision: appUpdateRevision(current!) };
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}
ipcRenderer.on('cardwright:update', (_event, update: AppUpdate) => {
  if (current && (update.revision ?? 0) <= (appUpdateRevision(current) ?? 0)) return;
  if (!current && update.type !== 'snapshot') { if (pending.length < 100) pending.push(update); void refresh().catch(() => undefined); return; }
  try { current = applyAppUpdate(current, update); emit(update); }
  catch { pending.length = 0; current = null; void refresh().catch(() => undefined); }
});
const bridge: Bridge = {
  ...studioBridge,
  snapshot: () => refresh(),
  subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  },
  subscribeUpdates: listener => {
    updateListeners.add(listener);
    if (current) listener({ type: 'snapshot', snapshot: current, revision: appUpdateRevision(current) });
    return () => { updateListeners.delete(listener); };
  },
  pickProject: () => invoke('pickProject'), addProject: path => invoke('addProject', path),
  updateProject: (id, changes) => invoke('updateProject', id, changes),
  regenerate: (id, messageId, text) => invoke('regenerate', id, messageId, text), switchRevision: (id, revisionId) => invoke('switchRevision', id, revisionId),
  resumeAgent: (id, message) => invoke('resumeAgent', id, message),
  setSkillEnabled: (id, enabled) => invoke('setSkillEnabled', id, enabled), setAgentEnabled: (id, enabled) => invoke('setAgentEnabled', id, enabled),
  saveHooks: hooks => invoke('saveHooks', hooks), claudeCodeHooks: projectId => invoke('claudeCodeHooks', projectId), testHook: (event, command, timeout, projectId) => invoke('testHook', event, command, timeout, projectId), fetchModels: (input, key) => invoke('fetchModels', input, key),
  createTask: input => invoke('createTask', input), prompt: (id, text, behavior, attachments) => invoke('prompt', id, text, behavior, attachments),
  cancelTask: id => invoke('cancelTask', id), updateTask: (id, changes) => invoke('updateTask', id, changes),
  approve: (id, allow) => invoke('approve', id, allow), savePreferences: changes => invoke('savePreferences', changes),
  uploadAvatar: role => invoke('uploadAvatar', role), resetAvatar: role => invoke('resetAvatar', role),
  pickAvatarImage: role => invoke('pickAvatarImage', role), saveAvatarImage: (role, dataUrl) => invoke('saveAvatarImage', role, dataUrl),
  setModelOutputLimit: (gatewayId, modelId, maxTokens) => invoke('setModelOutputLimit', gatewayId, modelId, maxTokens), dismissNotice: () => invoke('dismissNotice'),
  saveSearch: (config, key) => invoke('saveSearch', config, key), testSearch: () => invoke('testSearch'),
  answerInteraction: (id, answer) => invoke('answerInteraction', id, answer), setPlanMode: (id, enabled) => invoke('setPlanMode', id, enabled), approvePlan: id => invoke('approvePlan', id), command: (id, command) => invoke('command', id, command),
  saveEcosystem: changes => invoke('saveEcosystem', changes), saveMcpServer: (server, secrets) => invoke('saveMcpServer', server, secrets), removeMcpServer: id => invoke('removeMcpServer', id),
  saveAgentRole: role => invoke('saveAgentRole', role), removeAgentRole: id => invoke('removeAgentRole', id),
  listMemories: (projectId, query) => invoke('listMemories', projectId, query), writeMemory: (projectId, content) => invoke('writeMemory', projectId, content), archiveMemory: (projectId, id) => invoke('archiveMemory', projectId, id), dreamMemory: projectId => invoke('dreamMemory', projectId),
  saveWebdav: (config, password) => invoke('saveWebdav', config, password), previewBackup: source => invoke('previewBackup', source), pushBackup: () => invoke('pushBackup'), pullBackup: () => invoke('pullBackup'),
  openExternal: url => invoke('openExternal', url),
  saveGateway: (gateway, key) => invoke('saveGateway', gateway, key), removeGateway: id => invoke('removeGateway', id),
  testGateway: id => invoke('testGateway', id), diff: id => invoke('diff', id), mergeTask: id => invoke('mergeTask', id),
  createSchedule: input => invoke('createSchedule', input), updateSchedule: (id, changes) => invoke('updateSchedule', id, changes),
  pickSkillFolder: () => invoke('pickSkillFolder'), refreshSkills: () => invoke('refreshSkills'),
  exportData: () => invoke('exportData'), openPath: path => invoke('openPath', path), window: action => invoke('window', action),
  reportRendererError: report => invoke('reportRendererError', report), openLogFolder: () => invoke('openLogFolder'), copyText: text => invoke('copyText', text),
  // Only the desktop process can switch this on, and only for a start with CARDWRIGHT_SMOKE_RENDER_FAULT=1.
  ...(process.argv.includes('--cardwright-smoke-render-fault') ? { smokeRenderFault: true } : {}),
  createCardProject: input => invoke('createCardProject', input), defaultCardFolder: name => invoke('defaultCardFolder', name), pickCardFolder: () => invoke('pickCardFolder'),
  removeCardProject: id => invoke('removeCardProject', id), refreshCardProject: id => invoke('refreshCardProject', id), openCardFolder: (id, path) => invoke('openCardFolder', id, path),
  startCardConversation: input => invoke('startCardConversation', input), markDispatchDone: (id, dispatchId) => invoke('markDispatchDone', id, dispatchId), saveCardSettings: (id, changes) => invoke('saveCardSettings', id, changes), cardPromptOverrides: () => invoke('cardPromptOverrides'), readCardPromptOverride: id => invoke('readCardPromptOverride', id), saveCardPromptOverride: (id, text) => invoke('saveCardPromptOverride', id, text), restoreCardPromptOverride: id => invoke('restoreCardPromptOverride', id),
  setCardConversationWeb: (taskId, enabled) => invoke('setCardConversationWeb', taskId, enabled), requestCardHandoff: taskId => invoke('requestCardHandoff', taskId), consumeCardHandoff: taskId => invoke('consumeCardHandoff', taskId), startCardRun: (id, scope, settings) => invoke('startCardRun', id, scope, settings), pauseCardRun: id => invoke('pauseCardRun', id), resumeCardRun: id => invoke('resumeCardRun', id), stopCardRun: id => invoke('stopCardRun', id), dismissCardRun: id => invoke('dismissCardRun', id), readCardPrompt: (id, sectionId, mode) => invoke('readCardPrompt', id, sectionId, mode),
  pickCardSources: id => invoke('pickCardSources', id), importCardSources: (id, paths) => invoke('importCardSources', id, paths),
  resplitCardSource: (id, name, mode) => invoke('resplitCardSource', id, name, mode), readCardSources: id => invoke('readCardSources', id),
  pickCardImportFile: () => invoke('pickCardImportFile'),
  createCardProjectFromFile: input => invoke('createCardProjectFromFile', input),
  importCardLorebook: (id, replace) => invoke('importCardLorebook', id, replace),
  newCardComponent: (id, input) => invoke('newCardComponent', id, input),
  readCardComponents: id => invoke('readCardComponents', id),
  readCardPieces: id => invoke('readCardPieces', id),
  runCardChecks: id => invoke('runCardChecks', id),
  exportCardProject: (id, kind) => invoke('exportCardProject', id, kind),
  exportCardPng: (id, coverPng) => invoke('exportCardPng', id, coverPng),
  exportCardPiece: (id, kind, name) => invoke('exportCardPiece', id, kind, name),
  exportAllCardPieces: id => invoke('exportAllCardPieces', id),
  readCardMeta: id => invoke('readCardMeta', id),
  saveCardMeta: (id, meta) => invoke('saveCardMeta', id, meta),
  previewCard: (id, kind) => invoke('previewCard', id, kind),
  importCardPiece: id => invoke('importCardPiece', id),
  pickCardCover: () => invoke('pickCardCover'),
  saveCardCover: (id, dataUrl) => invoke('saveCardCover', id, dataUrl),
  clearCardCover: id => invoke('clearCardCover', id),
  readCardCover: id => invoke('readCardCover', id),
  browserOpen: url => invoke('browserOpen', url),
  browserClose: tabId => invoke('browserClose', tabId),
  browserSelect: tabId => invoke('browserSelect', tabId),
  browserBounds: rect => invoke('browserBounds', rect),
  browserDecide: answer => invoke('browserDecide', answer),
  browserTakeOver: (tabId, taken) => invoke('browserTakeOver', tabId, taken),
};
contextBridge.exposeInMainWorld('cardwright', bridge);
