import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/session-store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createSessionStore(directory) };
}

test('case variants and Windows device names persist in separate safe state files', t => {
  const { directory, store } = fixture(t);
  for (const callId of ['Call-A', 'call-a', 'CON', 'AUX', 'LPT1']) {
    assert.equal(store.read(callId), null);
    store.save({ callId, marker: callId });
  }
  const restarted = createSessionStore(directory);
  for (const id of ['Call-A', 'call-a', 'CON', 'AUX', 'LPT1']) assert.equal(restarted.read(id).marker, id);
  const files = readdirSync(directory);
  assert.equal(files.length, 5);
  assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
});

test('legacy state retains its original booking key when upgraded to hashed storage', t => {
  const { directory, store } = fixture(t);
  const state = { callId: 'legacy-call', action: { key: 'original-action-key', completed: false } };
  writeFileSync(join(directory, 'legacy-call.json'), JSON.stringify(state));
  assert.deepEqual(store.read(state.callId), state);
  store.save({ ...store.read(state.callId), updated: true });
  // A stale legacy copy must never override the migrated, newer hashed state.
  writeFileSync(join(directory, 'legacy-call.json'), JSON.stringify({ ...state, action: null }));
  const restored = createSessionStore(directory).read(state.callId);
  assert.equal(restored.action.key, 'original-action-key');
  assert.equal(restored.updated, true);
});

test('mismatched and corrupted saved state fail closed instead of starting a new call', t => {
  const { directory, store } = fixture(t);
  store.save({ callId: 'call-a', action: { key: 'do-not-replace' } });
  const file = join(directory, readdirSync(directory)[0]);
  writeFileSync(file, JSON.stringify({ callId: 'call-b' }));
  assert.throws(() => store.read('call-a'), /identity does not match/);
  writeFileSync(file, '{broken-json');
  assert.throws(() => store.read('call-a'), SyntaxError);
  for (const id of ['../escape', '', 'a/b', 'a\\b']) {
    assert.throws(() => store.read(id), /Invalid call ID/);
    assert.throws(() => store.save({ callId: id }), /Invalid call ID/);
  }
});

test('a failed operation releases its call queue while separate calls run independently', async t => {
  const { store } = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const order = [];
  const first = store.exclusive('call-a', async () => { order.push('first'); await gate; throw new Error('Controlled failure'); });
  const failure = assert.rejects(first, /Controlled failure/);
  const second = store.exclusive('call-a', async () => { order.push('second'); });
  await store.exclusive('call-b', async () => { order.push('other call'); });
  assert.deepEqual(order, ['first', 'other call']);
  release();
  await Promise.all([failure, second]);
  assert.deepEqual(order, ['first', 'other call', 'second']);
});
