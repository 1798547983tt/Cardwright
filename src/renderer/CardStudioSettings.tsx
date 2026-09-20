import { useEffect, useState } from 'react';
import { useApp } from './context';
import { Row, Toggle } from './primitives';
import { DEFAULT_HANDOFF, type HandoffSettings } from '../shared/card-studio/handoff';
import type { PromptGroup, PromptOverrideItem } from '../shared/card-studio/types';
import { PromptEditor } from './card-studio/PromptEditor';

const GROUPS: Array<{ id: PromptGroup; en: string; zh: string }> = [
  { id: 'rules', en: 'Common rules', zh: '通用规则' },
  { id: 'board', en: 'Board rules', zh: '板块通用规则' },
  { id: 'section', en: 'Section prompts', zh: '分区提示词' },
  { id: 'kickoff', en: 'Kickoff lines', zh: '开场话' },
];

/** 工作室设置 → 制卡: when the app offers a new conversation, and developer mode with prompt overrides (§5.2, §5.6). */
export function CardStudioSettings() {
  const { data, api, t, run } = useApp();
  const handoff = data.preferences.cardHandoff ?? DEFAULT_HANDOFF;
  const developer = !!data.preferences.developerMode;
  const [prompts, setPrompts] = useState<PromptOverrideItem[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (!developer || editing) return;
    let alive = true;
    void api.cardPromptOverrides().then(items => { if (alive) setPrompts(items); }, () => { if (alive) setPrompts([]); });
    return () => { alive = false; };
  }, [api, developer, editing]);
  function save(changes: Partial<HandoffSettings>) {
    const next = { ...handoff, ...changes };
    if (next.tokens !== handoff.tokens || next.windowPercent !== handoff.windowPercent) void run(() => api.savePreferences({ cardHandoff: next }));
  }
  const number = (value: string, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.round(parsed) : fallback; };
  return <>
    <h3 className="settings-section-title first">{t('Changing conversations', '换对话')}</h3>
    <p className="settings-intro">{t('When a section conversation reaches either threshold, the app offers a new conversation: the section AI writes a handoff summary, and the new conversation starts from it. Whichever comes first counts.', '分区对话的上下文达到任一阈值时，应用会提议换对话：先请分区 AI 写交接摘要，再带着摘要开新对话。两个阈值先到先算。')}</p>
    <Row title={t('Token threshold', 'Token 阈值')} description={t('Default 200,000. From 10,000 to 10,000,000.', '默认 200,000，可设 10,000 到 10,000,000。')}>
      <input key={handoff.tokens} className="number-input is-wide" type="number" min={10_000} max={10_000_000} step={10_000} defaultValue={handoff.tokens} aria-label={t('Token threshold for a new conversation', '换对话的 Token 阈值')} onBlur={event => save({ tokens: number(event.target.value, handoff.tokens) })} />
    </Row>
    <Row title={t('Share of the model window', '占模型窗口的比例')} description={t('Default 50%. From 10% to 90%.', '默认 50%，可设 10% 到 90%。')}>
      <span className="number-with-unit"><input key={handoff.windowPercent} className="number-input" type="number" min={10} max={90} step={5} defaultValue={handoff.windowPercent} aria-label={t('Share of the model window for a new conversation', '换对话占模型窗口的比例')} onBlur={event => save({ windowPercent: number(event.target.value, handoff.windowPercent) })} />%</span>
    </Row>

    <h3 className="settings-section-title">{t('Developer mode', '开发者模式')}</h3>
    <Row title={t('Show and edit built-in prompts', '查看和修改内置提示词')} description={t('Edits are saved as prompt overrides in your data folder, survive updates and apply to conversations started afterwards. The knowledge base, style presets and the workbench prompt are not editable.', '修改存为提示词覆盖，放在资料目录里，软件更新后仍然生效，对之后新开的对话生效。知识库、风格预设和工作台提示词不在其中。')}>
      <Toggle checked={developer} label={t('Developer mode', '开发者模式')} onChange={value => void run(() => api.savePreferences({ developerMode: value }))} />
    </Row>
    {developer && (prompts === null ? <p className="settings-intro">{t('Loading…', '正在读取…')}</p> : <div className="prompt-override-list">
      {GROUPS.map(group => {
        const items = prompts.filter(item => item.group === group.id);
        if (!items.length) return null;
        return <section key={group.id}><h4>{t(group.en, group.zh)}</h4><ul>{items.map(item => <li key={item.id}>
          <span className="prompt-override-name">{item.label}</span>
          {item.overridden && <em className="is-modified">{t('Modified', '已修改')}</em>}
          {item.stale && <em className="is-stale" title={t('A newer version changed the default this edit was based on.', '新版本改了你修改时依据的默认内容。')}>{t('Default updated', '默认已更新')}</em>}
          <button type="button" className="button small" onClick={() => setEditing(item.id)}>{t('Edit', '编辑')}</button>
        </li>)}</ul></section>;
      })}
    </div>)}
    {editing && <PromptEditor ids={[editing]} onClose={() => setEditing(null)} />}
  </>;
}
