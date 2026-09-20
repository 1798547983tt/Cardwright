import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AttachmentService, listWorkspace, workspacePath } from '../src/main/attachments.ts';
import { validateAccessRule, ruleMatches } from '../src/main/access-rules.ts';
import { budgetUsage, exceededBudget } from '../src/core/task-budget.ts';
import { Harness } from '../src/main/harness.ts';
import { StudioServices } from '../src/main/studio-services.ts';
import { Vault, type SecretCodec } from '../src/main/vault.ts';
import type { ChatMessage, Task } from '../src/shared/types.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function folder(t:TestContext,beforeCleanup?:()=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'cardwright-studio-services-'));t.after(async()=>{await beforeCleanup?.();assert.equal(dirname(root),resolve(tmpdir()));assert.match(root,/cardwright-studio-services-/);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});const project=join(root,'project'),outside=join(root,'outside'),data=join(root,'data');await Promise.all([mkdir(project),mkdir(outside),mkdir(data)]);return{root,project,outside,data};}
const codec:SecretCodec={encrypt:value=>Buffer.from(`fixture:${value}`),decrypt:value=>value.toString().slice(8)};
async function setup(t:TestContext){
  const instances=new Set<Harness>();const close=async(harness:Harness)=>{await harness.close();instances.delete(harness);};const f=await folder(t,async()=>{for(const harness of instances)await close(harness);});
  const open=()=>{const harness=new Harness(f.data,resolve('test/fixtures/fake-worker.mjs'),new Vault(f.data,codec),{paused:true});const studio=new StudioServices(f.data,harness,resolve('dist/Cardwright.CommandHost.exe'),buffer=>buffer);harness.attachStudio(studio);instances.add(harness);return{harness,studio};};
  const opened=open();
  opened.harness.saveGateway({id:'fixture',name:'Fixture',baseUrl:'https://example.invalid/v1',modelId:'fixture',protocol:'openai-completions',reasoning:false,contextWindow:300000,maxTokens:1000},'never-a-real-key');
  const project=await opened.harness.addProject(f.project);const created=await opened.harness.createTask({projectId:project.id,isolated:false,title:'Fixture without model calls'});
  return{...f,...opened,projectInfo:project,task:opened.studio.task(created.id),open,close};
}

test('attachments detect same-size content drift immediately and after a service restart',async t=>{const f=await folder(t),service=new AttachmentService(f.data);const source=join(f.project,'notes.txt');await writeFile(source,'original');const item=await service.importFile(source);const stored=await service.resolve(item.id);assert.equal((await service.preview(item.id)).text,'original');await writeFile(source,'source changed');assert.equal((await service.preview(item.id)).text,'original','imports should remain a snapshot of the selected file');await writeFile(stored.storedPath,'replaced');await assert.rejects(service.resolve(item.id),/changed after/);await assert.rejects(new AttachmentService(f.data).resolve(item.id),/changed after/);});

test('attachment metadata and project junctions cannot point previews outside their root',async t=>{const f=await folder(t);const outside=join(f.outside,'private.txt');await writeFile(outside,'private');await writeFile(join(f.project,'inside.txt'),'public');await symlink(f.outside,join(f.project,'escape'),process.platform==='win32'?'junction':'dir');await assert.rejects(workspacePath(f.project,'escape/private.txt'),/inside this project/);await assert.rejects(workspacePath(f.project,'../outside/private.txt'),/inside this project/);assert.deepEqual((await listWorkspace(f.project,'','private')).map(item=>item.path),[]);const service=new AttachmentService(f.data),item=await service.importFile(join(f.project,'inside.txt'));const metadata=JSON.parse(await readFile(join(service.root,item.id+'.json'),'utf8'));await writeFile(join(service.root,item.id+'.json'),JSON.stringify({...metadata,storedPath:outside}));await assert.rejects(new AttachmentService(f.data).resolve(item.id),/storage is invalid/);await assert.rejects(service.reference('project',f.project,'escape/private.txt'),/inside this project/);assert.equal(await readFile(outside,'utf8'),'private');});

