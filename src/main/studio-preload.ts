import { ipcRenderer, webUtils } from 'electron';
import type { StudioBridge } from '../shared/studio-types.ts';

const methods = ['studioSettings', 'workspaceFiles', 'previewFile', 'pickAttachments', 'importAttachments', 'pasteImage', 'attachReference', 'attachmentPreview', 'checkpoints', 'checkpointDiff', 'reviewAction', 'reviewComment', 'applyReviewComments', 'saveChecks', 'runChecks', 'integrateSquad', 'applyIntegration', 'probeModel', 'benchmarkCache', 'evaluateTasks', 'grantRule', 'revokeRule', 'openTerminal', 'terminalState', 'terminalInput', 'terminalResize', 'closeTerminal', 'checkUpdates', 'importUpdate', 'installUpdate', 'rollbackUpdate'] as const;
export const studioBridge = Object.fromEntries(methods.map(name => [name, (...args: unknown[]) => ipcRenderer.invoke(`cardwright:${name}`, ...args)])) as unknown as StudioBridge;
studioBridge.updateReport = () => ipcRenderer.invoke('cardwright:updateReport');
studioBridge.filePathForDrop = file => webUtils.getPathForFile(file);
