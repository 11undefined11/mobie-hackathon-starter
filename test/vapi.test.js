import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createVapiToolHandler } from '../src/vapi-tools.js';
import { createServer } from '../src/server.js';
import { once } from 'node:events';

const key = 'vapi-starter-key-at-least-32-characters';
const caller = '+436641234567';
const initialMessages = [
  { role: 'user', message: 'Ich möchte von Wien nach Linz fahren.' },
  { role: 'assistant', message: 'Ich suche passende Orte.' },
];

function message(name, args = {}, { callId = 'vapi-call-1', messages = initialMessages } = {}) {
  return { message: {
    type: 'tool-calls',
    call: { id: callId, type: 'inboundPhoneCall', customer: { number: caller } },
    artifact: { messages },
    toolCallList: [{ id: `tool-${name}`, type: 'function', function: { name, arguments: args } }],
  } };
}

function harness(t, statePath) {
  const contexts = [];
  const writes = [];
  const logs = [];
  const mobie = {
    caller: async context => { contexts.push({ ...context }); return { firstName: 'Test', savedPlaces: [] }; },
    searchRides: async (payload, context) => { contexts.push({ ...context }); return [{ ride: { id: 'ride-1', priceText: '€ 12' } }]; },
    joinRide: async (rideId, payload, context) => {
      writes.push({ rideId, payload: structuredClone(payload), key: context.idempotencyKey, phone: context.phone, callId: context.callId });
      return { rideRequest: { id: 'request-1', status: 'PENDING' } };
    },
  };
  const mapbox = { searchLocations: async query => ({ attribution: 'Map data', candidates: [{
    publicName: query.includes('Linz') ? 'Linz Hbf' : 'Wien Hbf', addressLine: query,
    longitude: query.includes('Linz') ? 14.29 : 16.37, latitude: query.includes('Linz') ? 48.29 : 48.18,
  }] }) };
  const handler = createVapiToolHandler({ mobie, mapbox, calls: { recordToolCall: async event => logs.push(event) }, statePath });
  t.after(() => rmSync(dirname(statePath), { recursive: true, force: true }));
  return { handler, contexts, writes, logs, mobie, mapbox };
}

async function run(handler, name, args, options) {
  return handler(message(name, args, options));
}

test('Vapi tools use provider caller metadata, resolve locations, search rides, and require spoken confirmation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-vapi-'));
  const statePath = join(directory, 'call-state.json');
  const { handler, contexts, writes, logs, mobie } = harness(t, statePath);
  const callerResult = await run(handler, 'get_caller_profile', { caller_number: '+436649999999' });
  assert.deepEqual(JSON.parse(callerResult.results[0].result), { firstName: 'Test', savedPlaces: [] });
  assert.equal(contexts[0].phone, caller);
  assert.equal(contexts[0].callId, 'vapi-call-1');
  assert.equal(contexts[0].phone, caller);

  await run(handler, 'find_location', { slot: 'departure', query: 'Wien Hbf' });
  let messages = [...initialMessages, { role: 'assistant', message: 'Ich habe Wien Hbf gefunden. Ist das der richtige Ort?' }, { role: 'user', message: 'Ja.' }];
  await run(handler, 'confirm_location', { slot: 'departure', candidateId: '1' }, { messages });
  await run(handler, 'find_location', { slot: 'destination', query: 'Linz Hbf' }, { messages });
  messages = [...messages, { role: 'assistant', message: 'Ich habe Linz Hbf gefunden. Ist das der richtige Ort?' }, { role: 'user', message: 'Ja, bitte.' }];
  await run(handler, 'confirm_location', { slot: 'destination', candidateId: '1' }, { messages });
  const searched = await run(handler, 'search_rides', { time: '2030-10-20T09:00:00+02:00', seatsRequested: 1 }, { messages });
  assert.deepEqual(JSON.parse(searched.results[0].result), { suggestions: [{ ride: { id: 'ride-1', priceText: '€ 12' } }] });

  const prepared = await run(handler, 'prepare_booking', { rideId: 'ride-1' }, { messages });
  const preparedResult = JSON.parse(prepared.results[0].result);
  assert.match(preparedResult.summary, /Wien Hbf/);
  assert.match(preparedResult.summary, /Linz Hbf/);
  assert.match(preparedResult.summary, /€ 12/);
  assert.equal(writes.length, 0);

  const noConsent = await run(handler, 'confirm_booking', {}, { messages: [
    ...messages, { role: 'assistant', message: 'Die Fahrt kostet € 12. Soll ich buchen?' }, { role: 'user', message: 'Ja, aber vielleicht später.' },
  ] });
  assert.ok(noConsent.results[0].error);
  assert.equal(writes.length, 0);

  const approvedMessages = [
    ...messages,
    { role: 'assistant', message: preparedResult.summary },
    { role: 'user', message: 'Ja, bitte.' },
    { role: 'assistant', message: 'Ich sende die Anfrage.' },
  ];
  const confirmed = await run(handler, 'confirm_booking', {}, { messages: approvedMessages });
  const confirmationResult = JSON.parse(confirmed.results[0].result);
  assert.equal(confirmationResult.request.rideRequest.status, 'PENDING');
  assert.match(confirmationResult.message, /driver must still approve/i);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.confirmed, true);
  assert.equal(writes[0].phone, caller);
  assert.match(writes[0].key, /^vapi-[0-9a-f-]{36}$/);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(logs.length >= 7);

  const restarted = createVapiToolHandler({
    mobie: { ...mobie, joinRide: async () => { throw new Error('Duplicate submission.'); } },
    mapbox: { searchLocations: async () => ({ candidates: [] }) },
    calls: { recordToolCall: async () => {} }, statePath,
  });
  const replay = await run(restarted, 'confirm_booking', {}, { messages: approvedMessages });
  assert.deepEqual(JSON.parse(replay.results[0].result), confirmationResult);
  assert.equal(writes.length, 1);
});

