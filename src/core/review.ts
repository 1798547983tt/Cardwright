// Keep renderer-facing review types independent from task orchestration.
export { CheckpointService, ReviewDriftError } from './checkpoints.ts';
export type { Checkpoint, ReviewAction, ReviewAudit, ReviewComment, ReviewFile, ReviewHunk, ReviewSnapshot, SnapshotCoverage } from './checkpoints.ts';

import type { ReviewComment } from './checkpoints.ts';
/** Called only when the user explicitly submits comments as a follow-up. */
export function reviewCommentsPrompt(comments: ReviewComment[]): string {
  if (!comments.length) throw new Error('Select at least one review comment.');
  return 'Apply these review comments, preserving unrelated edits:\n' + comments.map(comment => JSON.stringify({ file: comment.path, line: comment.line, side: comment.side, comment: comment.text })).join('\n');
}
