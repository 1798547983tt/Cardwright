import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify } from '../src/shared/notify.ts';

const prefs = (extra: Record<string, unknown> = {}) => ({ notifications: true, ...extra }) as Parameters<typeof shouldNotify>[0]['preferences'];

test('a notification waits for the window to be elsewhere, and follows its own switch', () => {
  assert.equal(shouldNotify({ kind: 'finished', focused: false, preferences: prefs() }), true);
  assert.equal(shouldNotify({ kind: 'finished', focused: true, preferences: prefs() }), false, 'the window is in front; the interface already shows it');
  assert.equal(shouldNotify({ kind: 'approval', focused: false, preferences: prefs() }), true);
  assert.equal(shouldNotify({ kind: 'finished', focused: false, preferences: prefs({ notifications: false }) }), false);
  assert.equal(shouldNotify({ kind: 'finished', focused: false, preferences: prefs({ notifyFinished: false }) }), false);
  assert.equal(shouldNotify({ kind: 'approval', focused: false, preferences: prefs({ notifyFinished: false }) }), true, 'each kind has its own switch');
  assert.equal(shouldNotify({ kind: 'approval', focused: false, preferences: prefs({ notifyApproval: false }) }), false);
  // A schedule that was missed, or a one-click run pausing, is not one of the two switches.
  assert.equal(shouldNotify({ kind: 'other', focused: false, preferences: prefs({ notifyFinished: false, notifyApproval: false }) }), true);
  assert.equal(shouldNotify({ kind: 'other', focused: true, preferences: prefs() }), false);
});