test('access rules match exact project/session/origin/command scopes and persist revocation',async t=>{
  const f=await setup(t),task=f.task;const rootRule=validateAccessRule({scope:'project',projectId:task.projectId,kind:'write',target:f.project});assert.equal(ruleMatches([rootRule],task.projectId,'other-task','write',join(f.project,'folder','file.txt')),true);assert.equal(ruleMatches([rootRule],task.projectId,task.id,'write',f.project+'-sibling'),false);assert.equal(ruleMatches([rootRule],'other-project',task.id,'write',f.project),false);assert.equal(ruleMatches([rootRule],task.projectId,task.id,'read',f.project),false);
  const command=validateAccessRule({scope:'session',projectId:task.projectId,taskId:task.id,kind:'command',target:'npm test'});assert.equal(ruleMatches([command],task.projectId,task.id,'command',' npm test '),true);assert.equal(ruleMatches([command],task.projectId,'other-task','command','npm test'),false);assert.equal(ruleMatches([command],task.projectId,task.id,'command','npm test; remove-item file'),false);
  const origin=validateAccessRule({scope:'project',projectId:task.projectId,kind:'network',target:'https://api.example.test:8443'});assert.equal(ruleMatches([origin],task.projectId,task.id,'network','https://api.example.test:8443/v1/models'),true);for(const target of ['https://api.example.test/v1','http://api.example.test:8443','https://sub.api.example.test:8443'])assert.equal(ruleMatches([origin],task.projectId,task.id,'network',target),false);assert.throws(()=>validateAccessRule({scope:'project',projectId:task.projectId,kind:'network',target:'https://user:pass@api.example.test'}),/without credentials/);
  f.studio.grantRule({scope:'session',projectId:task.projectId,taskId:task.id,kind:'command',target:'npm test'});const saved=f.studio.snapshot().rules[0];assert.equal(f.studio.allows(task,'command','npm test'),true);f.studio.revokeRule(saved.id);assert.equal(f.studio.allows(task,'command','npm test'),false);assert.deepEqual(JSON.parse(await readFile(join(f.data,'studio.json'),'utf8')).rules,[]);
  const otherProject=await f.harness.addProject(f.outside);assert.throws(()=>f.studio.grantRule({scope:'session',projectId:otherProject.id,taskId:task.id,kind:'command',target:'npm test'}),/do not match/);
});

function budgetTask(id:string,messages:ChatMessage[],createdAt:string):Task{return{id,projectId:'project',title:id,cwd:resolve('.'),status:'completed',permission:'ask',gatewayId:'fixture',thinking:'medium',createdAt,updatedAt:createdAt,messages,tools:[]};}
test('squad budgets count cached and auxiliary usage once across revisions and use elapsed wall time',t=>{
  const at='2026-09-16T00:00:00.000Z',now=Date.parse(at)+15*60000;t.mock.method(Date,'now',()=>now);
  const primary:ChatMessage={id:'primary',role:'assistant',text:'answer',at,usage:{input:100,output:20,cacheRead:70,cacheWrite:10,cost:0.11}};
  const auxiliary:ChatMessage={id:'aux',role:'system',text:'search',at,usage:{input:20,output:5,cacheRead:6,cacheWrite:0,cost:0.05}};
  const archived:ChatMessage={id:'archived',role:'assistant',text:'older answer',at,usage:{input:10,output:5,cacheRead:0,cacheWrite:0,cost:0.02}};
  const parent=budgetTask('parent',[{id:'user',role:'user',text:'task',at},primary,auxiliary],at);parent.revisions=[{id:'revision',label:'previous',createdAt:at,messages:[{...primary},archived],tools:[]}];
  const child=budgetTask('child',[{id:'child-answer',role:'assistant',text:'result',at,usage:{input:20,output:10,cacheRead:10,cacheWrite:5,cost:0.07}}],new Date(Date.parse(at)+5*60000).toISOString());
  const usage=budgetUsage([parent,child]);assert.deepEqual(usage,{tokens:291,money:0.25,elapsedMinutes:15});assert.deepEqual(budgetUsage([]),{tokens:0,money:0,elapsedMinutes:0});
  assert.equal(exceededBudget({tokens:0,minutes:0,money:0},usage),undefined);assert.match(exceededBudget({tokens:291,minutes:0,money:0},usage)!,/token/);assert.match(exceededBudget({tokens:0,minutes:15,money:0},usage)!,/time/);assert.match(exceededBudget({tokens:0,minutes:0,money:0.25},usage)!,/cost/);assert.equal(exceededBudget({tokens:292,minutes:16,money:0.26},usage),undefined);
});

