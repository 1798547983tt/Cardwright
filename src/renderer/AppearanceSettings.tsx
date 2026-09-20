import { useState } from 'react';
import { RotateCcw, Upload, Volume2 } from 'lucide-react';
import { useApp } from './context';
import { Avatar, useAvatarChanger } from './Avatar';
import { Row, Toggle } from './primitives';
import { configureSound, playCue } from './sound';

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
