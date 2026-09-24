import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, safeStorage, shell, Tray } from 'electron';
import { join, resolve, sep } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, release as osRelease, version as osVersion } from 'node:os';
import { Harness } from './harness.ts';
import { Vault } from './vault.ts';
import { normalizeAvatar, prepareAvatar, previewAvatarSource } from './avatars.ts';
import { readCoverSource } from './card-cover.ts';
import { externalUrl } from '../core/external-url.ts';
import { setEcosystemApplicationRoot } from '../runtime/ecosystem-skills.ts';
import type { AppSnapshot, Approval, Bridge, Task } from '../shared/types.ts';
import type { CardPreviewKind } from '../shared/card-studio/types.ts';
import { applyAppUpdate, createAppUpdate } from '../shared/app-updates.ts';
import { shouldNotify, type NotifyKind } from '../shared/notify.ts';
import { StudioServices } from './studio-services.ts';
import { CardStudioService } from './card-studio.ts';
import { handlePreviewScheme, PREVIEW_SCHEME, publishPreview, registerPreviewScheme } from './card-preview.ts';
import { UpdateService } from './updates.ts';
import { BrowserHost } from './browser.ts';
import { appendRendererLog, LOG_FOLDER } from './renderer-log.ts';
import { AppearanceService } from './appearance.ts';
import { PetWindow } from './pet-window.ts';
import { diagnosticText, windowsLabel } from '../shared/diagnostics.ts';
import { ReleaseCheck } from './release-check.ts';

const directory = __dirname;
/** The packaged smoke's switch for one deliberate render error per page (0.9.1). Nothing inside the app turns it on. */
const smokeRenderFault = process.env.CARDWRIGHT_SMOKE_RENDER_FAULT === '1';
app.setName('Cardwright');
registerPreviewScheme();
if (process.env.CARDWRIGHT_DATA_DIR) app.setPath('userData', process.env.CARDWRIGHT_DATA_DIR);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let pet: PetWindow | undefined;
let harness: Harness | undefined;
let exiting = false;
let closeReady = false;
const frontendUrl = process.env.CARDWRIGHT_DEV_URL;

