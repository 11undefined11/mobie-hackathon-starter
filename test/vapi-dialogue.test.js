import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createVapiToolHandler } from '../src/vapi-tools.js';
import { createServer } from '../src/server.js';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createSessionStore } from '../src/session-store.js';
import { createVoiceFlow } from '../src/voice-flow.js';

const key = 'vapi-starter-key-at-least-32-characters';
const caller = '+436641234567';
const initialMessages = [
  { role: 'user', message: 'Ich möchte von Wien nach Linz fahren.' },
  { role: 'assistant', message: 'Ich suche passende Orte.' },
];

function message(name, args = {}, { callId = 'vapi-call-1', messages = initialMessages, phone = caller } = {}) {
  return { message: {
    type: 'tool-calls',
    call: { id: callId, type: 'inboundPhoneCall', customer: { number: phone } },
    artifact: { messages },
    toolCallList: [{ id: randomUUID(), type: 'function', function: { name, arguments: args } }],
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

async function preparedCall(handler, { callId = 'vapi-call-1', phone = caller, assistantRole = 'assistant' } = {}) {
  const messages = [...initialMessages];
  for (const [slot, query] of [['departure', 'Wien Hbf'], ['destination', 'Linz Hbf']]) {
    const found = await run(handler, 'find_location', { slot, query }, { callId, phone, messages });
    assert.equal(found.results[0].error, undefined);
    messages.push({ role: assistantRole, message: `${query}. Ist das richtig?` }, { role: 'user', message: 'Ja.' });
    const confirmed = await run(handler, 'confirm_location', { slot, candidateId: '1' }, { callId, phone, messages });
    assert.equal(confirmed.results[0].error, undefined);
  }
  const found = await run(handler, 'search_rides', { time: '2099-01-01T12:00:00+01:00', seatsRequested: 1 }, { callId, phone, messages });
  assert.equal(found.results[0].error, undefined);
  const prepared = await run(handler, 'prepare_booking', { rideId: 'ride-1' }, { callId, phone, messages });
  assert.equal(prepared.results[0].error, undefined);
  return { callId, phone, messages, summary: JSON.parse(prepared.results[0].result).summary };
}

test('an unrelated yes after an older summary never authorizes a booking', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-consent-'));
  const { handler, writes } = harness(t, join(directory, 'state.json'));
  const prepared = await preparedCall(handler);
  const messages = [...prepared.messages,
    { role: 'assistant', message: prepared.summary }, { role: 'user', message: 'Nein.' },
    { role: 'assistant', message: 'Möchten Sie weitere Informationen?' }, { role: 'user', message: 'Ja.' }];
  const result = await run(handler, 'confirm_booking', {}, { messages });
  assert.match(result.results[0].error, /No clear spoken yes/);
  assert.equal(writes.length, 0);
  const bypass = await run(handler, 'book_ride', { confirmed: true });
  assert.match(bypass.results[0].error, /Unknown Vapi tool/);
});

test('Vapi native bot message roles satisfy location and booking transcript checks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-bot-role-'));
  const { handler, writes } = harness(t, join(directory, 'state.json'));
  const prepared = await preparedCall(handler, { assistantRole: 'bot' });
  const messages = [...prepared.messages, { role: 'bot', message: prepared.summary }, { role: 'user', message: 'Ja, bitte.' }];
  const result = await run(handler, 'confirm_booking', {}, { messages });
  assert.equal(result.results[0].error, undefined);
  assert.equal(writes.length, 1);
});

test('an ambiguous street requires the chosen full address rather than just its shared name', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-street-'));
  const { handler, mapbox } = harness(t, join(directory, 'state.json'));
  mapbox.searchLocations = async () => ({ candidates: [
    { publicName: 'Gartenstraße', addressLine: 'Gartenstraße, 6832 Sulz', longitude: 9.65, latitude: 47.29 },
    { publicName: 'Gartenstraße', addressLine: 'Gartenstraße, 6833 Klaus', longitude: 9.64, latitude: 47.3 },
  ] });
  await run(handler, 'find_location', { slot: 'departure', query: 'Gartenstraße' });
  const incomplete = [...initialMessages, { role: 'assistant', message: 'Gartenstraße, richtig?' }, { role: 'user', message: 'Ja.' }];
  const rejected = await run(handler, 'confirm_location', { slot: 'departure', candidateId: '1' }, { messages: incomplete });
  assert.match(rejected.results[0].error, /full address/);
  const complete = [...incomplete, { role: 'assistant', message: 'Gartenstraße, 6832 Sulz. Ist das richtig?' }, { role: 'user', message: 'Ja.' }];
  const accepted = await run(handler, 'confirm_location', { slot: 'departure', candidateId: '1' }, { messages: complete });
  assert.equal(accepted.results[0].error, undefined);
});

