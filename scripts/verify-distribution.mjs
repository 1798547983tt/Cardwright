import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const exec=promisify(execFile),root=resolve('.');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const folder=join(root,'release',version,'installer'),portable=join(root,'release',version,'Cardwright-win32-x64');
const installer=join(folder,`Cardwright-Setup-${version}.exe`),zip=join(folder,`Cardwright-${version}-win-x64.zip`);
const binRoot=join(process.env.LOCALAPPDATA,'electron-builder','Cache','7zip@1.0.0');
const binFolder=(await readdir(binRoot,{withFileTypes:true})).find(item=>item.isDirectory()&&item.name.startsWith('7zip-win-x64-'));
assert.ok(binFolder,'The packaging 7zip runtime must be available.');const sevenZip=join(binRoot,binFolder.name,'bin','7za.exe');
async function digest(path){const value=createHash('sha256');for await(const chunk of createReadStream(path))value.update(chunk);return value.digest('hex');}
async function files(folder){const result=[];for(const entry of await readdir(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);}return result;}
const expectedFiles=['Cardwright.exe','resources/app/package.json','resources/app/package-lock.json',...(await files(join(portable,'resources','app','dist'))).map(path=>relative(portable,path).replaceAll('\\','/'))];
const manifest=JSON.parse(await readFile(join(folder,'cardwright-update.json'),'utf8'));
assert.equal(manifest.app,'Cardwright');assert.equal(manifest.version,version);assert.equal(manifest.file,basename(installer));assert.equal(await digest(installer),manifest.sha256);assert.ok((await stat(installer)).size<1024*1024*1024,'Installer must fit the updater 1 GB limit.');
const infoCommand=`$file=[Diagnostics.FileVersionInfo]::GetVersionInfo('${installer.replaceAll("'","''")}'); [pscustomobject]@{ProductName=$file.ProductName;FileVersion=$file.FileVersion;ProductVersion=$file.ProductVersion} | ConvertTo-Json -Compress`;
const metadata=JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',infoCommand],{windowsHide:true})).stdout.trim());
assert.equal(metadata.ProductName,'Cardwright');assert.equal(metadata.ProductVersion,version);assert.ok(metadata.FileVersion.startsWith(version));
const pe=Buffer.alloc(4096),handle=await open(installer,'r');try{await handle.read(pe,0,pe.length,0);}finally{await handle.close();}assert.equal(pe.readUInt16LE(0),0x5a4d);const header=pe.readUInt32LE(0x3c);assert.equal(pe.readUInt32LE(header),0x4550);const optional=header+24,magic=pe.readUInt16LE(optional);assert.ok([0x10b,0x20b].includes(magic));const certificate=optional+(magic===0x20b?112:96)+4*8;assert.ok(certificate+8<=pe.length);assert.equal(pe.readUInt32LE(certificate),0);assert.equal(pe.readUInt32LE(certificate+4),0);metadata.Signature='Unsigned: PE certificate table is empty';
const report={version,at:new Date().toISOString(),status:'passed',noUserInstallation:true,installerMetadata:metadata,artifacts:[],knownBoundaries:['Installer uses the default Electron icon because a Windows ICO was not configured.','Installer is unsigned; no public update feed is configured.','No install/uninstall was run against the real user profile. This validates generated artifacts and their payloads.']};
for(const archive of [zip,installer]){
  const temporary=await mkdtemp(join(tmpdir(),'cardwright-dist-verify-'));
  try{
    if(archive===zip){const tested=await readFile(join(root,'artifacts','workbench-0.7','zip-test.txt'),'utf8');assert.match(tested,/Everything is Ok/);}else{const tested=await exec(sevenZip,['t',archive,'-bsp0'],{windowsHide:true,maxBuffer:8*1024*1024});assert.match(tested.stdout,/Everything is Ok/);}
    await exec(sevenZip,['x',archive,...expectedFiles,`-o${temporary}`,'-y','-bsp0'],{windowsHide:true,maxBuffer:8*1024*1024});
    const verified=[];for(const entry of expectedFiles){const expected=await digest(join(portable,entry)),actual=await digest(join(temporary,entry));assert.equal(actual,expected,`${basename(archive)} has a different payload: ${entry}`);verified.push({path:entry,sha256:actual});}
    report.artifacts.push({path:archive,bytes:(await stat(archive)).size,sha256:await digest(archive),crc:'passed',verifiedPayloadFiles:verified.length,files:verified});
    process.stdout.write(`${basename(archive)}: CRC passed, ${verified.length} payload files match.\n`);
  }finally{assert.equal(dirname(temporary),resolve(tmpdir()));assert.ok(basename(temporary).startsWith('cardwright-dist-verify-'));await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
const receipt=join(root,'artifacts','workbench-0.7','distribution-integrity.json');assert.ok(receipt.startsWith(root+sep));await mkdir(dirname(receipt),{recursive:true});await writeFile(receipt,JSON.stringify(report,null,2));process.stdout.write(JSON.stringify({status:report.status,version,artifacts:report.artifacts.map(({path,bytes,sha256,verifiedPayloadFiles})=>({path,bytes,sha256,verifiedPayloadFiles})),receipt},null,2));
