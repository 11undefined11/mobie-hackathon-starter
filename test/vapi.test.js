import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer } from '../src/server.js';
import { vapiContext } from '../src/vapi.js';

const apiKey = 'local-secret-with-at-least-32-characters';
const secret = 'team-secret-with-at-least-32-characters';
const phone = '+436641234567';
const location = { publicName: 'Wien', longitude: 16.37, latitude: 48.2 };

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, { loggingFails = false } = {}) {
  const seen = [], logs = [];
  const directory = mkdtempSync(join(tmpdir(), 'mobie-vapi-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = httpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-mobie-caller-phone'] === '+436640000000') {
      res.writeHead(409); return res.end(JSON.stringify({ code: 'AMBIGUOUS_CALLER', error: secret }));
    }
    const value = req.url.endsWith('/caller') ? { userId: phone }
      : req.url.endsWith('/rides/search') ? [{ ride: { id: 'ride-1' } }]
        : { rideRequest: { id: 'request-1', status: 'PENDING' } };
    res.end(JSON.stringify(value));
  });
  const baseUrl = await listen(t, upstream);
  const config = { apiKey, secret, baseUrl, sessionDirectory: directory };
  const server = createServer(config, {
    mapbox: { searchLocations: async () => ({ candidates: [location], attribution: 'Test' }) },
    calls: { recordToolCall: async event => { logs.push(event); if (loggingFails) throw new Error('log outage'); } },
  });
  const url = await listen(t, server);
  const envelope = (name, args, id = randomUUID()) => ({ message: {
    type: 'tool-calls', call: { id: 'vapi-call', type: 'inboundPhoneCall', customer: { number: phone } },
    toolCallList: [{ id, type: 'function', function: { name, arguments: args } }],
  } });
  const post = async (body, headers = {}) => fetch(`${url}/vapi/tools`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const tool = async (name, args = {}) => {
    const response = await post(envelope(name, args));
    assert.equal(response.status, 200);
    const value = (await response.json()).results[0];
    assert.equal(value.error, undefined);
    assert.equal(typeof value.result, 'string');
    return JSON.parse(value.result);
  };
  return { seen, logs, post, envelope, tool };
}

test('authenticated Vapi envelope executes real upstream search and one confirmed booking with correlated logs', async t => {
  const { seen, logs, tool } = await fixture(t);
  await tool('get_caller');
  const candidates = await tool('search_locations', JSON.stringify({ query: 'Wien' }));
  const id = candidates.candidates[0].id;
  await tool('search_rides', { departureId: id, destinationId: id, locationsConfirmed: true, time: '2099-01-01T12:00:00+01:00', seatsRequested: 2 });
  const summary = await tool('select_ride', { rideId: 'ride-1' });
  const result = await tool('book_ride', { summaryId: summary.summaryId, confirmed: true });
  await tool('book_ride', { summaryId: summary.summaryId, confirmed: true });
  assert.equal(result.requiresDriverApproval, true);
  const writes = seen.filter(item => item.url.endsWith('/join-detailed'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.departure, location);
  assert.equal(writes[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(writes[0].headers['x-mobie-caller-phone'], phone);
  assert.equal(writes[0].headers['x-mobie-call-id'], 'vapi-call');
  assert.ok(writes[0].headers['idempotency-key']);
  assert.equal(logs.length, 6);
  assert.ok(logs.every(event => event.callId === 'vapi-call' && event.toolCallId));
});

test('Vapi authentication, metadata and tool arguments reject spoofed identity before upstream execution', async t => {
  const { post, envelope, seen } = await fixture(t);
  assert.equal((await post(envelope('get_caller', {}), { Authorization: 'Bearer wrong' })).status, 401);
  const missing = envelope('get_caller', {});
  delete missing.message.call.customer;
  assert.equal((await post(missing)).status, 400);
  const conflict = envelope('get_caller', {});
  conflict.message.customer = { number: '+436641234568' };
  assert.equal((await post(conflict)).status, 400);
  const injected = await (await post(envelope('get_caller', { phone: '+436641234568' }))).json();
  assert.match(injected.results[0].error, /Unexpected/);
  assert.equal(injected.results[0].result, undefined);
  assert.equal(seen.length, 0);
});

test('Vapi errors are flat, sanitized, correlated, and do not prevent later tools in a batch', async t => {
  const { post, envelope } = await fixture(t);
  const body = envelope('search_locations', '{invalid', 'first');
  body.message.toolCallList.push({ id: 'second', function: { name: 'get_caller', arguments: {} } });
  const response = await (await post(body)).json();
  assert.match(response.results[0].error, /Invalid JSON/);
  assert.equal(typeof response.results[1].result, 'string');
  const unknown = envelope('get_caller', {});
  unknown.message.call.id = 'ambiguous-call';
  unknown.message.call.customer.number = '+436640000000';
  const error = (await (await post(unknown)).json()).results[0].error;
  assert.match(error, /AMBIGUOUS_CALLER/);
  assert.ok(!error.includes(secret));
  const duplicate = envelope('get_caller', {}, 'duplicate');
  duplicate.message.toolCallList.push(duplicate.message.toolCallList[0]);
  assert.equal((await post(duplicate)).status, 400);
});

test('web calls require explicit enablement and invalid supplied numbers never fall back', () => {
  const message = { call: { id: 'web-call', type: 'webCall' } };
  assert.throws(() => vapiContext(message), /disabled/);
  assert.deepEqual(vapiContext(message, { allowWebCalls: true }), { callId: 'web-call', callType: 'webCall' });
  message.call.customer = { number: 'invalid' };
  assert.throws(() => vapiContext(message, { allowWebCalls: true }), /valid/);
  assert.throws(() => vapiContext({ call: { id: '../escape', type: 'inboundPhoneCall', customer: { number: phone } } }), /valid/);
});
