import assert from 'node:assert/strict';
import { copyFile, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { runSandboxCommand, startSandboxCommand } from '../src/runtime/sandbox-runner.ts';
import { TerminalService } from '../src/main/terminal-service.ts';
import { createServer } from 'node:net';

const exec = promisify(execFile);
const helperPath = resolve('dist/Cardwright.CommandHost.exe');
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cardwright-sandbox-'));
  const project = join(root, 'project'); const outside = join(root, 'outside');
  await mkdir(project); await mkdir(outside);
  return { root, project, outside, async cleanup() { assert.equal(dirname(root), resolve(tmpdir())); assert.match(root, /cardwright-sandbox-/); await rm(root, { recursive: true, force: true }); } };
}
const windowsOnly = { skip: process.platform !== 'win32' };

test('native offline container writes project, denies outside access and network, then revokes grants', windowsOnly, async () => {
  const f = await fixture();
  await writeFile(join(f.project, 'read.txt'), 'inside');
  await writeFile(join(f.outside, 'secret.txt'), 'outside');
  let output = '';
  try {
    const result = await runSandboxCommand(`$ErrorActionPreference='Stop'; Get-Content ./read.txt; Set-Content ./written.txt 'ok'; try { [IO.File]::ReadAllText(${quote(join(f.outside, 'secret.txt'))}); throw 'ESCAPED_READ' } catch [UnauthorizedAccessException] { 'READ_DENIED' }; try { [IO.File]::WriteAllText(${quote(join(f.outside, 'new.txt'))}, 'bad'); throw 'ESCAPED_WRITE' } catch [UnauthorizedAccessException] { 'WRITE_DENIED' }; try { $client=New-Object Net.Sockets.TcpClient; $client.Connect('1.1.1.1',443); throw 'ESCAPED_NETWORK' } catch [Net.Sockets.SocketException] { 'NETWORK_DENIED' }`, f.project, { helperPath, timeout: 15, onData: bytes => { output += bytes.toString('utf8'); } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /inside/); assert.match(output, /READ_DENIED/); assert.match(output, /WRITE_DENIED/); assert.match(output, /NETWORK_DENIED/);
    assert.doesNotMatch(output, /ESCAPED/);
    assert.match(await readFile(join(f.project, 'written.txt'), 'utf8'), /ok/);
    const acl = await exec('icacls.exe', [f.project], { windowsHide: true });
    assert.doesNotMatch(acl.stdout, /S-1-15-2-/);
  } finally { await f.cleanup(); }
});

test('native host missing fails closed', windowsOnly, async () => {
  await assert.rejects(runSandboxCommand('echo unsafe', tmpdir(), { helperPath: join(tmpdir(), 'cardwright-missing-host.exe'), onData() {} }), /missing/);
});

test('read-only AppContainer permits project reads but denies project writes',windowsOnly,async()=>{const f=await fixture();await writeFile(join(f.project,'read.txt'),'READ_ONLY');let output='';try{const result=await runSandboxCommand(`$ErrorActionPreference='Stop'; Get-Content ./read.txt; try {[IO.File]::WriteAllText(${quote(join(f.project,'new.txt'))},'bad');throw 'ESCAPED'}catch [UnauthorizedAccessException]{'WRITE_DENIED'}`,f.project,{helperPath,policy:{mode:'sandbox',network:'off',readOnly:true},onData:bytes=>{output+=bytes.toString();}});assert.equal(result.exitCode,0,output);assert.match(output,/READ_ONLY/);assert.match(output,/WRITE_DENIED/);assert.doesNotMatch(output,/ESCAPED/);await assert.rejects(runSandboxCommand('echo no',f.project,{helperPath,policy:{mode:'sandbox',network:'off',readOnly:true,writeRoots:[f.project]},onData(){}}),/read-only/);}finally{await f.cleanup();}});

test('hard-linked workspace files fail isolation setup before any command executes',windowsOnly,async()=>{const f=await fixture();let output='';const outside=join(f.outside,'original.txt');await writeFile(outside,'safe');await link(outside,join(f.project,'alias.txt'));try{await assert.rejects(runSandboxCommand("Set-Content ./alias.txt 'bad'",f.project,{helperPath,onData:bytes=>{output+=bytes.toString();}}),/Hard-linked/);assert.equal(await readFile(outside,'utf8'),'safe');assert.equal(output,'');const acl=await exec('icacls.exe',[f.project],{windowsHide:true});assert.doesNotMatch(acl.stdout,/S-1-15-2-/);}finally{await f.cleanup();}});

test('AppContainer blocks a listening loopback server which explicit host mode can reach', windowsOnly, async () => {
  const f = await fixture(); let connections = 0; const server = createServer(socket => {connections++; socket.end();}); await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = (server.address() as {port:number}).port;
  const script = `$client=New-Object Net.Sockets.TcpClient; try { $pending=$client.BeginConnect('127.0.0.1',${port},$null,$null); if ($pending.AsyncWaitHandle.WaitOne(1500)) { $client.EndConnect($pending); 'CONNECTED' } else { 'NETWORK_BLOCKED' } } catch { 'NETWORK_BLOCKED=' + $_.Exception.GetBaseException().NativeErrorCode } finally { $client.Dispose() }`;
  try {
    let sandbox = ''; await runSandboxCommand(script,f.project,{helperPath,onData:bytes=>{sandbox+=bytes.toString();}}); assert.match(sandbox,/NETWORK_BLOCKED/); assert.doesNotMatch(sandbox,/CONNECTED/); assert.equal(connections,0);
    let host = ''; await runSandboxCommand(script,f.project,{helperPath,policy:{mode:'host',network:'off'},onData:bytes=>{host+=bytes.toString();}}); assert.match(host,/CONNECTED/); assert.equal(connections,1);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve())); await f.cleanup();}
});

