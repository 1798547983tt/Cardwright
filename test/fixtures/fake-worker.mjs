// IPC-only test fixture. It never imports a model provider or makes network requests.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
let init;
/** A worker the harness has to stop the hard way: it never reports done, so nothing of a new session was written. */
let exitOnCancel = false;
/** A slow turn keeps running for a moment; follow-up messages that arrive meanwhile are handled before it ends. */
let slow = false;
const followUps = [];
let approval;
let childPrompt = 'complete';
let turnId;
const send = message => { if (process.connected) process.send?.(message); };
const event = value => send({ type: 'event', event: { ...value, turnId } });
function reply(text) {
  event({ type: 'message_start', message: { role: 'assistant' } });
  event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  event({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
    usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, cost: { total: 0 } },
  } });
}
function finish(text = 'Fixture completed.') {
  reply(text);
  send({ type: 'done', sessionFile: `${init.sessionDir}/fixture.jsonl` });
}
/** The model is still writing its first reply: pi holds the user entry in memory and writes the session only at the reply's end. */
function unsaved(messageId) {
  exitOnCancel = true;
  event({ type: 'session_entry', entryId: 'fixture-unsaved-entry', messageId });
  event({ type: 'message_start', message: { role: 'assistant' } });
  event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正在写……' } });
}
function toolRecord(name, path, failed = false) {
  const id = `${name}-${Math.random()}`;
  event({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: path ? { path: join(init.cwd, ...path.split('/')) } : {} });
  event({ type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text: failed ? 'failed' : 'ok' }] }, isError: failed });
}
/** One-click making scripts: the dispatch body says what the section AI does. */
function runScript(command) {
  if (command.trim() === '全部按推荐') { finish('已按推荐答复并交付。'); return true; }
  if (command.startsWith('【拼装检查】')) {
    if (command.includes('131-可修')) { rmSync(join(init.cwd, '世界书', '人设', '131-可修.json'), { force: true }); toolRecord('write', '世界书/人设/131-可修.md'); finish('已修正。'); }
    else { toolRecord('write', '世界书/人设/130-坏条目.md'); finish('已尝试修正。'); }
    return true;
  }
  if (command.includes('RUN:deliver')) finish('已交付。');
  else if (command.includes('RUN:ask')) finish('称呼用哪个？推荐：大王。\n<!-- cardwright:accept-all -->');
  else if (command.includes('RUN:refuse')) finish('缺少前置派单，先做人物模板。\n<!-- cardwright:refuse -->');
  else if (command.includes('RUN:broken')) { toolRecord('write', '世界书/人设/130-坏条目.md'); finish('已交付。'); }
  else if (command.includes('RUN:fixable')) { toolRecord('write', '世界书/人设/131-可修.md'); finish('已交付。'); }
  else if (command.includes('RUN:toolfail')) { for (let index = 0; index < 3; index++) toolRecord('powershell', undefined, true); finish('命令一直失败。'); }
  else if (command.includes('RUN:big')) { event({ type: 'context_usage', tokens: 150000, window: 200000, percent: 75 }); finish('已交付。'); }
  else if (command.includes('RUN:hold')) event({ type: 'tool_execution_start', toolCallId: 'holding-tool', toolName: 'fixture_hold', args: {} });
  else if (command.includes('RUN:unsaved')) unsaved(turnId);
  else if (command.includes('RUN:error')) send({ type: 'error', message: '网关返回 502。' });
  else if (command.includes('RUN:approve')) {
    approval = `${init.taskId}-approve`;
    event({ type: 'tool_execution_start', toolCallId: 'approval-tool', toolName: 'write', args: { path: 'fixture.txt' } });
    send({ type: 'request', id: approval, method: 'approve', args: { toolName: 'write', args: { path: 'fixture.txt' }, reason: 'Fixture approval.' } });
  } else if (command.includes('RUN:slow')) {
    slow = true;
    setTimeout(() => {
      reply('已交付。');
      for (const next of followUps.splice(0)) { turnId = next.messageId; event({ type: 'message_start', messageId: next.messageId, message: { role: 'user' } }); reply(`Echo: ${next.text}`); }
      slow = false;
      send({ type: 'done', sessionFile: `${init.sessionDir}/fixture.jsonl` });
    }, 700);
  } else return false;
  return true;
}
process.on('message', message => {
  if (message.type === 'init') {
    init = message;
    // As the real worker (src/runtime/conversation-history.ts): a cursor must point into the saved session file.
    if (typeof init.sessionLeafId === 'string' && !(init.sessionFile && existsSync(init.sessionFile) && readFileSync(init.sessionFile, 'utf8').includes(`"id":"${init.sessionLeafId}"`))) {
      send({ type: 'error', message: 'The selected conversation version is missing a saved entry.' });
      return;
    }
    send({ type: 'ready', sessionFile: init.sessionFile ?? `${init.sessionDir}/fixture.jsonl` });
  } else if (message.type === 'cancel') {
    if (exitOnCancel) process.exit(0);
    event({ type: 'run_cancelled' });
    send({ type: 'done' });
  } else if (message.type === 'prompt') {
    if (slow) { followUps.push(message); return; }
    turnId = message.messageId;
    event({ type: 'message_start', messageId: message.messageId, message: { role: 'user' } });
    const command = message.text;
    if (runScript(command)) return;
    if (command === 'complete' || command === 'release') finish();
    else if (command === 'effective-thinking') { event({ type: 'thinking_level_changed', level: 'off' }); finish(); }
    else if (command === 'truncate') {
      // Mirrors the real worker: reasoning-only length stop, then output_truncated, error and done.
      event({ type: 'message_start', message: { role: 'assistant' } });
      event({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Planning the SVG geometry…' } });
      event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Planning the SVG geometry…' }], stopReason: 'length', usage: { input: 20, output: 1024, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
      event({ type: 'output_truncated', outputTokens: 1024, maxTokens: 1024, model: 'fixture' });
      send({ type: 'error', message: 'Output limit reached (1,024 / 1,024 tokens). The truncated response wrote no files.' });
      send({ type: 'done', sessionFile: `${init.sessionDir}/fixture.jsonl` });
    }
    else if (command === 'hold') {
      event({ type: 'tool_execution_start', toolCallId: 'holding-tool', toolName: 'fixture_hold', args: {} });
    } else if (command === 'unsaved') unsaved(message.messageId);
    else if (command === 'error') {
      event({ type: 'tool_execution_start', toolCallId: 'failing-tool', toolName: 'fixture_error', args: {} });
      send({ type: 'error', message: `Fixture failed: ${init.apiKey}` });
    } else if (command === 'crash') {
      process.stderr.write(`Fixture crashed: ${init.apiKey}`);
      process.exit(3);
    } else if (command === 'approve') {
      approval = `${init.taskId}-approve`;
      event({ type: 'tool_execution_start', toolCallId: 'approval-tool', toolName: 'write', args: { path: 'fixture.txt' } });
      send({ type: 'request', id: approval, method: 'approve', args: { toolName: 'write', args: { path: 'fixture.txt' }, reason: 'Fixture approval.' } });
    } else if (command === 'inspect-card-init') {
      finish(JSON.stringify({ canDelegate: init.canDelegate, memoryEnabled: init.ecosystem?.memoryEnabled, searchEnabled: init.search?.enabled, role: init.roleDefinition?.id, readOnly: !!init.roleDefinition?.readOnly, permission: init.permission, thinking: init.thinking, modelId: init.gateway?.modelId, prompt: init.card?.prompt ?? '', readRoots: init.card?.readRoots ?? [] }));
    } else if (command === 'reply-dispatches') {
      finish(['设计书已写入。', '```派单\n目标: 世界书/叙事规则\n标题: 写叙事规则\n前置: 设计书已确认\n---\n写四条叙事规则。\n```', '```派单\n目标: 世界书/人设\n标题: 写人物模板\n前置: 设计书已确认\n---\n量身定做人物模板。\n```'].join('\n\n'));
    } else if (command.startsWith('card-request:')) {
      event({ type: 'tool_execution_start', toolCallId: 'card-tool', toolName: 'card_tool', args: {} });
      send({ type: 'request', id: 'card-request', method: 'card', args: JSON.parse(command.slice('card-request:'.length)) });
    } else if (command.startsWith('【换对话 · 请写交接摘要】')) {
      finish(['好的，下面是交接摘要。', '```交接摘要', '已定: 人物模板 v2', '已写: 红孩儿 uid 120', '未完成: 名单剩余 19 人', '第一步: 写黄袍怪', '```'].join('\n'));
    } else if (command === 'inspect-init') {
      finish(JSON.stringify({ role: init.roleDefinition?.id, readOnly: !!init.roleDefinition?.readOnly, planMode: !!init.planMode, sharedWorkspace: !!init.sharedWorkspace, cwd: init.cwd }));
    } else if (command.startsWith('team:')) {
      event({ type: 'tool_execution_start', toolCallId: 'team-tool', toolName: 'agent_team', args: {} });
      send({ type: 'request', id: 'team-request', method: 'team', args: { members: [{ name: '甲队员', prompt: command.slice(5) }, { name: '乙队员', prompt: command.slice(5) }] } });
    } else if (command === 'delegate' || command === 'delegate-hold') {
      childPrompt = command === 'delegate-hold' ? 'hold' : 'complete';
      event({ type: 'tool_execution_start', toolCallId: 'delegating-tool', toolName: 'delegate_task', args: {} });
      send({ type: 'request', id: 'delegate-request', method: 'delegate', args: { title: 'Fixture child', prompt: childPrompt } });
    } else finish(`Echo: ${command}`);
  } else if (message.type === 'response') {
    if (message.id === approval) {
      event({ type: 'tool_execution_end', toolCallId: 'approval-tool', result: { content: [{ type: 'text', text: String(message.result) }] }, isError: message.result !== true });
      finish(`approval:${typeof message.result}:${String(message.result)}`);
    } else if (message.id === 'delegate-request') {
      if (message.error) finish(`delegate-error:${message.error}`);
      else send({ type: 'request', id: 'wait-request', method: 'wait', args: { taskIds: [message.result.id] } });
    } else if (message.id === 'team-request') {
      if (message.error) finish(`team-error:${message.error}`);
      else send({ type: 'request', id: 'wait-request', method: 'wait', args: { taskIds: message.result.members.map(member => member.id) } });
    } else if (message.id === 'card-request') {
      if (message.error) finish(`card-error:${message.error}`);
      else finish(`card:${JSON.stringify(message.result)}`);
    } else if (message.id === 'wait-request') finish(`children:${JSON.stringify(message.result)}`);
  }
});
process.on('disconnect', () => process.exit(0));
