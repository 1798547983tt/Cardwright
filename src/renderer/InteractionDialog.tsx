import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { Interaction } from '../shared/types';
import { useApp } from './context';
import { Field, Modal } from './primitives';

/** A task-scoped response surface for questions and confirmations. */
export function InteractionDialog({ interaction, inline = false }: { interaction: Interaction; inline?: boolean }) {
  const { data, api, t, run, navigate } = useApp();
  const [value, setValue] = useState(interaction.initialValue || '');
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const task = data.tasks.find(item => item.id === interaction.taskId);
  const questions = interaction.questions || [];
  async function answer(result: unknown) {
    if (busy) return;
    setBusy(true);
    await run(() => api.answerInteraction(interaction.id, result));
    setBusy(false);
  }
  const answered = questions.every(question => {
    const response = answers[question.id];
    return Array.isArray(response) ? response.length > 0 : typeof response === 'string' && response.trim().length > 0;
  });
  const confirmation = interaction.type === 'confirm' || interaction.type === 'plan';
  const content = <>
    <div className="interaction-context"><MessageCircleQuestion size={17} /><span>{t('An agent needs your input', 'Agent 需要你的回答')}</span>{task && <button className="text-button" onClick={() => navigate(task.id)}>{task.title}</button>}</div>
    {interaction.body && <div className="interaction-body">{interaction.body}</div>}
    <form onSubmit={event => { event.preventDefault(); void answer(confirmation ? true : interaction.type === 'questionnaire' ? answers : value); }}>
      {interaction.type === 'select' && <div className="interaction-options">{(interaction.options || []).map(option => <label key={option} className={value === option ? 'selected' : ''}><input type="radio" name={`interaction-${interaction.id}`} required checked={value === option} onChange={() => setValue(option)} disabled={busy} /><span>{option}</span></label>)}</div>}
      {(interaction.type === 'input' || interaction.type === 'editor') && <Field label={t('Your response', '你的回答')}>{interaction.type === 'editor' ? <textarea autoFocus value={value} onChange={event => setValue(event.target.value)} placeholder={interaction.placeholder} rows={9} disabled={busy} /> : <input autoFocus type={interaction.secret ? 'password' : 'text'} value={value} onChange={event => setValue(event.target.value)} placeholder={interaction.placeholder} autoComplete="off" disabled={busy} />}</Field>}
      {interaction.type === 'questionnaire' && <div className="questionnaire">{questions.map(question => <fieldset key={question.id} disabled={busy}><legend>{question.header && <strong>{question.header} · </strong>}{question.question}</legend>{question.options?.length ? <div className="interaction-options">{question.options.map(option => {
        const current = answers[question.id];
        const selected = Array.isArray(current) ? current.includes(option.label) : current === option.label;
        return <label key={option.label} className={selected ? 'selected' : ''}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.id} checked={selected} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: question.multiSelect ? selected ? (Array.isArray(current) ? current : []).filter(item => item !== option.label) : [...(Array.isArray(current) ? current : []), option.label] : option.label }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>;
      })}</div> : <textarea aria-label={question.question} rows={3} value={typeof answers[question.id] === 'string' ? answers[question.id] as string : ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />}{Boolean(question.options?.length) && <Field label={t('Or write your own answer', '或填写自己的答案')}><input aria-label={`${question.header || question.question}: ${t('Custom answer', '自定义回答')}`} value={typeof answers[question.id] === 'string' && !question.options?.some(option => option.label === answers[question.id]) ? answers[question.id] as string : ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></Field>}</fieldset>)}</div>}
      <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => void answer(confirmation ? false : null)}>{confirmation ? t('Decline', '拒绝') : t('Cancel', '取消')}</button><button className="button primary" disabled={busy || (interaction.type === 'select' && !value) || (interaction.type === 'questionnaire' && !answered)}>{busy ? t('Sending…', '发送中…') : interaction.type === 'plan' ? t('Approve plan', '批准计划') : confirmation ? t('Confirm', '确认') : t('Submit response', '提交回答')}</button></div>
    </form>
  </>;
  return inline ? <section className="inline-interaction" aria-label={interaction.title}><h3>{interaction.title}</h3>{content}</section> : <Modal title={interaction.title} onClose={() => { if (!busy) void answer(null); }} className="interaction-modal">{content}</Modal>;
}