test('completed checkpoint seal protects later edits even with a freshly reopened review and after restart',async t=>{
  const f=await setup(t),file=join(f.project,'app.txt');await writeFile(file,'baseline');await f.studio.beforeRun(f.task,'turn-one');await writeFile(file,'agent result');f.task.status='completed';await f.studio.afterRun(f.task);const initial=await f.studio.checkpointDiff(f.task.id);assert.equal(initial.files[0].note,undefined);
  await writeFile(file,'human result');await writeFile(join(f.project,'human-only.txt'),'keep me');const fresh=await f.studio.checkpointDiff(f.task.id);for(const changed of fresh.files){assert.match(changed.note||'',/after the agent run/);await assert.rejects(f.studio.reviewAction(f.task.id,{checkpointId:fresh.checkpointId,path:changed.path,action:'revert',expectedHash:changed.afterHash}),/newer changes/);}
  await f.close(f.harness);const reopened=f.open(),review=await reopened.studio.checkpointDiff(f.task.id);assert.equal(review.files.length,2);const changed=review.files.find(item=>item.path==='app.txt')!;assert.match(changed.note||'',/after the agent run/);await assert.rejects(reopened.studio.reviewAction(f.task.id,{checkpointId:review.checkpointId,path:changed.path,action:'revert',expectedHash:changed.afterHash}),/newer changes/);assert.equal(await readFile(file,'utf8'),'human result');assert.equal(await readFile(join(f.project,'human-only.txt'),'utf8'),'keep me');
});

test('sealed agent modifications can still be intentionally reverted and cannot use another task checkpoint',async t=>{const f=await setup(t),file=join(f.project,'app.txt');await writeFile(file,'baseline');await f.studio.beforeRun(f.task,'turn-one');await writeFile(file,'agent result');f.task.status='completed';await f.studio.afterRun(f.task);const review=await f.studio.checkpointDiff(f.task.id),changed=review.files[0];const other=await f.harness.createTask({projectId:f.task.projectId,isolated:false,title:'Other'});await assert.rejects(f.studio.checkpointDiff(other.id,review.checkpointId),/another task/);await f.studio.reviewAction(f.task.id,{checkpointId:review.checkpointId,path:changed.path,action:'revert',expectedHash:changed.afterHash});assert.equal(await readFile(file,'utf8'),'baseline');assert.equal(f.task.delivery?.verification,'stale');});

test('accepting a deleted file preserves its null seal and still permits intentional restore', async t => {
  const f = await setup(t); const file = join(f.project, 'deleted.txt'); await writeFile(file, 'original'); await f.studio.beforeRun(f.task, 'deletion'); await rm(file); f.task.status = 'completed'; await f.studio.afterRun(f.task);
  const review = await f.studio.checkpointDiff(f.task.id); const input = { checkpointId: review.checkpointId, path: 'deleted.txt', expectedHash: null };
  await f.studio.reviewAction(f.task.id, { ...input, action: 'accept' }); await f.studio.reviewAction(f.task.id, { ...input, action: 'revert' }); assert.equal(await readFile(file, 'utf8'), 'original');
});

async function until(condition: () => boolean, timeout = 15000): Promise<void> { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Fixture did not reach its expected state.'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('a native check holds its cwd lease against duplicate checks, new prompts, terminals and restores', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t); await writeFile(join(f.project, 'app.txt'), 'baseline'); await f.studio.beforeRun(f.task, 'turn'); await writeFile(join(f.project, 'app.txt'), 'agent result'); f.task.status = 'completed'; await f.studio.afterRun(f.task);
  const review = await f.studio.checkpointDiff(f.task.id); f.studio.settings({ sandboxEnabled: false }); f.studio.saveChecks(f.projectInfo.id, [{ id: 'lease', name: 'Lease check', command: "Write-Output 'LEASE_STARTED'; Start-Sleep -Milliseconds 700; Write-Output 'LEASE_FINISHED'", enabled: true }]);
  const owner = f.task.delivery; const running = f.studio.runTaskChecks(f.task.id); assert.equal(f.studio.directoryLocked(f.project), true);
  await assert.rejects(f.studio.runTaskChecks(f.task.id), /already running/);
  await assert.rejects(f.harness.prompt(f.task.id, 'Must wait'), /checks|file operation/);
  await assert.rejects(f.harness.prompt(f.task.id, 'Steer must wait', 'steer'), /checks|file operation/);
  await assert.rejects(f.studio.openTerminal(f.task.id), /checks|file operation/);
  await assert.rejects(f.studio.reviewAction(f.task.id, { checkpointId: review.checkpointId, path: 'app.txt', expectedHash: review.files[0].afterHash, action: 'revert' }), /checks|file operation/);
  const result = await running; assert.equal(result, owner); assert.equal(f.task.delivery, owner); assert.equal(result.verification, 'passed'); assert.equal(f.studio.directoryLocked(f.project), false); assert.equal(f.task.messages.length, 0); assert.equal(await readFile(join(f.project, 'app.txt'), 'utf8'), 'agent result');
});