function showWindow(): void { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
/** True when the notification was shown; a click brings the window back unless the caller gives it something else to do. */
function notify(title: string, body: string, task?: Task, kind: NotifyKind = 'other', click: () => void = showWindow): boolean {
  void harness?.hooks('Notification', task, { message: `${title}: ${body}` });
  const preferences = harness?.snapshot().preferences;
  if (!preferences || !Notification.isSupported()) return false;
  if (!shouldNotify({ kind, focused: !!window?.isFocused(), preferences })) return false;
  const notification = new Notification({ title, body, icon: join(directory, 'icon.png') });
  notification.on('click', click); notification.show();
  // The taskbar keeps the mark until the user comes back to the window.
  try { window?.setOverlayIcon(nativeImage.createFromPath(join(directory, 'badge.png')), title); } catch { /* No overlay support here. */ }
  return true;
}
function handle<K extends keyof Bridge>(name: K, fn: Bridge[K]): void {
  ipcMain.handle(`cardwright:${name}`, async (event, ...args: unknown[]) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
    if (JSON.stringify(args).length > 2_000_000) throw new Error('Request exceeds the allowed size.');
    return (fn as (...args: unknown[]) => unknown)(...args);
  });
}
async function initialize(): Promise<void> {
  setEcosystemApplicationRoot(app.getAppPath());
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Cardwright cannot save gateway credentials.');
  const dataDirectory = app.getPath('userData');
  const logDirectory = join(dataDirectory, LOG_FOLDER);
  const vault = new Vault(dataDirectory, { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
  harness = new Harness(dataDirectory, join(directory, 'worker.mjs'), vault, { paused: true });
  const service = harness;
  const studio = new StudioServices(dataDirectory, service, join(directory, 'Cardwright.CommandHost.exe'), buffer => {
    const value = nativeImage.createFromBuffer(buffer); if (value.isEmpty()) throw new Error('Choose a valid PNG, JPEG or WebP image.');
    const size = value.getSize(); if (size.width * size.height > 40000000) throw new Error('This image is too large.');
    const scale = Math.min(1, 2048 / Math.max(size.width, size.height));
    return (scale < 1 ? value.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' }) : value).toPNG();
  });
  service.attachStudio(studio);
  handlePreviewScheme();
  const cardStudio = new CardStudioService(service, join(app.getAppPath(), 'card-studio'), {
    documentsDir: app.getPath('documents'), sandboxEntry: join(app.getAppPath(), 'dist', 'card-sandbox.cjs'),
    pickCover: async () => {
      const selected = await dialog.showOpenDialog(window!, { title: '选择封面图片 / Choose a cover image', properties: ['openFile'], filters: [{ name: '图片 / Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      return selected.canceled || !selected.filePaths.length ? null : readCoverSource(selected.filePaths[0]);
    },
    publishPreview,
  });
  service.attachCardStudio(cardStudio);
  void cardStudio.refreshAll().catch(() => undefined);
  window = new BrowserWindow({
    width: 1512, height: 1000, minWidth: 900, minHeight: 640, frame: false, show: false,
    backgroundColor: '#0d0f12', title: 'Cardwright', icon: join(directory, 'icon.png'),
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, ...(smokeRenderFault ? { additionalArguments: ['--cardwright-smoke-render-fault'] } : {}) },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Frames exist only for the card studio's previews, and they stay on the preview scheme.
  window.webContents.on('will-frame-navigate', details => { if (!details.isMainFrame && !details.url.startsWith(`${PREVIEW_SCHEME}://`)) details.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('ready-to-show', () => window?.show());
  window.on('close', event => {
    if (!exiting && tray) { event.preventDefault(); window?.hide(); }
  });
  window.on('focus', () => { try { window?.setOverlayIcon(null, ''); } catch { /* No overlay support here. */ } });
  window.on('closed', () => { window = undefined; });
  // The built-in browser lives in the window, beside the renderer, in its own session (§6.4).
  const browser = new BrowserHost(window, {
    allowed: () => service.snapshot().preferences.browserAllowed ?? [],
    allow: origin => service.allowBrowserOrigin(origin),
    changed: () => service.publishBrowser(browser.state()),
  });
  service.attachBrowser(browser);
  // Let go of the pages while the window still exists; after it is destroyed every call into it throws.
  window.on('close', () => { if (exiting || !tray) browser.closeAll(); });
  let publication: AppSnapshot | null = null; let publicationRevision = 0;
  const publish = (snapshot: AppSnapshot) => {
    const update = createAppUpdate(publication, snapshot, ++publicationRevision);
    publication = applyAppUpdate(publication, update);
    if (window && !window.isDestroyed()) window.webContents.send('cardwright:update', update);
    return { ...publication, publicationRevision };
  };
  service.on('change', publish);
  // A one-click making run tells the user itself when it pauses or finishes; its conversations do not notify each turn.
  service.on('finished', (task: Task) => { if (!cardStudio.runner.owns(task.id)) notify(task.truncation ? 'Output limit reached / 输出被截断' : task.status === 'failed' ? 'Task needs attention' : 'Task finished', task.title, task, 'finished'); });
  service.on('approval', (approval: Approval) => { if (!cardStudio.runner.owns(approval.taskId)) notify('Approval requested', 'A task is waiting for permission to use a tool.', undefined, 'approval'); });
  cardStudio.runner.on('notify', ({ title, body }: { title: string; body: string }) => notify(title, body));
  service.on('missed', schedule => notify('Schedule needs attention', schedule.name));
  if (!service.snapshot().preferences.quietUpgrade) service.savePreferences({ soundEnabled: false, bootSequence: false, quietUpgrade: true });
  handle('snapshot', async () => publish(service.publicView()));
  handle('pickProject', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: 'Choose a project', properties: ['openDirectory'] });
    return selected.canceled ? null : service.addProject(selected.filePaths[0]);
  });
  handle('addProject', async path => service.addProject(path));
  handle('updateProject', async (id, changes) => service.updateProject(id, changes));
  handle('regenerate', async (id, messageId, text) => service.regenerate(id, messageId, text));
  handle('switchRevision', async (id, revisionId) => service.switchRevision(id, revisionId));
  handle('resumeAgent', async (id, message) => service.resumeAgent(id, message));
  handle('setSkillEnabled', async (id, enabled) => service.setSkillEnabled(id, enabled));
  handle('setAgentEnabled', async (id, enabled) => service.setAgentEnabled(id, enabled));
  handle('saveHooks', async hooks => service.saveHooks(hooks));
  handle('claudeCodeHooks', async projectId => service.claudeHooks(projectId));
  handle('testHook', async (event, command, timeout, projectId) => service.testHook(event as Parameters<typeof service.testHook>[0], command, timeout, projectId));
  handle('fetchModels', async (input, key) => service.fetchModels(input, key));
  handle('createTask', async input => service.createTask(input));
  handle('prompt', async (id, text, behavior, attachments) => service.prompt(id, text, behavior, attachments));
  handle('studioSettings', async changes => studio.settings(changes));
  handle('workspaceFiles', async (projectId, path, query, taskId) => studio.workspaceFiles(projectId, path, query, taskId));
  handle('previewFile', async (projectId, path, taskId) => studio.previewFile(projectId, path, taskId));
  handle('importAttachments', async paths => studio.importAttachments(paths));
  handle('pickAttachments', async () => { const result = await dialog.showOpenDialog(window!, { title: 'Add files / 添加文件', properties: ['openFile', 'multiSelections'] }); return result.canceled ? [] : studio.importAttachments(result.filePaths); });
  handle('pasteImage', async () => { for (const item of await clipboard.read()) { const type = item.types.find(type => type.startsWith('image/')); if (!type) continue; const value = await item.getType(type); if ('arrayBuffer' in value) return studio.attachments.importImage(Buffer.from(await value.arrayBuffer())); } return null; });
  handle('attachReference', async (projectId, path, taskId) => studio.attachReference(projectId, path, taskId));
  handle('attachmentPreview', async id => studio.attachments.preview(id));
  handle('checkpoints', async taskId => { studio.task(taskId); return (await studio.checkpoints.list(taskId)).map(({ id, turnId, createdAt }) => ({ id, turnId, createdAt })); });
  handle('checkpointDiff', async (taskId, checkpointId) => studio.checkpointDiff(taskId, checkpointId));
  handle('reviewAction', async (taskId, input) => studio.reviewAction(taskId, input));
  handle('reviewComment', async (taskId, input) => studio.comment(taskId, input));
  handle('applyReviewComments', async taskId => studio.applyComments(taskId));
  handle('saveChecks', async (projectId, checks) => studio.saveChecks(projectId, checks));
  handle('runChecks', async taskId => studio.runTaskChecks(taskId));
  handle('integrateSquad', async taskId => studio.integrateSquad(taskId));
  handle('applyIntegration', async (taskId, integrationId) => studio.applyIntegration(taskId, integrationId));
  handle('probeModel', async (gatewayId, modelId, capabilities) => studio.probeModel(gatewayId, modelId, capabilities));
  handle('benchmarkCache', async (gatewayId, modelId) => studio.benchmarkCache(gatewayId, modelId));
  handle('evaluateTasks', async (gatewayId, modelId) => studio.evaluateTasks(gatewayId, modelId));
  handle('grantRule', async rule => studio.grantRule(rule));
  handle('revokeRule', async id => studio.revokeRule(id));
  handle('openTerminal', async taskId => studio.openTerminal(taskId));
  handle('terminalState', async id => studio.terminalState(id));
  handle('terminalInput', async (id, value) => studio.terminal.input(id, value));
  handle('terminalResize', async (id, columns, rows) => studio.terminal.resize(id, columns, rows));
  handle('closeTerminal', async id => studio.terminal.close(id));
  handle('browserOpen', async url => { const result = await browser.open(url); return 'needsPermission' in result ? null : result.tabId; });
  handle('browserClose', async tabId => browser.close(tabId));
  handle('browserSelect', async tabId => browser.select(tabId));
  handle('browserBounds', async rect => browser.setBounds(rect));
  handle('browserDecide', async answer => browser.decide(answer));
  handle('browserTakeOver', async (tabId, taken) => browser.takeOver(tabId, taken));
  handle('checkUpdates', async () => studio.updates.check(studio.state.preferences.updateFeed));
  handle('updateReport', async () => studio.updates.report());
  handle('importUpdate', async () => { const result = await dialog.showOpenDialog(window!, { title: 'Import Cardwright update manifest', properties: ['openFile'], filters: [{ name: 'Cardwright update', extensions: ['json'] }] }); return result.canceled ? studio.updates.state() : studio.updates.import(result.filePaths[0]); });
  handle('installUpdate', async () => {
    await studio.updates.validateInstall();
    try { await service.close(); await studio.updates.launchInstall(process.execPath, join(directory, 'Cardwright.UpdateHost.exe')); }
    catch (error) { service.resumeAfterFailedUpdate(); throw error; }
    closeReady = true; exiting = true; app.quit();
  });
  handle('rollbackUpdate', async () => {
    await studio.updates.validateRollback();
    try { await service.close(); await studio.updates.launchRollback(process.execPath, join(directory, 'Cardwright.UpdateHost.exe')); }
    catch (error) { service.resumeAfterFailedUpdate(); throw error; }
    closeReady = true; exiting = true; app.quit();
  });
  handle('cancelTask', async id => service.cancelTask(id));
  handle('updateTask', async (id, changes) => service.updateTask(id, changes));
  handle('approve', async (id, allow) => service.approve(id, allow));
  handle('savePreferences', async changes => service.savePreferences(changes));
  handle('uploadAvatar', async role => {
    if (!['user', 'assistant'].includes(role)) throw new Error('Unknown avatar role.');
    const selected = await dialog.showOpenDialog(window!, { title: role === 'user' ? 'Choose your avatar / 选择用户头像' : 'Choose AI avatar / 选择 AI 头像', properties: ['openFile'], filters: [{ name: 'Avatar images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (!selected.canceled && selected.filePaths[0]) service.setAvatar(role, await prepareAvatar(selected.filePaths[0]));
  });
  handle('resetAvatar', async role => service.setAvatar(role));
  handle('pickAvatarImage', async role => {
    if (!['user', 'assistant'].includes(role)) throw new Error('Unknown avatar role.');
    const selected = await dialog.showOpenDialog(window!, { title: role === 'user' ? 'Choose your avatar / 选择用户头像' : 'Choose AI avatar / 选择 AI 头像', properties: ['openFile'], filters: [{ name: 'Avatar images', extensions: ['png', 'jpg', 'jpeg'] }] });
    return selected.canceled || !selected.filePaths[0] ? null : previewAvatarSource(selected.filePaths[0]);
  });
  handle('saveAvatarImage', async (role, dataUrl) => {
    if (!['user', 'assistant'].includes(role)) throw new Error('Unknown avatar role.');
    service.setAvatar(role, normalizeAvatar(dataUrl));
  });
  handle('setModelOutputLimit', async (gatewayId, modelId, maxTokens) => service.setModelOutputLimit(String(gatewayId), String(modelId), Number(maxTokens)));
  handle('dismissNotice', async () => service.dismissNotice());
  handle('saveSearch', async (config, key) => service.saveSearch(config, key));
  handle('testSearch', async () => service.testSearch());
  handle('answerInteraction', async (id, answer) => service.answerInteraction(id, answer));
  handle('setPlanMode', async (id, enabled) => service.setPlanMode(id, enabled));
  handle('approvePlan', async id => service.approvePlan(id));
  handle('command', async (id, command) => service.command(id, command));
  handle('saveEcosystem', async changes => service.saveEcosystem(changes));
  handle('saveMcpServer', async (server, secrets) => service.saveMcpServer(server, secrets));
  handle('removeMcpServer', async id => service.removeMcpServer(id));
  handle('saveAgentRole', async role => service.saveAgentRole(role));
  handle('removeAgentRole', async id => service.removeAgentRole(id));
  handle('listMemories', async (projectId, query) => service.listMemories(projectId, query));
  handle('writeMemory', async (projectId, content) => service.writeMemory(projectId, content));
  handle('archiveMemory', async (projectId, id) => service.archiveMemory(projectId, id));
  handle('dreamMemory', async projectId => service.dreamMemory(projectId));
  handle('saveWebdav', async (config, password) => service.saveWebdav(config, password));
  handle('previewBackup', async source => service.previewBackup(source));
  handle('pushBackup', async () => service.pushBackup());
  handle('pullBackup', async () => service.pullBackup());
  handle('openExternal', async url => { await shell.openExternal(externalUrl(url)); });
  handle('saveGateway', async (gateway, key) => service.saveGateway(gateway, key));
  handle('removeGateway', async id => service.removeGateway(id));
  handle('testGateway', async id => service.testGateway(id));
  handle('selfTestGateway', async (input, key) => service.selfTestGateway(input, key));
  handle('diff', async id => service.diff(id));
  handle('mergeTask', async id => service.mergeTask(id));
  handle('createSchedule', async input => service.createSchedule(input));
  handle('updateSchedule', async (id, changes) => service.updateSchedule(id, changes));
  handle('pickSkillFolder', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: 'Choose a skill or skills folder', properties: ['openDirectory'] });
    return selected.canceled ? null : selected.filePaths[0];
  });
  handle('refreshSkills', async () => { service.refreshSkills(); service.emit('change', service.snapshot()); });
  handle('exportData', async () => {
    const target = await dialog.showSaveDialog(window!, { title: 'Export Cardwright data', defaultPath: 'cardwright-export.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (target.canceled || !target.filePath) return null;
    const { approvals: _approvals, ...snapshot } = service.snapshot();
    await writeFile(target.filePath, JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
    return target.filePath;
  });
  handle('openPath', async path => {
    if (!service.allowedPath(path)) throw new Error('Only registered project, task, skill and application folders may be opened.');
    const error = await shell.openPath(path); if (error) throw new Error(error);
  });
  handle('window', async action => {
    if (action === 'minimize') window?.minimize();
    else if (action === 'maximize') { if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); }
    else if (action === 'close') window?.close();
    else if (action === 'reload') window?.webContents.reload();
  });
  // Interface errors (0.9.1): the record is returned even when the log cannot be written, so the card can still copy it.
  handle('reportRendererError', async report => {
    const text = diagnosticText(report, { version: app.getVersion(), windows: windowsLabel(osVersion(), osRelease()), home: homedir(), at: new Date() });
    await appendRendererLog(logDirectory, text).catch(() => undefined);
    return text;
  });
  handle('openLogFolder', async () => {
    await mkdir(logDirectory, { recursive: true });
    const error = await shell.openPath(logDirectory); if (error) throw new Error(error);
  });
  handle('copyText', async text => { clipboard.writeText(String(text)); });
  // 新版本提醒 (1.1, handoff §5.7a): about a minute after startup and then once a day, the latest release's version number
  // and page from GitHub; a click on the reminder opens that page. Nothing is downloaded and nothing else is sent.
  const releases = new ReleaseCheck({
    dataDir: dataDirectory, currentVersion: app.getVersion(), fetch: (url, init) => net.fetch(url, init),
    enabled: () => service.publicView().preferences.releaseCheck !== false,
    // Held back like any other notification (switched off, or the window in front), the reminder comes at the next check,
    // so the Notification hooks hear it once, when it is shown.
    notify: (version, url) => Notification.isSupported() && shouldNotify({ kind: 'other', focused: !!window?.isFocused(), preferences: service.publicView().preferences })
      && notify(`Cardwright ${version} 新版本 / New version`, '点这里打开发布页 / Click to open the release page', undefined, 'other', () => {
        try { void shell.openExternal(externalUrl(url)).catch(() => undefined); } catch { showWindow(); }
      }),
  });
  handle('readReleaseCheck', async () => releases.read());
  releases.start();
  // 主题包 and 桌宠 (ADR 0018): packs are read from the data folder; the built-in pet ships in assets/pets.
  const appearance = new AppearanceService(dataDirectory, app.getAppPath());
  // 桌宠 (ADR 0018, 2026-09-23): a window of its own above every other one; a click brings this one back on what it reported.
  const desk = new PetWindow({
    directory, devUrl: frontendUrl,
    snapshot: () => service.snapshot(), savePreferences: changes => service.savePreferences(changes),
    appearance: () => appearance.snapshot(), sprite: id => appearance.petSprite(id),
    systemDark: () => nativeTheme.shouldUseDarkColors,
    open: target => { showWindow(); if (window && !window.isDestroyed()) window.webContents.send('cardwright:open', target); },
  });
  pet = desk;
  service.on('change', () => desk.schedule());
  nativeTheme.on('updated', () => desk.schedule());
  desk.schedule();
  handle('appearance', async () => appearance.snapshot());
  handle('themeBackground', async id => appearance.themeBackground(String(id)));
  handle('petSprite', async id => appearance.petSprite(String(id)));
  handle('petNotice', async id => appearance.petNotice(String(id)));
  handle('installPet', async from => {
    const selected = await dialog.showOpenDialog(window!, from === 'folder'
      ? { title: '选择宠物包文件夹 / Choose a pet pack folder', properties: ['openDirectory'] }
      : { title: '选择宠物包 / Choose a pet pack', properties: ['openFile'], filters: [{ name: 'Codex 宠物包 / Codex pet pack', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePaths.length) return null;
    const installed = await appearance.installPet(selected.filePaths[0]);
    desk.forgetAppearance();
    return installed;
  });
  handle('openAppearanceFolder', async kind => {
    const folder = kind === 'pets' ? appearance.petsFolder : appearance.themesFolder;
    await mkdir(folder, { recursive: true });
    desk.forgetAppearance();
    const error = await shell.openPath(folder); if (error) throw new Error(error);
  });
  handle('createCardProject', async input => cardStudio.create(input));
  handle('defaultCardFolder', async name => cardStudio.defaultFolder(String(name ?? '')));
  handle('pickCardFolder', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: '选择卡项目文件夹 / Choose a card project folder', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  handle('removeCardProject', async id => cardStudio.remove(id));
  handle('refreshCardProject', async id => cardStudio.reload(id));
  handle('openCardFolder', async (id, relativePath) => {
    const root = resolve((await cardStudio.reload(id)).path); const target = resolve(root, relativePath ? String(relativePath) : '.');
    if (target !== root && !target.startsWith(root + sep)) throw new Error('只能打开卡项目里的文件夹。');
    const error = await shell.openPath(target); if (error) throw new Error(error);
  });
  handle('startCardConversation', async input => cardStudio.startConversation(input));
  handle('markDispatchDone', async (id, dispatchId) => cardStudio.markDispatchDone(id, dispatchId));
  handle('saveCardSettings', async (id, changes) => service.saveCardSettings(id, changes));
  handle('cardPromptOverrides', async () => cardStudio.listPromptOverrides());
  handle('readCardPromptOverride', async id => cardStudio.readPromptOverride(id));
  handle('saveCardPromptOverride', async (id, text) => cardStudio.savePromptOverride(id, text));
  handle('restoreCardPromptOverride', async id => cardStudio.restorePromptOverride(id));
  handle('setCardConversationWeb', async (taskId, enabled) => cardStudio.setWeb(taskId, enabled));
  handle('requestCardHandoff', async taskId => cardStudio.requestHandoff(taskId));
  handle('consumeCardHandoff', async taskId => cardStudio.consumeHandoff(taskId));
  handle('withdrawCardMessage', async (taskId, messageId) => cardStudio.withdraw(taskId, messageId));
  handle('startCardRun', async (id, scope, settings) => cardStudio.runner.start(id, scope, settings));
  handle('pauseCardRun', async id => cardStudio.runner.pause(id));
  handle('resumeCardRun', async id => cardStudio.runner.resume(id));
  handle('stopCardRun', async id => cardStudio.runner.stop(id));
  handle('dismissCardRun', async id => cardStudio.runner.dismiss(id));
  handle('startCardChange', async (id, input) => cardStudio.startChange(id, input));
  handle('removeCardChangeItem', async (id, changeId, itemId) => cardStudio.removeChangeItem(id, changeId, itemId));
  handle('dropCardChange', async (id, changeId) => cardStudio.dropChange(id, changeId));
  handle('confirmCardChange', async (id, changeId, settings) => cardStudio.confirmChange(id, changeId, settings));
  handle('resumeCardChange', async (id, changeId, settings) => cardStudio.resumeChange(id, changeId, settings));
  handle('readCardPrompt', async (id, sectionId, mode) => cardStudio.readPrompt(id, sectionId, mode));
  handle('pickCardSources', async id => {
    const selected = await dialog.showOpenDialog(window!, { title: '导入资料 / Import material', properties: ['openFile', 'multiSelections'], filters: [{ name: '资料 / Material', extensions: ['txt', 'md', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }, { name: '所有文件 / All files', extensions: ['*'] }] });
    return selected.canceled || !selected.filePaths.length ? null : cardStudio.importSources(id, selected.filePaths);
  });
  handle('importCardSources', async (id, paths) => cardStudio.importSources(id, paths));
  handle('resplitCardSource', async (id, name, mode) => cardStudio.resplitSource(id, name, mode));
  handle('readCardSources', async id => cardStudio.readSources(id));
  handle('pickCardImportFile', async () => {
    const selected = await dialog.showOpenDialog(window!, { title: '导入角色卡或世界书 / Import a character card or world book', properties: ['openFile'], filters: [{ name: '角色卡与世界书 / Cards and world books', extensions: ['json', 'png'] }] });
    return selected.canceled || !selected.filePaths.length ? null : cardStudio.importPreview(selected.filePaths[0]);
  });
  handle('createCardProjectFromFile', async input => cardStudio.createFromFile(input));
  handle('importCardLorebook', async (id, replace) => {
    const selected = await dialog.showOpenDialog(window!, { title: '导入独立世界书 / Import a world book', properties: ['openFile'], filters: [{ name: '世界书 / World book', extensions: ['json'] }] });
    return selected.canceled || !selected.filePaths.length ? null : cardStudio.importLorebookFile(id, selected.filePaths[0], { replace: replace === true });
  });
  handle('newCardComponent', async (id, input) => cardStudio.newComponent(id, input));
  handle('readCardComponents', async id => cardStudio.listComponents(id));
  handle('moveCardLore', async (id, paths, section) => cardStudio.moveLore(id, paths, section));
  handle('suggestCardLoreSections', async (id, uids) => cardStudio.suggestLoreSections(id, uids));
  handle('readCardVariableTable', async id => cardStudio.readVariableTable(id));
  handle('readCardPieces', async id => cardStudio.listPieces(id));
  handle('runCardChecks', async id => cardStudio.runChecks(id));
  handle('exportCardProject', async (id, kind) => kind === 'lorebook' ? cardStudio.exportLorebook(id) : cardStudio.exportCard(id));
  handle('exportCardPng', async (id, coverPng) => cardStudio.exportCardPng(id, coverPng));
  handle('exportCardPiece', async (id, kind, name) => cardStudio.exportPiece(id, kind, name));
  handle('exportAllCardPieces', async id => cardStudio.exportAllPieces(id));
  handle('readCardMeta', async id => cardStudio.readMeta(id));
  handle('saveCardMeta', async (id, meta) => cardStudio.saveMeta(id, meta));
  handle('previewCard', async (id, kind) => cardStudio.preview(id, ['update', 'status', 'start'].includes(String(kind)) ? kind as CardPreviewKind : 'body'));
  handle('importCardPiece', async id => {
    const selected = await dialog.showOpenDialog(window!, { title: '导入正则或脚本 / Import a regex or a script', properties: ['openFile'], filters: [{ name: '正则与脚本 / Regex and scripts', extensions: ['json'] }] });
    return selected.canceled || !selected.filePaths.length ? null : cardStudio.importPieceFile(id, selected.filePaths[0]);
  });
  handle('pickCardCover', async () => cardStudio.pickCover());
  handle('saveCardCover', async (id, dataUrl) => cardStudio.saveCover(id, dataUrl));
  handle('clearCardCover', async id => cardStudio.clearCover(id));
  handle('readCardCover', async id => cardStudio.readCover(id));
  tray = new Tray(nativeImage.createFromPath(join(directory, 'icon-tray.png')));
  tray.setToolTip('Cardwright · Local agent workspace');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cardwright / 打开', click: showWindow },
    { type: 'separator' },
    { label: 'Quit and stop tasks / 退出', click: () => { exiting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
  if (frontendUrl) await window.loadURL(frontendUrl); else await window.loadFile(join(directory, 'renderer', 'index.html'));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ready = () => document.querySelector('.app-shell'); if (ready()) return resolve(true); const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('The workspace interface did not become ready.')); }, 15000); observer.observe(document.documentElement, {childList:true,subtree:true}); })`);
  await UpdateService.markHealthy(dataDirectory);
  service.resumeStartup();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', event => {
    exiting = true;
    pet?.dispose();
    if (!closeReady && harness) {
      event.preventDefault();
      void harness.close().then(() => { closeReady = true; tray?.destroy(); tray = undefined; app.quit(); }, error => { exiting = false; dialog.showErrorBox('Cardwright could not save', `${error instanceof Error ? error.message : String(error)}\nThe application remains open so you can export data or free disk space before trying again.`); });
    }
  });
  void app.whenReady().then(initialize).catch(error => {
    dialog.showErrorBox('Cardwright could not start', error instanceof Error ? error.message : String(error));
    closeReady = true; app.quit();
  });
}
