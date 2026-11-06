import { useEffect, useState } from 'react';
import { useApp } from './context';
import { Modal, Row, Toggle } from './primitives';
import { CARD_OPTIMIZATION_LIMITS, DEFAULT_CARD_OPTIMIZATION, type CardAgentOptimization } from '../shared/card-studio/card-optimization';
import { cardSquadSettings } from '../shared/card-studio/squad';
import type { CardSquadMode, CardSquadSettings, PromptGroup, PromptOverrideItem } from '../shared/card-studio/types';
import { PromptEditor } from './card-studio/PromptEditor';

const GROUPS: Array<{ id: PromptGroup; en: string; zh: string }> = [
  { id: 'rules', en: 'Common rules', zh: '通用规则' },
  { id: 'board', en: 'Board rules', zh: '板块通用规则' },
  { id: 'section', en: 'Section prompts', zh: '分区提示词' },
  { id: 'squad', en: 'Squad prompts', zh: '小队提示词' },
  { id: 'kickoff', en: 'Kickoff lines', zh: '开场话' },
];

const SQUAD_MODES: Array<{ id: CardSquadMode; en: string; zh: string }> = [
  { id: 'off', en: 'Off', zh: '关' }, { id: 'read', en: 'Read only', zh: '只读' }, { id: 'write', en: 'Can write', zh: '可写' },
];