test('an older single-file state store blocks startup instead of losing its action keys', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-legacy-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'old-state.json');
  writeFileSync(statePath, JSON.stringify({ 'old-call': { action: { key: 'preserve-this-key', status: 'pending' } } }));
  assert.throws(() => createVapiToolHandler({ mobie: {}, mapbox: {}, statePath }), /Legacy Vapi state requires reviewed migration/);
});

test('a location change invalidates the old spoken summary', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-change-'));
  const { handler, writes } = harness(t, join(directory, 'state.json'));
  const prepared = await preparedCall(handler);
  await run(handler, 'find_location', { slot: 'destination', query: 'New destination' }, prepared);
  const messages = [...prepared.messages, { role: 'assistant', message: prepared.summary }, { role: 'user', message: 'Ja.' }];
  const result = await run(handler, 'confirm_booking', {}, { messages });
  assert.match(result.results[0].error, /Prepare and speak/);
  assert.equal(writes.length, 0);
});

test('the combined dialogue keeps simultaneous callers and their confirmations separate', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-isolation-'));
  const { handler, writes } = harness(t, join(directory, 'state.json'));
  const [first, second] = await Promise.all([
    preparedCall(handler, { callId: 'call-A', phone: caller }),
    preparedCall(handler, { callId: 'call-a', phone: '+436641234568' }),
  ]);
  const spoof = await run(handler, 'confirm_booking', {}, { ...first, phone: second.phone });
  assert.match(spoof.results[0].error, /another caller/);
  await Promise.all([first, second].map(async prepared => {
    const messages = [...prepared.messages, { role: 'assistant', message: prepared.summary }, { role: 'user', message: 'Ja, bitte.' }];
    const result = await run(handler, 'confirm_booking', {}, { ...prepared, messages });
    assert.equal(result.results[0].error, undefined);
  }));
  assert.equal(writes.length, 2);
  assert.deepEqual(new Set(writes.map(write => write.phone)), new Set([caller, '+436641234568']));
  assert.notEqual(writes[0].key, writes[1].key);
});

test('pending actions from the earlier server adapter remain recoverable after integration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-previous-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createSessionStore(directory);
  const context = { callId: 'previous-call', phone: caller };
  let originalKey;
  const engine = createVoiceFlow({ store,
    locations: { searchLocations: async () => ({ candidates: [{ publicName: 'Wien', latitude: 48.2, longitude: 16.3 }] }) },
    mobie: { searchRides: async () => [{ ride: { id: 'ride-1' } }], joinRide: async (_id, _payload, c) => { originalKey = c.idempotencyKey; throw new Error('lost response'); } },
  });
  const found = await engine.execute(context, 'old-find', 'search_locations', { query: 'Wien' });
  const id = found.candidates[0].id;
  await engine.execute(context, 'old-search', 'search_rides', { departureId: id, destinationId: id, locationsConfirmed: true, time: '2099-01-01T12:00:00Z' });
  const selected = await engine.execute(context, 'old-select', 'select_ride', { rideId: 'ride-1' });
  await assert.rejects(engine.execute(context, 'old-book', 'book_ride', { summaryId: selected.summaryId, confirmed: true }), /lost response/);
  const handler = createVapiToolHandler({ store, mapbox: {}, calls: { recordToolCall: async () => {} }, mobie: {
    joinRide: async (_id, _payload, c) => { assert.equal(c.idempotencyKey, originalKey); return { rideRequest: { id: 'original-request' } }; },
  } });
  const result = await run(handler, 'confirm_booking', {}, { callId: context.callId, messages: [] });
  assert.equal(result.results[0].error, undefined);
  assert.equal(JSON.parse(result.results[0].result).request.rideRequest.id, 'original-request');
});

test('Vapi tools use provider caller metadata, resolve locations, search rides, and require spoken confirmation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-vapi-'));
  const statePath = join(directory, 'call-state.json');
  const { handler, contexts, writes, logs, mobie } = harness(t, statePath);
  const injection = await run(handler, 'get_caller_profile', { caller_number: '+436649999999' });
  assert.match(injection.results[0].error, /Unexpected/);
  const callerResult = await run(handler, 'get_caller_profile', {});
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
  assert.match(writes[0].key, /^[A-Za-z0-9._:/-]{1,128}$/);
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

  const blockedChange = await run(handler, 'search_rides', { time: '2030-10-21T09:00:00+02:00' }, { callId: 'retry-call', messages: approvedMessages });
  assert.match(blockedChange.results[0].error, /unresolved/);

  handler = createVapiToolHandler({ mobie, mapbox, calls: { recordToolCall: async () => {} }, statePath });
  const retried = await run(handler, 'confirm_booking', {}, { callId: 'retry-call', messages: [] });
  assert.equal(JSON.parse(retried.results[0].result).request.rideRequest.status, 'PENDING');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].key, calls[1].key);
  assert.deepEqual(calls[0], calls[1]);
});
