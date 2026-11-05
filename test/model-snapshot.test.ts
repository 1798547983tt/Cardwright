import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { matchModelSnapshot, type ModelSnapshot } from '../src/shared/model-metadata.ts';

const snapshot = JSON.parse(readFileSync(new URL('../src/shared/model-snapshot.json', import.meta.url), 'utf8')) as ModelSnapshot;
const nameOf = (id: string) => id.split('/').pop() ?? id;
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const INPUT_ORDER = ['text', 'image', 'audio', 'video', 'pdf'];

test('the bundled snapshot has a version, a source and no duplicate ids', () => {
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.source, 'https://models.dev');
  assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
  assert.ok(snapshot.models.length >= 100);
  assert.equal(new Set(snapshot.models.map(model => model.id)).size, snapshot.models.length);
});

test('every row has a sane window, ordered efforts and only known modalities', () => {
  for (const model of snapshot.models) {
    assert.ok(Number.isInteger(model.context) && model.context >= 1024 && model.context <= 10_000_000, model.id);
    assert.ok(Number.isInteger(model.output) && model.output >= 1 && model.output <= model.context, model.id);
    assert.equal(typeof model.reasoning, 'boolean', model.id);
    assert.ok(Array.isArray(model.effort) && Array.isArray(model.input), model.id);
    assert.deepEqual(model.effort, [...new Set(model.effort)], model.id);
    assert.deepEqual(model.effort, EFFORT_ORDER.filter(level => model.effort.includes(level)), model.id);
    assert.deepEqual(model.input, [...new Set(model.input)], model.id);
    assert.ok(model.input.every(value => INPUT_ORDER.includes(value)), model.id);
    assert.ok(model.input.includes('text'), model.id);
  }
});

test('only the requested families and generations are bundled', () => {
  const families: Record<string, RegExp> = {
    deepseek: /^deepseek-(?:chat|reasoner|v3|v4)(?:[-.]|$)/,
    openai: /^gpt-5(?:[-.]|$)/,
    claude: /^claude-(?:[a-z]+-)*(?:4|5)(?:[-.]|$)/,
    gemini: /^gemini-(?:2\.5|3|4)(?:[-.]|$)/,
    glm: /^glm-5[a-z]?(?:[-.]|$)/,
    kimi: /^kimi-k(?:2\.[5-9]|3)(?:[-.]|$)/,
    qwen: /^qwen3\.[7-9](?:[-.]|$)/,
  };
  for (const model of snapshot.models) {
    const pattern = families[model.group];
    assert.ok(pattern, `unexpected group ${model.group}`);
    assert.match(nameOf(model.id), pattern, model.id);
  }
  for (const group of Object.keys(families)) assert.ok(snapshot.models.some(model => model.group === group), group);

  const excluded = /(?:embedding|reranker|tts|transcribe|whisper|veo|imagen|nano-banana|computer-use|robotics|-image)(?:-|$)/;
  for (const model of snapshot.models) assert.doesNotMatch(nameOf(model.id), excluded, model.id);
});

test('representative current models match from the bundled file', () => {
  const cases: Array<[string, string]> = [
    ['gpt-5.6-sol', 'openai/gpt-5.6-sol'],
    ['openai/gpt-5.6-sol', 'openai/gpt-5.6-sol'],
    ['claude-opus-4-5', 'anthropic/claude-opus-4-5'],
    ['gemini-2.5-pro', 'google/gemini-2.5-pro'],
    ['glm-5.3', 'zhipuai/glm-5.3'],
    ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
    ['qwen3.7-max', 'alibaba/qwen3.7-max'],
    ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    ['deepseek-reasoner', 'deepseek/deepseek-reasoner'],
    ['deepseek-chat', 'deepseek/deepseek-chat'],
  ];
  for (const [input, expected] of cases) {
    const match = matchModelSnapshot(snapshot.models, input);
    assert.equal(match?.entry.id, expected, input);
    assert.equal(match?.confidence, 1, input);
  }
});
