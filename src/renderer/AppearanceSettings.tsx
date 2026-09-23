import { useEffect, useState } from 'react';
import { FolderOpen, PackageOpen, RotateCcw, Upload, Volume2 } from 'lucide-react';
import { useApp } from './context';
import { Avatar, useAvatarChanger } from './Avatar';
import { Row, Toggle } from './primitives';
import { configureSound, playCue } from './sound';
import { BUILT_IN_THEMES } from '../shared/themes';

/**
 * 主题 (Q15, Q20): the three built-in themes and the theme packs in the data folder, as swatches. A theme changes
 * colours only; a pack that could not be read is listed with the reason.
 */
export function ThemeSettings() {
  const { api, data, t, run, appearance } = useApp();
  const current = data.preferences.theme;
  const packs = appearance?.snapshot?.themes ?? [];
  const rejected = appearance?.snapshot?.rejectedThemes ?? [];
  const names: Record<string, string> = { dark: t('Dark', '深色'), light: t('Light', '浅色'), sakura: t('Red, pink & white', '红粉白') };
  const notes: Record<string, string> = { dark: t('The workbench as it was', '工作台原来的样子'), light: t('Paper and ink', '纸色与墨色'), sakura: t('Snow white, crimson rail, raspberry accent', '雪白、绯红侧栏、莓粉强调') };
  const choose = (theme: string) => void run(() => api.savePreferences({ theme }));
  const card = (id: string, name: string, note: string, swatch: string[], system = false) => <button key={id} type="button" className="theme-card" aria-pressed={current === id} data-theme-option={id} onClick={() => choose(id)}>
    <span className={`theme-swatch ${system ? 'is-system' : ''}`} aria-hidden="true">{swatch.map((color, index) => <i key={index} style={{ background: color }} />)}</span>
    <b>{name}</b><small>{note}</small>
  </button>;
  return <section aria-label={t('Theme', '主题')}>
    <h3 className="settings-section-title">{t('Theme', '主题')}</h3>
    <div className="theme-picker">
      {card('system', t('Follow system', '跟随系统'), t('Dark or light, as Windows is set', '跟随 Windows 的深浅色'), ['#111316', '#d4b856', '#e4e7eb'], true)}
      {BUILT_IN_THEMES.map(theme => card(theme.id, names[theme.id] ?? theme.name, notes[theme.id] ?? '', theme.swatch))}
      {packs.map(theme => card(theme.id, theme.name, t('Theme pack', '主题包'), theme.swatch))}
    </div>
    <p className="settings-footnote">{t('A theme changes colours only: layout, type sizes and controls stay the same. The card studio keeps its dossier look; only its gold and board light lean towards the theme.', '主题只换颜色，布局、字号和控件形状不变。制卡工坊保留卷宗的样子，只有金色与板块灯光会向主题色偏一点。')}</p>
    <div className="appearance-actions">
      <button type="button" className="button small" onClick={() => void run(() => api.openAppearanceFolder('themes'))}><FolderOpen size={14} />{t('Open the themes folder', '打开主题文件夹')}</button>
      <button type="button" className="button small" onClick={() => appearance?.refresh()}><RotateCcw size={14} />{t('Read theme packs again', '重新读取主题包')}</button>
    </div>
    {rejected.length > 0 && <div className="appearance-rejected" role="status"><b>{t('Theme packs not loaded', '没有加载的主题包')}</b>{rejected.map(item => <span key={item.folder}>{item.folder}：{item.reason}</span>)}</div>}
  </section>;
}