/** 工作室设置 → 制卡: 制卡 Agent 优化, the built-in prompts, and the squad switches (§5.2, §5.6, §6.1). */
export function CardStudioSettings() {
  const { data, api, t, run } = useApp();
  const optimization = data.studio?.preferences.cardOptimization ?? DEFAULT_CARD_OPTIMIZATION;
  const squad = cardSquadSettings(data.preferences);
  const limit = data.studio?.preferences.defaultSquadSize || 6;
  const saveSquad = (changes: Partial<CardSquadSettings>) => void run(() => api.savePreferences({ cardSquad: { ...squad, ...changes } }));
  const saveOptimization = (changes: Partial<CardAgentOptimization>) => void run(() => api.studioSettings({ cardOptimization: { ...optimization, ...changes } }));
  const [prompts, setPrompts] = useState<PromptOverrideItem[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmBrief, setConfirmBrief] = useState(false);
  useEffect(() => {
    if (editing) return;
    let alive = true;
    void api.cardPromptOverrides().then(items => { if (alive) setPrompts(items); }, () => { if (alive) setPrompts([]); });
    return () => { alive = false; };
  }, [api, editing]);
  const number = (value: string, min: number, max: number, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  };
  const policyDisabled = !optimization.enabled;
  return <>
    <h3 className="settings-section-title first">{t('Card agent optimization', '制卡Agent优化')}</h3>
    <p className="settings-intro">{t('Controls how much a card conversation writes in one reply, how long it goes on by itself, when it changes conversation, and what a section reads at the start. It applies to conversations started afterwards.', '针对制卡场景，通过综合性优化，节约API调用开销并改进上下文占用问题，部分优化选项可能影响质量，建议结合自身需要选择性启用。')}</p>
    <Row title={t('Turn on card agent optimization', '开启制卡Agent优化')} description={t('On by default.', '默认开启。')}>
      <Toggle checked={optimization.enabled} label={t('Card agent optimization', '制卡Agent优化')} onChange={value => saveOptimization({ enabled: value })} />
    </Row>

    <Row title={t('Files written per reply', '每轮最多派单次数')} description={t('How many `write` / `edit` calls one reply may make , more raises the chance of a cut-off reply. 不限 lets the AI decide.', '一条回复里最多调用的写入工具次数，数字越大越容易遇到回复被截断，选择「不限」时由 AI 自行决定。')}>
      <select disabled={policyDisabled} value={optimization.maxWritesPerRound === null ? 'unlimited' : String(optimization.maxWritesPerRound)} aria-label={t('Files written per reply', '每轮最多派单次数')} onChange={event => saveOptimization({ maxWritesPerRound: event.target.value === 'unlimited' ? null : Number(event.target.value) })}>
        {Array.from({ length: CARD_OPTIMIZATION_LIMITS.writesPerRound.max }, (_, index) => index + CARD_OPTIMIZATION_LIMITS.writesPerRound.min).map(value => <option key={value} value={value}>{value}</option>)}
        <option value="unlimited">{t('No limit', '不限')}</option>
      </select>
    </Row>

    <Row title={t('Automatic rounds per dispatch', '自动写卡的最多对话轮数')} description={t('A dispatch that says it is not finished is carried on automatically up to this many rounds, then pauses for you. 10–50, default 15.', '一键实现各分区待完成派单时,Agent自动执行的最多轮数，超过该轮数则暂停等待用户确认或干预。可设 10–50，默认 15。')}>
      <input key={optimization.maxContinueRounds} disabled={policyDisabled} className="number-input" type="number" min={CARD_OPTIMIZATION_LIMITS.continueRounds.min} max={CARD_OPTIMIZATION_LIMITS.continueRounds.max} step={1} defaultValue={optimization.maxContinueRounds} aria-label={t('Automatic rounds per dispatch', '自动写卡的最多对话轮数')} onBlur={event => saveOptimization({ maxContinueRounds: number(event.target.value, CARD_OPTIMIZATION_LIMITS.continueRounds.min, CARD_OPTIMIZATION_LIMITS.continueRounds.max, optimization.maxContinueRounds) })} />
    </Row>

    <Row title={t('Change conversation at the threshold', '分区上下文达阈值后更换对话')} description={t('When a section conversation reaches the threshold, the app offers a new conversation with a handoff summary. Off keeps one conversation going.', '分区对话的上下文达到阈值时，应用会提议换对话，AI会自动撰写先写交接摘要再开新对话。')}>
      <Toggle checked={optimization.handoffEnabled} disabled={policyDisabled} label={t('Change conversation at the threshold', '分区上下文达阈值后更换对话')} onChange={value => saveOptimization({ handoffEnabled: value })} />
    </Row>
    <Row title={t('Conversation threshold', '换对话 Token 阈值')} description={t('50K–1000K, default 100K. If the model has a smaller window, 80% of that window is used instead.', '可设 50K–1000K，默认 100K。最多不超过窗口的 80% 为上限。（适合分段计费的高端大模型）')}>
      <span className="number-with-unit"><input key={optimization.handoffTokens} disabled={policyDisabled || !optimization.handoffEnabled} className="number-input is-wide" type="number" min={CARD_OPTIMIZATION_LIMITS.handoffTokens.min} max={CARD_OPTIMIZATION_LIMITS.handoffTokens.max} step={10_000} defaultValue={optimization.handoffTokens} aria-label={t('Conversation threshold', '换对话 Token 阈值')} onBlur={event => saveOptimization({ handoffTokens: number(event.target.value, CARD_OPTIMIZATION_LIMITS.handoffTokens.min, CARD_OPTIMIZATION_LIMITS.handoffTokens.max, optimization.handoffTokens) })} />Token</span>
    </Row>

    <Row title={t('Section project brief', '分区项目摘要')} description={t('Preloads a short brief and the exact design-book, variable-table and source-index lines a dispatch needs, so the section reads only those lines. Off reads the whole files as before.', '分区开工时先载入一份短摘要，并列出这条派单用到的设计书、变量表和资料索引行号，减少派单实施时的输入Token消耗。')}>
      <Toggle checked={optimization.sectionBrief} disabled={policyDisabled} label={t('Section project brief', '分区项目摘要')} onChange={value => { if (value) setConfirmBrief(true); else saveOptimization({ sectionBrief: false }); }} />
    </Row>
    <p className="settings-footnote">{t('The brief is a reduction: details outside the chosen lines can be missed, which may affect writing quality. Check people, settings and variables after turning it on.', '摘要是压缩后的内容，参考行之外的细节可能漏掉，可能影响写作质量，开启后建议检查人物、设定和变量是否一致。')}</p>

    <h3 className="settings-section-title">{t('Built-in prompts', '内置提示词')}</h3>
    <p className="settings-intro">{t('Edits are saved as prompt overrides in your data folder, survive updates and apply to conversations started afterwards. The knowledge base, style presets and the workbench prompt are not editable.', '修改当前Agent提示词，可针对性改造。知识库、风格预设和工作台提示词不在其中。')}</p>
    {prompts === null ? <p className="settings-intro">{t('Loading…', '正在读取…')}</p> : <div className="prompt-override-list">
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
    </div>}

    <h3 className="settings-section-title">{t('Squads', '小队')}</h3>
    <p className="settings-intro">{t('Planning and section AIs can send squad members to work in parallel: 查资料 only reads and reports back, 写组件 writes only the components it is given.', '规划 AI 和分区 AI 可以派小队成员分头做：「查资料」只读，交回要点；「写组件」只写分给它的组件。')}</p>
    <Row title={t('Sub-agents', '子代理')} description={t('The most a conversation may send below Ultra. Off: none. Read only: 查资料. Can write: both. Ultra sends a squad anyway: planning 查资料, other sections both.', '不选 Ultra 时最多能派哪种成员：关不派，只读只派「查资料」，可写两种都能派。选 Ultra 时照样派：规划派「查资料」，其他分区两种都能派。')}>
      <div className="segmented" role="group" aria-label={t('Sub-agents', '子代理')}>{SQUAD_MODES.map(mode => <button key={mode.id} type="button" className={squad.mode === mode.id ? 'active' : ''} aria-pressed={squad.mode === mode.id} onClick={() => { if (squad.mode !== mode.id) saveSquad({ mode: mode.id }); }}>{t(mode.en, mode.zh)}</button>)}</div>
    </Row>
    <Row title={t('Self-organised squads', '自行组队')} description={squad.mode === 'off' ? t('Turn the sub-agents on first.', '先打开子代理。') : t('On: the AI decides when to send members, by the built-in rules. Off: only when you ask for it in your message.', '开：AI 按内置标准自己决定什么时候派；关：只在你的消息里明确要求时才派。')}>
      <Toggle checked={squad.selfDispatch} disabled={squad.mode === 'off'} label={t('Self-organised squads', '自行组队')} onChange={value => saveSquad({ selfDispatch: value })} />
    </Row>
    <p className="settings-footnote">{t(`Members use the lead's gateway, model and effort. How many run at once follows “Concurrent agents” (Agent & models); each lead holds at most ${limit} members, set by “Member quota” (Workbench & verification).`, `成员和主 AI 用同一个网关、模型和思考强度。同时跑几个，看「Agent 与模型」里的「同时运行的 Agent」；每个主 AI 最多带 ${limit} 个成员，在「工作台与验证」里的「成员额度」改。`)}</p>

    {editing && <PromptEditor ids={[editing]} onClose={() => setEditing(null)} />}
    {confirmBrief && <Modal title={t('Turn on the section project brief?', '开启分区项目摘要？')} onClose={() => setConfirmBrief(false)}>
      <p className="settings-intro">{t('The brief reduces the design book, variable table and source index to a few headings and line ranges. Details outside those lines can be missed, so writing quality may drop. Check people, settings and variables after turning it on.', '摘要会把设计书、变量表和资料索引压缩成少量标题和行范围，行之外的细节可能漏掉，写作质量可能下降。开启后建议检查人物、设定和变量是否一致。')}</p>
      <div className="modal-actions">
        <button type="button" className="cs-btn" onClick={() => setConfirmBrief(false)}>{t('Cancel', '取消')}</button>
        <button type="button" className="cs-btn is-primary" onClick={() => { setConfirmBrief(false); saveOptimization({ sectionBrief: true }); }}>{t('Turn on', '开启')}</button>
      </div>
    </Modal>}
  </>;
}