test('shutdown awaits native check cancellation and failed-update recovery reopens check admission', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t); await writeFile(join(f.project, 'app.txt'), 'baseline'); f.task.status = 'completed'; f.studio.settings({ sandboxEnabled: false }); f.studio.saveChecks(f.projectInfo.id, [{ id: 'cancel', name: 'Cancel check', command: "Write-Output 'CANCEL_STARTED'; Start-Sleep -Seconds 30", enabled: true }]);
  const running = f.studio.runTaskChecks(f.task.id); await until(() => !!f.task.delivery?.checks.some(check => check.output.includes('CANCEL_STARTED')));
  const closing = f.harness.close(); assert.equal(f.studio.directoryLocked(f.project), true); await assert.rejects(f.studio.runTaskChecks(f.task.id), /shutting down/); await closing; await running; assert.equal(f.studio.directoryLocked(f.project), false); assert.equal(f.task.delivery?.checks.at(-1)?.status, 'cancelled');
  f.harness.resumeAfterFailedUpdate(); f.studio.saveChecks(f.projectInfo.id, [{ id: 'resume', name: 'Resume check', command: "Write-Output 'RESUMED'", enabled: true }]); const resumed = await f.studio.runTaskChecks(f.task.id); assert.equal(resumed.verification, 'passed'); assert.equal(resumed.checks.length, 1); assert.equal(resumed.checks[0].name, 'Resume check');
});

test('terminal admission can reopen after failed update only after native sessions stop', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t); f.studio.settings({ sandboxEnabled: false }); const opening = f.studio.openTerminal(f.task.id); assert.equal(f.studio.terminal.list()[0].status, 'starting'); await assert.rejects(f.studio.runTaskChecks(f.task.id), /Close the terminal/); const terminal = await opening; assert.equal(terminal.status, 'running');
  assert.throws(() => f.studio.terminal.resumeAfterFailedUpdate(), /Close active terminals/); await f.studio.terminal.closeAll(); f.studio.terminal.resumeAfterFailedUpdate(); const reopened = await f.studio.openTerminal(f.task.id); assert.equal(reopened.status, 'running'); assert.notEqual(reopened.id, terminal.id);
});

test('integration requires the configured checks for the exact reviewed file version and blocks apply during checks', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t); const exec = promisify(execFile); const git = async (...args: string[]) => (await exec('git', args, { cwd: f.project, windowsHide: true })).stdout.trim();
  await writeFile(join(f.project, 'app.txt'), 'baseline'); await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('add', '.'); await git('commit', '-m', 'base');
  f.harness.store.state.projects.find(project => project.id === f.projectInfo.id)!.isGit = true; f.task.status = 'completed'; f.studio.settings({ sandboxEnabled: false });
  const child = await f.harness.createTask({ projectId: f.projectInfo.id, parentId: f.task.id, isolated: true, title: 'Member' }); await writeFile(join(child.cwd, 'app.txt'), 'member result'); f.studio.task(child.id).status = 'completed';
  f.studio.saveChecks(f.projectInfo.id, [{ id: 'mutating', name: 'Mutating check', command: "Set-Content -LiteralPath 'generated.txt' -Value 'changed during verification'", enabled: true }]);
  const stale = await f.studio.integrateSquad(f.task.id); assert.equal(stale.integration.checks[0].status, 'passed'); assert.notEqual(stale.integration.checks[0].revision, stale.review.revision); await assert.rejects(f.studio.applyIntegration(f.task.id, stale.integration.id), /stale/); assert.equal(await readFile(join(f.project, 'app.txt'), 'utf8'), 'baseline');
  f.studio.saveChecks(f.projectInfo.id, []); const missing = await f.studio.integrateSquad(f.task.id); f.studio.saveChecks(f.projectInfo.id, [{ id: 'new-check', name: 'Added after review', command: 'Write-Output ok', enabled: true }]); await assert.rejects(f.studio.applyIntegration(f.task.id, missing.integration.id), /missing/);
  const valid = await f.studio.integrateSquad(f.task.id); f.studio.saveChecks(f.projectInfo.id, [{ id: 'new-check', name: 'Added after review', command: "Write-Output 'RUNNING'; Start-Sleep -Milliseconds 600", enabled: true }]); const running = f.studio.runTaskChecks(f.task.id); await assert.rejects(f.studio.applyIntegration(f.task.id, valid.integration.id), /checks|file operation/); await running;
});