/** 桌宠 (Q14): off by default; choose a pet, install a Codex pet pack from a ZIP or a folder, read the built-in one's notice. */
export function PetSettings() {
  const { api, data, t, run, notify, appearance } = useApp();
  const prefs = data.preferences;
  const pets = appearance?.snapshot?.pets ?? [];
  const rejected = appearance?.snapshot?.rejectedPets ?? [];
  // The same choice the pet makes: the user's pet, else the theme's, else the built-in one.
  const themePet = [...BUILT_IN_THEMES, ...(appearance?.snapshot?.themes ?? [])].find(theme => theme.id === prefs.theme)?.pet?.id;
  const chosen = [prefs.petId, themePet, 'erii'].find(id => id && pets.some(pet => pet.id === id)) ?? pets[0]?.id;
  const [notice, setNotice] = useState('');
  const builtIn = pets.find(pet => pet.builtIn && pet.notice);
  useEffect(() => { if (builtIn) void api.petNotice(builtIn.id).then(setNotice, () => setNotice('')); }, [api, builtIn?.id]);
  async function install(from: 'zip' | 'folder') {
    const result = await run(() => api.installPet(from));
    if (!result) return;
    appearance?.refresh();
    notify(result.replaced ? t(`Replaced the pet ${result.displayName}.`, `已替换桌宠「${result.displayName}」。`) : t(`Installed the pet ${result.displayName}.`, `已安装桌宠「${result.displayName}」。`));
  }
  return <section aria-label={t('Desk pet', '桌宠')}>
    <h3 className="settings-section-title">{t('Desk pet', '桌宠')}</h3>
    <Row title={t('Show the desk pet', '显示桌宠')} description={t('A small companion in its own window above all others, still there while Cardwright is minimized. It reports the task at hand, approvals, results, one-click making and today’s tokens from this computer; it never calls a model. Click it to open what it reports, drag it anywhere, right-click for its menu, or close it with its ×.', '浮在所有窗口最前面的小伙伴，Cardwright 最小化时也在。它报当前任务、审批、结果、一键制作进度和今天的 Token 用量，全是本机的状态，不调用模型。单击打开它正在报的任务，拖到哪里都行，右键有菜单，点它的 × 收起。')}>
      <Toggle label={t('Show the desk pet', '显示桌宠')} checked={prefs.petEnabled === true} onChange={value => void run(() => api.savePreferences({ petEnabled: value }))} />
    </Row>
    <div className="pet-list" role="group" aria-label={t('Pets', '宠物')}>
      {pets.map(pet => <button key={pet.id} type="button" className="pet-option" aria-pressed={pet.id === chosen} onClick={() => void run(() => api.savePreferences({ petId: pet.id }))}>
        <span aria-hidden="true" /><b>{pet.displayName}</b>
        <small>{pet.description}{pet.builtIn ? t(' · Built in · unofficial fan art', ' · 内置 · 非官方同人素材') : t(' · Installed', ' · 已安装')}{pet.version === 2 ? ' · v2' : ''}</small>
      </button>)}
    </div>
    <div className="appearance-actions">
      <button type="button" className="button small" onClick={() => void install('zip')}><PackageOpen size={14} />{t('Install from a ZIP', '从 ZIP 安装')}</button>
      <button type="button" className="button small" onClick={() => void install('folder')}><Upload size={14} />{t('Install from a folder', '从文件夹安装')}</button>
      <button type="button" className="button small" onClick={() => void run(() => api.openAppearanceFolder('pets'))}><FolderOpen size={14} />{t('Open the pets folder', '打开宠物文件夹')}</button>
    </div>
    <p className="settings-footnote">{t('Pet packs use the Codex format: pet.json and a 1536×1872 (or 1536×2288) spritesheet.webp. Packs are checked before they are installed.', '宠物包用 Codex 桌宠包格式：pet.json 加一张 1536×1872（或 1536×2288）的 spritesheet.webp。安装前会先检查。')}</p>
    {rejected.length > 0 && <div className="appearance-rejected" role="status"><b>{t('Pet packs not loaded', '没有加载的宠物包')}</b>{rejected.map(item => <span key={item.folder}>{item.folder}：{item.reason}</span>)}</div>}
    {builtIn && notice && <details className="pet-notice"><summary>{t(`About ${builtIn.displayName}: source and licence`, `关于「${builtIn.displayName}」：来源与许可`)}</summary><pre>{notice}</pre></details>}
  </section>;
}