test('junctions cannot give the container access outside its roots', windowsOnly, async () => {
  const f = await fixture(); let output = '';
  await writeFile(join(f.outside, 'secret.txt'), 'outside'); await symlink(f.outside, join(f.project, 'escape'), 'junction');
  try {
    const result = await runSandboxCommand(`$ErrorActionPreference='Stop'; try { [IO.File]::ReadAllText(${quote(join(f.project, 'escape', 'secret.txt'))}); throw 'ESCAPED_READ' } catch [UnauthorizedAccessException] { 'DENIED' }; try { [IO.File]::WriteAllText(${quote(join(f.project, 'escape', 'new.txt'))}, 'bad'); throw 'ESCAPED_WRITE' } catch [UnauthorizedAccessException] { 'DENIED' }`, f.project, { helperPath, onData: bytes => { output += bytes.toString(); } });
    assert.equal(result.exitCode, 0, output); assert.match(output, /DENIED/); assert.doesNotMatch(output, /ESCAPED/);
    await assert.rejects(runSandboxCommand('echo nope', join(f.project, 'escape'), { helperPath, onData() {} }), /reparse point/);
    const acl = await exec('icacls.exe', [f.outside], { windowsHide: true }); assert.doesNotMatch(acl.stdout, /S-1-15-2-/);
  } finally { await f.cleanup(); }
});

test('extra read roots permit reads but reject writes', windowsOnly, async () => {
  const f = await fixture(); let output = ''; await writeFile(join(f.outside, 'read.txt'), 'extra-read');
  try {
    const result = await runSandboxCommand(`$ErrorActionPreference='Stop'; [IO.File]::ReadAllText(${quote(join(f.outside,'read.txt'))}); try { [IO.File]::WriteAllText(${quote(join(f.outside,'bad.txt'))},'bad'); throw 'ESCAPED_WRITE' } catch [UnauthorizedAccessException] { 'WRITE_DENIED' }`, f.project, { helperPath, policy: { mode: 'sandbox', network: 'off', readRoots: [f.outside] }, onData: bytes => { output += bytes.toString(); } });
    assert.equal(result.exitCode, 0, output); assert.match(output,/extra-read/); assert.match(output,/WRITE_DENIED/);
  } finally { await f.cleanup(); }
});

test('a user-managed node toolchain runs in the container', windowsOnly, async () => {
  const f = await fixture(); let output = '';
  const tools = join(f.root,'tools'); await mkdir(tools); const node = join(tools,'node.exe'); await copyFile(await realpath(process.execPath),node);
  try {
    const result = await runSandboxCommand(`$ErrorActionPreference='Stop'; & ${quote(node)} -e "require('fs').writeFileSync('node-result.txt',process.cwd()); console.log('NODE_OK')"; exit $LASTEXITCODE`, f.project, { helperPath, policy: { mode: 'sandbox', network:'off', readRoots: [tools] }, onData: bytes => { output += bytes.toString(); } });
    assert.equal(result.exitCode,0,output); assert.equal((await readFile(join(f.project,'node-result.txt'),'utf8')).toLowerCase(),f.project.toLowerCase()); assert.match(output,/NODE_OK/);
  } finally { await f.cleanup(); }
});

test('bundled node resolves through PATH for both read-write and read-only commands',windowsOnly,async()=>{const f=await fixture();await writeFile(join(f.project,'dependency.cjs'),"module.exports='NODE_PATH_OK'");await writeFile(join(f.project,'write.cjs'),"const value=require('./dependency.cjs');require('node:fs').writeFileSync('bare-node.txt',value);console.log(value)");await writeFile(join(f.project,'read.cjs'),"const fs=require('node:fs'); console.log(fs.readFileSync('bare-node.txt','utf8'));try{fs.writeFileSync('readonly-escape.txt','bad');process.exit(20)}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')throw e;console.log('WRITE_DENIED')}");try{let output='';const written=await runSandboxCommand('node write.cjs',f.project,{helperPath,onData:bytes=>{output+=bytes.toString();}});assert.equal(written.exitCode,0,output);assert.match(output,/NODE_PATH_OK/);output='';const read=await runSandboxCommand('node read.cjs',f.project,{helperPath,policy:{mode:'sandbox',network:'off',readOnly:true},onData:bytes=>{output+=bytes.toString();}});assert.equal(read.exitCode,0,output);assert.match(output,/NODE_PATH_OK/);assert.match(output,/WRITE_DENIED/);await assert.rejects(readFile(join(f.project,'readonly-escape.txt')),{code:'ENOENT'});}finally{await f.cleanup();}});

