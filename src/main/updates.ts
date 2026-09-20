import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, lstat, rename, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import type { UpdateInfo } from '../shared/studio-types.ts';

interface Manifest { app: 'Cardwright'; version: string; file: string; sha256: string; url?: string }
async function fileHash(path: string): Promise<string> { const digest=createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
const versionPattern = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
function newer(version: string, current: string): boolean {const a=version.split('.').map(Number),b=current.split('.').map(Number);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;}
async function boundedText(response: Response, maximum: number): Promise<string> {const reader=response.body?.getReader();if(!reader)throw new Error('Empty update manifest.');const chunks:Uint8Array[]=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum){await reader.cancel();throw new Error('Update manifest is too large.');}chunks.push(part.value);}}finally{reader.releaseLock();}return Buffer.concat(chunks).toString('utf8');}
function validateManifest(input: unknown): Manifest {
  const value = input as Manifest;
  if (!value || value.app !== 'Cardwright' || typeof value.version !== 'string' || !versionPattern.test(value.version) || typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256) || typeof value.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,150}\.exe$/i.test(value.file) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(value.file) || (value.url !== undefined && typeof value.url !== 'string')) throw new Error('Choose a valid Cardwright update manifest.');
  return { app: 'Cardwright', version: value.version, file: value.file, sha256: value.sha256.toLowerCase(), url: value.url };
}
export class UpdateService {
  readonly root: string; private value: UpdateInfo = { status: 'idle' }; private previous?: { path: string; sha256: string };
  constructor(private dataDir: string, private currentVersion: string, private fetcher: typeof fetch = fetch) { this.dataDir=resolve(dataDir);this.root = join(this.dataDir, 'updates'); }
  state(): UpdateInfo { return { ...this.value }; }
  private async credentialSnapshot(version:string):Promise<{present:boolean;path:string}>{
    const path=join(this.root,'backups',`credentials-${version}.enc.json`),receiptPath=join(this.root,'backups',`credentials-${version}.receipt.json`);
    try{const info=await lstat(receiptPath);if(!info.isFile()||info.isSymbolicLink()||info.size>64000)throw new Error('Invalid credential receipt.');const receipt=JSON.parse(await readFile(receiptPath,'utf8')) as {format:number;present:boolean;sha256?:string};if(receipt.format!==1||typeof receipt.present!=='boolean')throw new Error('Invalid credential receipt.');if(receipt.present){const saved=await lstat(path);if(!saved.isFile()||saved.isSymbolicLink()||saved.size>32*1024*1024||typeof receipt.sha256!=='string'||await fileHash(path)!==receipt.sha256)throw new Error('Credential snapshot changed.');}return{present:receipt.present,path};}catch(error){throw new Error('The compatible encrypted credential snapshot is unavailable. Rollback was not started.',{cause:error});}
  }
  /** Read-only preflight. Call while the live service is still usable, before closing it. */
  async validateInstall():Promise<void>{
    let pending:Manifest&{path:string};
    try{const file=join(this.root,'pending.json'),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>64000)throw new Error('Invalid pending update.');pending=JSON.parse(await readFile(file,'utf8'));validateManifest(pending);}catch(error){throw new Error('Import a valid update package before installing.',{cause:error});}
    if(!newer(pending.version,this.currentVersion)||typeof pending.path!=='string'||!isAbsolute(pending.path)||dirname(resolve(pending.path))!==this.root)throw new Error('Import a newer verified local update package.');
    const info=await lstat(pending.path);if(!info.isFile()||info.isSymbolicLink()||info.size===0||info.size>1024*1024*1024||await fileHash(pending.path)!==pending.sha256)throw new Error('The update package changed. Import it again.');
  }
  /** Validates the previous installer and compatible data without restoring or writing anything. */
  async validateRollback():Promise<void>{
    let previous:{path:string;sha256:string;version:string};
    try{const file=join(this.root,'rollback.json'),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>64000)throw new Error('Invalid rollback record.');previous=JSON.parse(await readFile(file,'utf8'));}catch(error){throw new Error('No previous installer is cached. Import or install a newer package first.',{cause:error});}
    if(!previous||typeof previous.path!=='string'||!isAbsolute(previous.path)||dirname(resolve(previous.path))!==this.root||!versionPattern.test(previous.version)||typeof previous.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(previous.sha256))throw new Error('No verified previous installer is available.');
    const installer=await lstat(previous.path);if(!installer.isFile()||installer.isSymbolicLink()||installer.size===0||installer.size>1024*1024*1024||await fileHash(previous.path)!==previous.sha256)throw new Error('The previous installer changed and cannot be used for rollback.');
    for(const name of ['state','studio']){const path=join(this.root,'backups',`${name}-${previous.version}.json`);try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024*1024)throw new Error('Invalid backup file.');const value=JSON.parse(await readFile(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid backup data.');}catch(error){if(name==='studio'&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error('The compatible data backup is unavailable; rollback was not started.',{cause:error});}}
    await this.credentialSnapshot(previous.version);
  }
  async import(path: string): Promise<UpdateInfo> {
    const manifestInfo=await lstat(path);if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.size>64000)throw new Error('Update manifest must be a regular file up to 64 KB.');
    const manifest = validateManifest(JSON.parse(await readFile(path, 'utf8')));
    if(!newer(manifest.version,this.currentVersion))throw new Error('Import a newer version. Use rollback for a verified previous version.');
    const installer = join(dirname(path), manifest.file); const info = await lstat(installer);
    if (!info.isFile() || info.isSymbolicLink() || info.size===0 || info.size > 1024 * 1024 * 1024) throw new Error('Update package must be a regular installer up to 1 GB.');
    if (await fileHash(installer) !== manifest.sha256) throw new Error('Update package checksum does not match.');
    await mkdir(this.root, { recursive: true });
    const copied = join(this.root, `Cardwright-${manifest.version}.exe`),temporary=`${copied}.${randomUUID()}.tmp`;
    try {await copyFile(installer,temporary);if(await fileHash(temporary)!==manifest.sha256)throw new Error('Update package changed during copying.');await rename(temporary,copied);}finally{await rm(temporary,{force:true});}
    await writeFile(join(this.root, 'pending.json'), JSON.stringify({ ...manifest, path: copied }));
    this.value = { status: 'ready', version: manifest.version, path: copied, message: 'Package checksum verified. Install explicitly to restart Cardwright.' }; return this.state();
  }
  async check(feed: string): Promise<UpdateInfo> {try{return await this.checkFeed(feed);}catch(error){this.value={status:'failed',message:error instanceof Error?error.message:String(error)};throw error;}}
  private async checkFeed(feed: string): Promise<UpdateInfo> {
    if (!feed.trim()) return this.value = { status: 'idle', message: 'No public update source is configured. Import a local update package.' };
    const source = new URL(feed);
    if (source.protocol !== 'https:' || source.username || source.password) throw new Error('An update source must use HTTPS without credentials.');
    const response = await this.fetcher(source, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || response.redirected) throw new Error(`Update source returned HTTP ${response.status} or redirected.`);
    const text = await boundedText(response,64000);
    const manifest = validateManifest(JSON.parse(text));
    if (!newer(manifest.version,this.currentVersion)) return this.value = { status: 'idle', version: this.currentVersion, message: 'No newer version is available from this source.' };
    const target = new URL(manifest.url || manifest.file, source);
    if (target.origin !== source.origin || target.protocol !== 'https:' || target.username || target.password) throw new Error('The update package must use the configured HTTPS origin without credentials.');
    this.value = { status: 'downloading', version: manifest.version, progress: 0 };
    const download = await this.fetcher(target, { redirect: 'error', signal: AbortSignal.timeout(300000) });
    if (!download.ok || download.redirected || Number(download.headers.get('content-length')) > 1024 * 1024 * 1024) throw new Error('The update package could not be downloaded.');
    await mkdir(this.root,{recursive:true});const path=join(this.root,manifest.file),temporary=join(this.root,`download-${randomUUID()}.tmp`),file=await open(temporary,'wx');
    let size=0;const digest=createHash('sha256'),reader=download.body?.getReader();
    try {if(!reader)throw new Error('Update package is empty.');while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>1024*1024*1024){await reader.cancel();throw new Error('Update package is too large.');}digest.update(item.value);await file.write(item.value);}await file.close();if(size===0||digest.digest('hex')!==manifest.sha256)throw new Error('Downloaded update failed checksum verification.');await rename(temporary,path);}finally{reader?.releaseLock();await file.close().catch(()=>undefined);await rm(temporary,{force:true});}
    const manifestPath = join(this.root, 'download.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    return this.import(manifestPath);
  }
  async prepareInstall(): Promise<string> {
    await this.validateInstall();
    const pending = JSON.parse(await readFile(join(this.root, 'pending.json'), 'utf8')) as Manifest & { path: string };
    validateManifest(pending);
    if (!isAbsolute(pending.path) || dirname(resolve(pending.path)) !== this.root || (await lstat(pending.path)).isSymbolicLink() || await fileHash(pending.path) !== pending.sha256) throw new Error('The update package changed. Import it again.');
    const state = join(this.dataDir, 'state.json');
    await mkdir(join(this.root, 'backups'), { recursive: true });
    try { await copyFile(state, join(this.root, 'backups', `state-${this.currentVersion}.json`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {await copyFile(join(this.dataDir,'studio.json'),join(this.root,'backups',`studio-${this.currentVersion}.json`));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const credentials=join(this.dataDir,'credentials.enc.json'),credentialBackup=join(this.root,'backups',`credentials-${this.currentVersion}.enc.json`);let receipt:{format:1;present:boolean;sha256?:string}={format:1,present:false};
    try{const info=await lstat(credentials);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw new Error('Invalid encrypted credential storage.');await copyFile(credentials,credentialBackup);receipt={format:1,present:true,sha256:await fileHash(credentialBackup)};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(credentialBackup,{force:true});}
    await writeFile(join(this.root,'backups',`credentials-${this.currentVersion}.receipt.json`),JSON.stringify(receipt));
    const old = join(this.root, `Cardwright-${this.currentVersion}.exe`);
    try {const info=await lstat(old);if(!info.isFile()||info.isSymbolicLink())throw new Error('The previous installer cache is invalid.');this.previous = { path: old, sha256: await fileHash(old) }; await writeFile(join(this.root, 'rollback.json'), JSON.stringify({ ...this.previous, version: this.currentVersion })); } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rm(join(this.root,'rollback.json'),{force:true});}
    return pending.path;
  }
  async prepareRollback(): Promise<string> {
    await this.validateRollback();
    const previous = JSON.parse(await readFile(join(this.root, 'rollback.json'), 'utf8')) as { path: string; sha256: string; version: string };
    if (!isAbsolute(previous.path) || dirname(resolve(previous.path)) !== this.root || !versionPattern.test(previous.version) || (await lstat(previous.path)).isSymbolicLink() || await fileHash(previous.path) !== previous.sha256) throw new Error('No verified previous installer is available.');
    const backup = join(this.root, 'backups', `state-${previous.version}.json`);
    const credentials=await this.credentialSnapshot(previous.version),credentialTarget=join(this.dataDir,'credentials.enc.json');
    try{await copyFile(credentialTarget,join(this.root,'backups','credentials-before-rollback.enc.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // All readers are closed. Clear current ciphertext before restoring endpoint
    // configuration, so a later disk error cannot pair new keys with old URLs.
    await rm(credentialTarget,{force:true});
    // Keep the newer state before restoring the exact older compatible snapshot.
    try {const value=JSON.parse(await readFile(backup,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid state backup.');await copyFile(join(this.dataDir, 'state.json'), join(this.root, 'backups', 'state-before-rollback.json'));const temporary=join(this.dataDir,`.state-restore-${randomUUID()}.tmp`);await copyFile(backup,temporary);await rename(temporary,join(this.dataDir,'state.json'));} catch (error) { throw new Error('The compatible data backup is unavailable; rollback was not started.', { cause: error }); }
    try {await copyFile(join(this.root,'backups',`studio-${previous.version}.json`),join(this.dataDir,'studio.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{if(credentials.present){const temporary=join(this.dataDir,`.credentials-restore-${randomUUID()}.tmp`);await copyFile(credentials.path,temporary);await rename(temporary,credentialTarget);}else await rm(credentialTarget,{force:true});}catch(error){await rm(credentialTarget,{force:true});throw new Error('Encrypted credentials could not be restored. Credentials were cleared to avoid pairing keys with another gateway configuration.',{cause:error});}
    return previous.path;
  }
  /** Call only after Harness/store and terminals have flushed and closed. */
  async launchInstall(currentExecutable:string,supervisorPath:string):Promise<{pid:number;reportPath:string}>{await this.prepareInstall();return this.launch('install',currentExecutable,supervisorPath);}
  async launchRollback(currentExecutable:string,supervisorPath:string):Promise<{pid:number;reportPath:string}>{return this.launch('rollback',currentExecutable,supervisorPath);}
  private async launch(action:'install'|'rollback',currentExecutable:string,supervisorPath:string):Promise<{pid:number;reportPath:string}>{
    type Package={path:string;sha256:string;version:string};let previous:Package|undefined;
    const verify=async(value:Package)=>{if(!value||!isAbsolute(value.path)||dirname(resolve(value.path))!==this.root||!versionPattern.test(value.version)||(await lstat(value.path)).isSymbolicLink()||await fileHash(value.path)!==value.sha256)throw new Error('No verified local installer is available.');};
    try{previous=JSON.parse(await readFile(join(this.root,'rollback.json'),'utf8'));if(previous)await verify(previous);}catch(error){if(action==='rollback'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const installer=action==='rollback'?previous:JSON.parse(await readFile(join(this.root,'pending.json'),'utf8')) as Package;if(!installer)throw new Error('A previous installer is not cached.');await verify(installer);
    const backupVersion=previous?.version||this.currentVersion,backup=join(this.root,'backups',`state-${backupVersion}.json`);await lstat(backup);
    await this.credentialSnapshot(backupVersion);
    const currentDirectory=dirname(resolve(currentExecutable));let installed=false;try{installed=/installed=1/.test(await readFile(join(currentDirectory,'cardwright-install.ini'),'utf8'));}catch{}
    const targetDirectory=installed?currentDirectory:join(process.env.LOCALAPPDATA||dirname(this.dataDir),'Programs','Cardwright');
    const id=randomUUID(),runner=join(this.root,`UpdateHost-${id}.exe`),reportPath=join(this.root,`report-${id}.json`),jobPath=join(this.root,`job-${id}.json`);
    await copyFile(supervisorPath,runner);if(await fileHash(runner)!==await fileHash(supervisorPath))throw new Error('The update supervisor changed while copying.');
    await writeFile(jobPath,JSON.stringify({format:1,action,parentPid:process.pid,dataDir:this.dataDir,installer,previous:action==='install'?previous:undefined,backup,studioBackup:join(this.root,'backups',`studio-${backupVersion}.json`),credentialsBackup:join(this.root,'backups',`credentials-${backupVersion}.enc.json`),credentialsReceipt:join(this.root,'backups',`credentials-${backupVersion}.receipt.json`),portableSource:!installed,targetDirectory,executable:join(targetDirectory,'Cardwright.exe'),healthFile:join(this.root,`health-${id}.txt`),healthToken:randomUUID(),reportPath}));
    await writeFile(join(this.root,'latest-job.json'),JSON.stringify({reportPath}));
    const child=spawn(runner,[jobPath],{detached:true,windowsHide:true,stdio:'ignore'});await new Promise<void>((done,reject)=>{child.once('spawn',done);child.once('error',reject);});child.unref();return{pid:child.pid!,reportPath};
  }
  async report():Promise<{status:string;message:string}|null>{try{const record=JSON.parse(await readFile(join(this.root,'latest-job.json'),'utf8')) as {reportPath:string};if(dirname(resolve(record.reportPath))!==this.root)return null;return JSON.parse(await readFile(record.reportPath,'utf8'));}catch{return null;}}
  /** Call after the updated app has loaded its profile and its main window. */
  static async markHealthy(dataDir:string):Promise<void>{const file=process.env.CARDWRIGHT_UPDATE_HEALTH_FILE,token=process.env.CARDWRIGHT_UPDATE_HEALTH_TOKEN;if(!file&&!token)return;if(!file||!token||token.length<20||dirname(resolve(file))!==join(resolve(dataDir),'updates')||!/^health-[a-f0-9-]+\.txt$/i.test(basename(file)))throw new Error('Invalid update startup health marker.');await writeFile(file,token,'utf8');delete process.env.CARDWRIGHT_UPDATE_HEALTH_FILE;delete process.env.CARDWRIGHT_UPDATE_HEALTH_TOKEN;}
}