function PortraitEditor({ role }: { role: 'user' | 'assistant' }) {
  const { api, data, t, run } = useApp();
  const [busy, setBusy] = useState(false);
  const changer = useAvatarChanger(role);
  return <div className="avatar-editor">
    <Avatar role={role} size={96} interactive />
    <div className="avatar-editor-copy"><span className="code-tag" aria-hidden="true">{role === 'user' ? 'PLAYER' : 'AGENT'}</span><strong>{role === 'user' ? t('Your avatar', '用户头像') : t('AI avatar', 'AI 头像')}</strong><small>{role === 'user' ? data.preferences.name || t('You', '你') : 'Cardwright'}</small></div>
    <div className="avatar-editor-actions">
      <button type="button" className="button small" aria-label={role === 'user' ? t('Change user avatar', '更换用户头像') : t('Change AI avatar', '更换 AI 头像')} onClick={changer.change}><Upload size={14} />{t('Change image', '更换图片')}</button>
      <button type="button" className="text-button" aria-label={role === 'user' ? t('Reset user avatar', '恢复默认用户头像') : t('Reset AI avatar', '恢复默认 AI 头像')} disabled={busy || !data.preferences.avatars?.[role]} onClick={() => { setBusy(true); void run(() => api.resetAvatar(role)).finally(() => setBusy(false)); }}><RotateCcw size={12} />{t('Reset', '恢复默认')}</button>
    </div>
    {changer.element}
  </div>;
}

export function AvatarSettings() {
  const { t } = useApp();
  return <section className="avatar-settings" aria-label={t('Profile avatars', '个人与 AI 头像')}>
    <div className="avatar-settings-intro"><h3>{t('Make it yours', '你的工作室，你的形象')}</h3><p>{t('Your avatar appears in the navigation and your messages; the AI avatar appears on every response. Click a portrait to change it.', '用户头像显示在导航和你发送的消息中，AI 头像显示在每条回复旁。点击头像即可更换。')}</p></div>
    <div className="avatar-settings-list"><PortraitEditor role="user" /><PortraitEditor role="assistant" /></div>
    <p className="settings-footnote">{t('Choose a local PNG or JPEG up to 10 MB, then drag and zoom to crop. Images are saved at up to 512 pixels on this computer, and past messages update too.', '支持 10 MB 以内的本地 PNG 或 JPEG，可拖动和缩放裁剪，保存为最大 512 像素并只存于本机，历史消息也会统一更新。')}</p>
  </section>;
}

/** Sound cues are synthesized locally and only play while Cardwright is in the foreground. */
export function SoundSettings() {
  const { api, data, t, run } = useApp();
  const prefs = data.preferences;
  const [volume, setVolume] = useState(prefs.soundVolume);
  const save = (changes: { soundEnabled?: boolean; soundVolume?: number; bootSequence?: boolean }) => void run(() => api.savePreferences(changes));
  return <>
    <Row title={t('Start-up animation', '开机动画')} description={t('The Cardwright mark and the loading bar when the window opens. Off since 0.9; upgrades turned it off once.', '打开窗口时的 Cardwright 标识与进度条。0.9 起默认关闭，升级时统一关过一次。')}>
      <Toggle label={t('Start-up animation', '开机动画')} checked={prefs.bootSequence === true} onChange={value => save({ bootSequence: value })} />
    </Row>
    <Row title={t('Interface sounds', '界面音效')} description={t('Clicks, sending, page changes, start-up, completion, approval requests and truncation. Plays only while the window is in front.', '点击、发送、换页、开机、完成、需要审批和输出被截断时播放。仅在窗口位于前台时发声。')}>
      <Toggle label={t('Interface sounds', '界面音效')} checked={prefs.soundEnabled} onChange={value => save({ soundEnabled: value })} />
    </Row>
    <Row title={t('Sound volume', '音效音量')}>
      <div className="volume-control">
        <input type="range" min={0} max={100} step={5} value={volume} disabled={!prefs.soundEnabled} aria-label={t('Sound volume', '音效音量')} aria-valuetext={`${volume}%`} onChange={event => { const value = Number(event.target.value); setVolume(value); configureSound({ enabled: prefs.soundEnabled, volume: value }); }} onPointerUp={() => save({ soundVolume: volume })} onKeyUp={() => save({ soundVolume: volume })} />
        <b>{volume}%</b>
        <button type="button" className="button small" disabled={!prefs.soundEnabled} onClick={() => playCue('complete', true)}><Volume2 size={14} />{t('Preview', '试听')}</button>
      </div>
    </Row>
  </>;
}
