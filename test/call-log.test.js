import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendCallLog, normalizeReport } from '../src/call-log.js';

const secret = 'private-team-secret';
const report = { call: { id: 'call-1', transcript: 'Hallo!' }, messages: [], reportReceived: true };

test('log retries reuse the same PUT path/body and never send the local credential upstream', async () => {
  const sent = [];
  const waits = [];
  const logs = createBackendCallLog({ baseUrl: 'https://staging.example/', secret, apiKey: 'local-api-key', sleep: async ms => { waits.push(ms); }, fetch: async (url, options) => {
    sent.push({ url, ...options });
    return new Response(null, { status: sent.length < 3 ? 503 : 204 });
  } });
  await logs.putCall('call-1', report);
  assert.equal(sent.length, 3);
  assert.deepEqual(waits, [250, 1000]);
  for (const request of sent) {
    assert.equal(request.url, 'https://staging.example/integrations/voice-log/calls/call-1');
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.Authorization, `Bearer ${secret}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.body, sent[0].body);
    assert.doesNotMatch(JSON.stringify(request.headers), /local-api-key/);
  }
});

test('permanent log rejection is not retried; transient exhaustion requests provider retry without exposing error bodies', async () => {
  for (const status of [400, 401, 409, 413, 429, 503]) {
    let attempts = 0;
    const logs = createBackendCallLog({ baseUrl: 'https://staging.example', secret, sleep: async () => {}, fetch: async () => {
      attempts++;
      return Response.json({ message: secret }, { status });
    } });
    const transient = status === 429 || status === 503;
    await assert.rejects(logs.putCall('call-1', report), error => {
      assert.equal(error.status, transient ? 503 : status);
      assert.doesNotMatch(error.message, /private-team-secret/);
      return true;
    });
    assert.equal(attempts, transient ? 3 : 1);
  }
  let attempts = 0;
  const logs = createBackendCallLog({ baseUrl: 'https://staging.example', secret, sleep: async () => {}, fetch: async () => { attempts++; throw new Error(secret); } });
  await assert.rejects(logs.putCall('call-1', report), error => error.status === 503 && !error.message.includes(secret));
  assert.equal(attempts, 3);
});

test('invalid IDs, mismatched reports and oversized logs are rejected before transmission', async () => {
  const logs = createBackendCallLog({ baseUrl: 'https://staging.example', secret, fetch: async () => assert.fail('Invalid log went upstream') });
  for (const [id, body] of [['../escape', report], ['call-1', {}], ['call-1', { call: { id: 'wrong-call' } }], ['call-1', { ...report, messages: {} }]]) {
    await assert.rejects(logs.putCall(id, body), error => error.status === 400);
  }
  await assert.rejects(logs.putTool('call-1', 'bad/id', { name: 'search_rides' }), error => error.status === 400);
  await assert.rejects(logs.putTool('call-1', 'tool-1', { name: '' }), error => error.status === 400);
  await assert.rejects(logs.putCall('call-1', { call: { transcript: 'x'.repeat(8_388_608) } }), error => error.status === 413);
});

test('Vapi normalization preserves ordered conversation/tool data while omitting system prompts', () => {
  const normalized = normalizeReport({ message: { type: 'end-of-call-report', call: { id: 'call-1', customer: { number: '+436641234567' } },
    artifact: { transcript: 'Hallo!', messages: [
      { role: 'system', message: 'hidden prompt' }, { role: 'user', message: 'Hallo!', secondsFromStart: 1 },
      { role: 'tool_calls', toolCalls: [{ id: 'tool-1', function: { name: 'search_rides', arguments: '{"seatsRequested":1}' } }] },
      { role: 'tool_call_result', toolCallId: 'tool-1', result: '{"rides":[]}' },
    ] } } });
  assert.equal(normalized.reportReceived, true);
  assert.equal(normalized.call.customerNumber, '+436641234567');
  assert.deepEqual(normalized.messages.map(message => message.seq), [0, 1, 2]);
  assert.equal(normalized.messages[0].text, 'Hallo!');
  assert.deepEqual(normalized.toolCalls[0].arguments, { seatsRequested: 1 });
  assert.deepEqual(normalized.toolCalls[0].result, { rides: [] });
  assert.equal(normalized.toolCalls[0].ok, true);
  assert.doesNotMatch(JSON.stringify(normalized), /hidden prompt/);
  assert.equal(normalizeReport({ message: { type: 'status-update', call: { id: 'call-1' } } }).reportReceived, false);
});