test('Vapi tools route is protected by the local starter key and returns the Vapi result envelope', async t => {
  const server = createServer({ apiKey: key, baseUrl: 'https://staging.example', secret: 'team-secret' }, {
    calls: { recordToolCall: async () => {} },
    vapiTools: async () => ({ results: [{ name: 'test_tool', toolCallId: 'tool-1', result: 'ok' }] }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/vapi/tools`;
  const body = JSON.stringify({ message: { type: 'tool-calls', toolCallList: [{ id: 'tool-1' }] } });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
  assert.deepEqual(await response.json(), { results: [{ name: 'test_tool', toolCallId: 'tool-1', result: 'ok' }] });
});

test('Vapi booking timeout retries reuse the persisted key and exact payload after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-vapi-retry-'));
  const statePath = join(directory, 'call-state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const mapbox = { searchLocations: async query => ({ candidates: [{
    publicName: query, longitude: 16.3, latitude: 48.2,
  }] }) };
  const mobie = {
    searchRides: async () => [{ ride: { id: 'ride-retry' } }],
    joinRide: async (rideId, payload, context) => {
      calls.push({ rideId, payload: structuredClone(payload), key: context.idempotencyKey });
      if (calls.length === 1) throw new Error('simulated timeout');
      return { rideRequest: { id: 'request-retry', status: 'PENDING' } };
    },
  };
  let handler = createVapiToolHandler({ mobie, mapbox, calls: { recordToolCall: async () => {} }, statePath });
  await run(handler, 'find_location', { slot: 'departure', query: 'Wien Start' }, { callId: 'retry-call' });
  let messages = [...initialMessages, { role: 'assistant', message: 'Wien Start. Richtig?' }, { role: 'user', message: 'Ja.' }];
  await run(handler, 'confirm_location', { slot: 'departure', candidateId: '1' }, { callId: 'retry-call', messages });
  await run(handler, 'find_location', { slot: 'destination', query: 'Wien Ziel' }, { callId: 'retry-call', messages });
  messages = [...messages, { role: 'assistant', message: 'Wien Ziel. Richtig?' }, { role: 'user', message: 'Ja.' }];
  await run(handler, 'confirm_location', { slot: 'destination', candidateId: '1' }, { callId: 'retry-call', messages });
  await run(handler, 'search_rides', { time: '2030-10-20T09:00:00+02:00', seatsRequested: 1 }, { callId: 'retry-call', messages });
  const prepared = await run(handler, 'prepare_booking', { rideId: 'ride-retry' }, { callId: 'retry-call', messages });
  const summary = JSON.parse(prepared.results[0].result).summary;
  const approvedMessages = [...messages, { role: 'assistant', message: summary }, { role: 'user', message: 'Ja, bitte.' }];
  const failed = await run(handler, 'confirm_booking', {}, { callId: 'retry-call', messages: approvedMessages });
  assert.ok(failed.results[0].error);
  assert.equal(calls.length, 1);

  handler = createVapiToolHandler({ mobie, mapbox, calls: { recordToolCall: async () => {} }, statePath });
  const retried = await run(handler, 'confirm_booking', {}, { callId: 'retry-call', messages: approvedMessages });
  assert.equal(JSON.parse(retried.results[0].result).request.rideRequest.status, 'PENDING');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, calls[1].key);
  assert.deepEqual(calls[0], calls[1]);
});