test('an exact read file grant exposes neither siblings nor writes', windowsOnly, async () => {
  const f = await fixture(); let output = ''; const allowed = join(f.outside,'allowed.txt'); const secret = join(f.outside,'secret.txt'); await writeFile(allowed,'SELECTED_FILE'); await writeFile(secret,'SECRET');
  try {
    const result = await runSandboxCommand(`$ErrorActionPreference='Stop'; [IO.File]::ReadAllText(${quote(allowed)}); try { [IO.File]::ReadAllText(${quote(secret)}); throw 'ESCAPED' } catch [UnauthorizedAccessException] { 'SIBLING_DENIED' }; try { [IO.File]::WriteAllText(${quote(allowed)},'bad'); throw 'ESCAPED' } catch [UnauthorizedAccessException] { 'WRITE_DENIED' }`, f.project, { helperPath, policy: { mode:'sandbox',network:'off',readRoots:[allowed] },onData:bytes=>{output+=bytes.toString();} });
    assert.equal(result.exitCode,0,output); assert.match(output,/SELECTED_FILE/); assert.match(output,/SIBLING_DENIED/); assert.match(output,/WRITE_DENIED/); assert.doesNotMatch(output,/ESCAPED/);
    const acl = await exec('icacls.exe',[allowed],{windowsHide:true}); assert.doesNotMatch(acl.stdout,/S-1-15-2-/);
  } finally {await f.cleanup();}
});

test('parallel containers preserve one another’s grants, and abort closes the command', windowsOnly, async () => {
  const f = await fixture(); const controller = new AbortController(); let output = '';
  try {
    const slow = runSandboxCommand("Write-Output 'STARTED'; Start-Sleep 120", f.project, { helperPath, signal: controller.signal, onData: bytes => { output += bytes.toString(); } });
    while (!output.includes('STARTED')) await new Promise(resolve => setTimeout(resolve,40));
    const fast = await runSandboxCommand("Set-Content ./parallel.txt 'ok'", f.project, {helperPath,onData() {}}); assert.equal(fast.exitCode,0);
    controller.abort(); assert.equal((await slow).exitCode,null);
    const acl = await exec('icacls.exe',[f.project],{windowsHide:true}); assert.doesNotMatch(acl.stdout,/S-1-15-2-/);
  } finally {controller.abort(); await f.cleanup();}
});

test('native timeout kills subprocess tree', windowsOnly, async () => {
  const f = await fixture();
  let output = '';
  try {
    const script = `$p=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep 120' -PassThru -NoNewWindow; Write-Output "CHILD=$($p.Id)"; Start-Sleep 120`;
    const result = await runSandboxCommand(script, f.project, { helperPath, timeout: 5, onData: bytes => { output += bytes.toString('utf8'); } });
    assert.equal(result.exitCode, 124, output);
    const id = /CHILD=(\d+)/.exec(output)?.[1]; assert.ok(id, output);
    const listing = await exec('tasklist.exe', ['/FI', `PID eq ${id}`, '/NH'], { windowsHide: true });
    assert.doesNotMatch(listing.stdout, new RegExp(`\\s${id}\\s`));
  } finally { await f.cleanup(); }
});

test('ConPTY terminal uses the same container and accepts input and resize', windowsOnly, async () => {
  const f = await fixture(); let output = '';
  try {
    const running = startSandboxCommand('', f.project, { helperPath, interactive: true, timeout: 15, onData: bytes => { output += bytes.toString('utf8'); } });
    running.resize(90, 26);
    running.write("Write-Output 'TERMINAL_OK'; [IO.File]::WriteAllText('./terminal.txt','ok'); exit\r");
    const result = await running.completion;
    assert.equal(result.exitCode, 0, output); assert.match(output, /TERMINAL_OK/);
    assert.equal(await readFile(join(f.project, 'terminal.txt'), 'utf8'), 'ok');
  } finally { await f.cleanup(); }
});

test('terminal service reports native events and shuts down live terminals', windowsOnly, async () => {
  const f = await fixture(); const service = new TerminalService(helperPath,1);
  try {
    const session = await service.open('fixture-task',f.project); assert.equal(session.status,'running'); assert.equal(session.mode,'sandbox');
    await assert.rejects(service.open('second',f.project),/limit 1/);
    service.resize(session.id,80,24); service.input(session.id,"Write-Output 'SERVICE_OK'\r");
    const deadline=Date.now()+5000; while (!service.get(session.id).output.includes('SERVICE_OK') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,40));
    assert.match(service.get(session.id).output,/SERVICE_OK/); await service.closeAll(); assert.equal(service.get(session.id).status,'closed');
    assert.throws(()=>service.input(session.id,'echo no'),/stopped/);
  } finally {await service.closeAll(); await f.cleanup();}
});
