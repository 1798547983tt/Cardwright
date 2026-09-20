export interface AttachmentInfo { id: string; name: string; mimeType: string; bytes: number; kind: 'image' | 'file' | 'reference'; path?: string; projectId?: string }
export interface WorkspaceEntry { path: string; name: string; directory: boolean; bytes?: number }
export interface FilePreview { path: string; name: string; kind: 'text' | 'image' | 'binary'; text?: string; dataUrl?: string; bytes: number; truncated?: boolean }
export interface CheckDefinition { id: string; name: string; command: string; enabled: boolean; automatic?: boolean }
export interface CheckEvidence { id: string; name: string; command: string; status: 'running' | 'passed' | 'failed' | 'cancelled'; exitCode?: number | null; durationMs?: number; output: string; startedAt: string }
export interface DeliverySummary { verification: 'not-run' | 'running' | 'passed' | 'failed' | 'stale'; checkpointId?: string; changedFiles: number; checks: CheckEvidence[]; updatedAt: string; error?: string }
export interface AccessRule { id: string; scope: 'session' | 'project'; projectId: string; taskId?: string; kind: 'read' | 'write' | 'network' | 'command'; target: string; createdAt: string }
export interface StudioPreferences { sandboxEnabled: boolean; defaultSquadSize: number; teamTokenBudget: number; teamMinutesBudget: number; teamMoneyBudget: number; updateFeed: string; roleModels: Record<string, { gatewayId: string; modelId: string; thinking: string }> }
export interface ModelPricing { currency: string; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface StudioState { preferences: StudioPreferences; rules: AccessRule[]; projectChecks: Record<string, CheckDefinition[]> }
export interface CapabilityResult { capability: string; status: 'passed' | 'failed' | 'unknown'; detail: string; at: string }
export interface LabReport { id: string; kind: 'capabilities' | 'cache' | 'tasks'; status: 'running' | 'completed' | 'failed'; rows: Array<Record<string, string | number | boolean | null>>; summary: string; error?: string }
export interface TerminalView { id: string; taskId: string; status: 'running' | 'closed'; output: string; columns: number; rows: number }
export interface UpdateInfo { status: 'idle' | 'available' | 'downloading' | 'ready' | 'failed'; version?: string; progress?: number; message?: string; path?: string }

export interface StudioBridge {
  studioSettings(changes: Partial<StudioPreferences>): Promise<void>;
  workspaceFiles(projectId: string, path?: string, query?: string, taskId?: string): Promise<WorkspaceEntry[]>;
  previewFile(projectId: string, path: string, taskId?: string): Promise<FilePreview>;
  pickAttachments(): Promise<AttachmentInfo[]>;
  importAttachments(paths: string[]): Promise<AttachmentInfo[]>;
  pasteImage(): Promise<AttachmentInfo | null>;
  attachReference(projectId: string, path: string, taskId?: string): Promise<AttachmentInfo>;
  attachmentPreview(id: string): Promise<FilePreview>;
  filePathForDrop(file: File): string;
  checkpoints(taskId: string): Promise<Array<{ id: string; turnId: string; createdAt: string }>>;
  checkpointDiff(taskId: string, checkpointId?: string): Promise<unknown>;
  reviewAction(taskId: string, input: { checkpointId: string; path: string; hunkId?: string; action: 'accept' | 'revert'; expectedHash: string | null }): Promise<unknown>;
  reviewComment(taskId: string, input: { checkpointId: string; path: string; line: number; text: string }): Promise<void>;
  applyReviewComments(taskId: string): Promise<void>;
  saveChecks(projectId: string, checks: CheckDefinition[]): Promise<void>;
  runChecks(taskId: string): Promise<DeliverySummary>;
  integrateSquad(taskId: string): Promise<unknown>;
  applyIntegration(taskId: string, integrationId: string): Promise<unknown>;
  probeModel(gatewayId: string, modelId: string, capabilities: string[]): Promise<LabReport>;
  benchmarkCache(gatewayId: string, modelId: string): Promise<LabReport>;
  evaluateTasks(gatewayId: string, modelId: string): Promise<LabReport>;
  grantRule(rule: Omit<AccessRule, 'id' | 'createdAt'>): Promise<void>;
  revokeRule(id: string): Promise<void>;
  openTerminal(taskId: string): Promise<TerminalView>;
  terminalState(id: string): Promise<TerminalView>;
  terminalInput(id: string, input: string): Promise<void>;
  terminalResize(id: string, columns: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  checkUpdates(): Promise<UpdateInfo>;
  updateReport(): Promise<{ status: string; message: string } | null>;
  importUpdate(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  rollbackUpdate(): Promise<void>;
}
