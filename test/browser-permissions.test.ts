import test from 'node:test';
import assert from 'node:assert/strict';
import { browserDecision, isLocal, normalizeUrl, submitsForm, typingDecision } from '../src/core/browser-permissions.ts';

test('an address is normalized, and only http(s) pages are opened', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeUrl('127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app');
  assert.equal(normalizeUrl('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  https://example.com/a b '), 'https://example.com/a%20b');
  assert.equal(normalizeUrl('file:///C:/secret.txt'), null);
  assert.equal(normalizeUrl('about:blank'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl(''), null);
});

test('local pages open by themselves; another site waits for the user', () => {
  assert.equal(isLocal('http://localhost:3000/'), true);
  assert.equal(isLocal('http://127.0.0.1:8080/x'), true);
  assert.equal(isLocal('http://app.localhost:3000/'), true);
  assert.equal(isLocal('https://example.com/'), false);
  assert.deepEqual(browserDecision('http://localhost:3000/', []), { allow: true });
  assert.deepEqual(browserDecision('https://example.com/docs', []), { allow: false, reason: 'ask', origin: 'https://example.com' });
  assert.deepEqual(browserDecision('https://example.com/docs', ['https://example.com']), { allow: true });
  assert.deepEqual(browserDecision('https://other.com/', ['https://example.com']), { allow: false, reason: 'ask', origin: 'https://other.com' });
  assert.deepEqual(browserDecision('file:///C:/secret.txt', ['file://']), { allow: false, reason: 'blocked', message: '只能打开 http 或 https 网页。' });
});

test('passwords and payment details are never typed by the agent', () => {
  assert.equal(typingDecision({ type: 'text', name: 'query' }).allow, true);
  assert.equal(typingDecision({ type: 'password' }).allow, false);
  assert.equal(typingDecision({ type: 'text', autocomplete: 'current-password' }).allow, false);
  assert.equal(typingDecision({ type: 'text', autocomplete: 'cc-number' }).allow, false);
  assert.equal(typingDecision({ type: 'text', name: 'cardNumber' }).allow, false);
  assert.equal(typingDecision({ type: 'text', name: 'cvv' }).allow, false);
  assert.match(typingDecision({ type: 'password' }).message ?? '', /密码/);
});

test('a click that would submit a form is recognized, so the user is asked first', () => {
  assert.equal(submitsForm({ role: 'button', type: 'submit', inForm: true }), true);
  assert.equal(submitsForm({ role: 'button', inForm: true }), true, 'a button in a form submits unless it says otherwise');
  assert.equal(submitsForm({ role: 'button', type: 'button', inForm: true }), false);
  assert.equal(submitsForm({ role: 'input', type: 'submit', inForm: true }), true);
  assert.equal(submitsForm({ role: 'input', type: 'image', inForm: true }), true);
  assert.equal(submitsForm({ role: 'button', type: 'submit' }), false, 'no form, nothing to submit');
  assert.equal(submitsForm({ role: 'a', inForm: true }), false);
  assert.equal(submitsForm({}), false);
});
