import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer } from '../src/server.js';
import { createBackendCallLog } from '../src/call-log.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const key = 'test-key-with-at-least-32-characters';
const secret = 'private-upstream-team-secret-32-characters';
const noLogs = { recordToolCall: async () => {} };
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Mobie-Caller-Phone': '+436641234567', 'X-Mobie-Call-Id': 'provider-call-1' };
const payload = { departure: { publicName: 'Start', latitude: 48.2, longitude: 16.3 }, destination: { publicName: 'End', latitude: 48.3, longitude: 16.4 }, time: '2030-10-20T09:00:00+02:00', seatsRequested: 1 };

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, { logging = false } = {}) {
  const logs = [];
  const seen = [];
  const receipts = new Map();
  let writes = 0;
  const upstream = httpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (req.url.startsWith('/integrations/voice-log/calls/')) {
      logs.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(204);
      res.end();
      upstream.emit('log');
      return;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    assert.match(req.url, /^\/integrations\/voice\//);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-mobie-caller-phone'] === '+436640000000') {
      res.writeHead(409);
      return res.end(JSON.stringify({ code: 'AMBIGUOUS_CALLER', message: secret }));
    }
    if (req.url.endsWith('/caller')) return res.end(JSON.stringify({ userId: req.headers['x-mobie-caller-phone'] ?? 'web-user', firstName: 'Test', savedPlaces: [] }));
    if (req.url.endsWith('/rides/search')) return res.end(JSON.stringify([{ ride: { id: 'ride-1' } }]));
    if (req.method === 'POST' && req.headers['idempotency-key']) {
      const id = req.headers['idempotency-key'];
      const input = JSON.stringify([req.url, body]);
      if (receipts.has(id) && receipts.get(id) !== input) { res.writeHead(409); return res.end('{}'); }
      if (!receipts.has(id)) { writes++; receipts.set(id, input); }
      return res.end(JSON.stringify({ rideRequest: { id: 'request-1', status: 'PENDING' } }));
    }
    res.end(JSON.stringify({ bookings: [], nextPage: null }));
  });
  const upstreamUrl = await listen(t, upstream);
  const config = { apiKey: key, secret, baseUrl: upstreamUrl, mapboxToken: '' };
  const server = createServer(config, logging ? {} : { calls: noLogs });
  const url = await listen(t, server);
  return { url, server, config, seen, logs, upstream, writes: () => writes };
}

test('real HTTP forwards caller context with the upstream team credential, without a login or shared passenger', async t => {
  const { url, seen } = await fixture(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/caller`)).status, 401);
  assert.equal((await fetch(`${url}/api/caller`, { headers: { ...headers, Authorization: `Bearer ${secret}` } })).status, 401);
  assert.equal(seen.length, 0);
  const callers = ['+436641234567', '+436641234568'];
  const responses = await Promise.all(callers.map(phone => fetch(`${url}/api/caller`, { headers: { ...headers, 'X-Mobie-Caller-Phone': phone, 'X-Mobie-Call-Id': `call-${phone.slice(1)}` } })));
  assert.deepEqual(await Promise.all(responses.map(async response => (await response.json()).userId)), callers);
  assert.deepEqual(new Set(seen.map(request => request.headers['x-mobie-caller-phone'])), new Set(callers));
  const page = await fetch(url);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.doesNotMatch(await page.text(), /private-upstream|Auth0|Sign in/);
});

test('removed login/session/driver routes are unavailable and cannot proxy arbitrary URLs', async t => {
  const { url, seen } = await fixture(t);
  for (const path of ['/auth/login', '/callback?code=unused', '/api/logout', '/api/status', '/api/me', '/api/rides/ride-1', '/api/admin/users', '/api/https://example.com']) {
    assert.equal((await fetch(`${url}${path}`, { headers })).status, 404, path);
    assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers, body: '{}' })).status, 404, path);
  }
  assert.equal(seen.length, 0);
});

test('search and confirmed booking forward a stable action key, including after starter restart', async t => {
  const { url, server, config, seen, writes } = await fixture(t);
  const search = await fetch(`${url}/api/rides/search`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.deepEqual(await search.json(), [{ ride: { id: 'ride-1' } }]);
  for (const body of [payload, { ...payload, confirmed: 'true' }, { ...payload, confirmed: true }]) {
    const response = await fetch(`${url}/api/rides/ride-1/join-detailed`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(writes(), 0);
  const writeHeaders = { ...headers, 'Idempotency-Key': 'confirmed-booking-1' };
  const body = JSON.stringify({ ...payload, confirmed: true, phone: '+436649999999', userId: 'model-picked-user' });
  const book = async origin => {
    const response = await fetch(`${origin}/api/rides/ride-1/join-detailed`, { method: 'POST', headers: writeHeaders, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).rideRequest.status, 'PENDING');
  };
  await book(url);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const restarted = await listen(t, createServer(config, { calls: noLogs }));
  await book(restarted);
  assert.equal(writes(), 1);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[1].body, { ...payload, confirmed: true });
  assert.equal(seen[1].headers['x-mobie-caller-phone'], headers['X-Mobie-Caller-Phone']);
  const changed = await fetch(`${restarted}/api/rides/ride-1/join-detailed`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ ...payload, seatsRequested: 2, confirmed: true }) });
  assert.equal(changed.status, 409);
  assert.equal(writes(), 1);
});

test('all additional voice routes translate to their explicit upstream paths', async t => {
  const { url, seen } = await fixture(t);
  for (const [method, path, body] of [
    ['POST', '/rides/nearby', { departure: payload.departure }],
    ['POST', '/ride-requests', { ...payload, confirmed: true }],
    ['GET', '/ride-requests?openOnly=true'], ['GET', '/ride-requests'],
    ['GET', '/bookings?page=2'], ['GET', '/bookings/booking-1'],
    ['GET', '/rides/ride-1/rider-detail'],
    ['POST', '/ride-requests/request-1/withdraw', { confirmed: true }],
    ['POST', '/rides/ride-1/bookings/booking-1/cancel', { confirmed: true }],
  ]) {
    const response = await fetch(`${url}/api${path}`, { method, headers: { ...headers, 'Idempotency-Key': `action-${seen.length}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, path);
    assert.equal(seen.at(-1).url, `/integrations/voice${path}`);
  }
});

test('caller guards, JSON limits and query validation reject invalid requests before upstream', async t => {
  const { url, seen } = await fixture(t);
  for (const extra of [{ 'X-Mobie-Caller-Phone': '' }, { 'X-Mobie-Call-Id': '' }, { 'X-Mobie-Caller-Phone': 'private', 'X-Mobie-Call-Type': 'webCall' }]) {
    assert.equal((await fetch(`${url}/api/caller`, { headers: { ...headers, ...extra } })).status, 400);
  }
  for (const [body, type, status] of [['{bad', 'application/json', 400], ['{}', 'text/plain', 415], [JSON.stringify({ big: 'x'.repeat(17_000) }), 'application/json', 413], ['[]', 'application/json', 400]]) {
    assert.equal((await fetch(`${url}/api/rides/search`, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body })).status, status);
  }
  for (const path of ['/bookings?page=-1', '/bookings?page=1e2', '/bookings?page=99999999999999999999', '/ride-requests?openOnly=yes']) assert.equal((await fetch(`${url}/api${path}`, { headers })).status, 400);
  assert.equal(seen.length, 0);
  assert.equal((await fetch(`${url}/api/locations/search`, { method: 'POST', headers, body: '{"query":"Wien"}' })).status, 503);
});

test('web tests are explicit, and ambiguous callers preserve only the safe error code', async t => {
  const { url, seen } = await fixture(t);
  const webHeaders = { ...headers, 'X-Mobie-Call-Type': 'webCall' };
  delete webHeaders['X-Mobie-Caller-Phone'];
  const web = await fetch(`${url}/api/caller`, { headers: webHeaders });
  assert.equal((await web.json()).userId, 'web-user');
  assert.equal(seen[0].headers['x-mobie-caller-phone'], undefined);
  const ambiguous = await fetch(`${url}/api/caller`, { headers: { ...headers, 'X-Mobie-Caller-Phone': '+436640000000' } });
  assert.equal(ambiguous.status, 409);
  assert.deepEqual(await ambiguous.json(), { error: 'mobie API returned HTTP 409.', code: 'AMBIGUOUS_CALLER' });
});

test('the shipped example searches the running starter with its configured manual caller', async t => {
  const { url, seen, writes } = await fixture(t);
  const port = new URL(url).port;
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'mobie-example-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'trip.json');
  writeFileSync(file, JSON.stringify(payload));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../examples/search.js', import.meta.url)), file], {
    env: { ...process.env, PORT: port, STARTER_API_KEY: key, MOBIE_CALLER_PHONE: headers['X-Mobie-Caller-Phone'], MOBIE_CALL_TYPE: '' },
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output), [{ ride: { id: 'ride-1' } }]);
  assert.match(seen[0].headers['x-mobie-call-id'], /^example-/);
  assert.equal(seen[0].headers['x-mobie-caller-phone'], headers['X-Mobie-Caller-Phone']);
  assert.equal(writes(), 0);
});

test('API tools push arguments, results, timing and failures under the same team/call IDs', async t => {
  const { url, logs, upstream } = await fixture(t, { logging: true });
  let delivered = once(upstream, 'log', { signal: AbortSignal.timeout(3000) });
  const search = await fetch(`${url}/api/rides/search`, {
    method: 'POST', headers: { ...headers, 'X-Mobie-Tool-Call-Id': 'provider-tool-1' },
    body: JSON.stringify({ ...payload, password: 'do-not-log', secret, apiKey: key }),
  });
  assert.equal(search.status, 200);
  await delivered;
  assert.equal(logs[0].url, '/integrations/voice-log/calls/provider-call-1/tools/provider-tool-1');
  assert.equal(logs[0].method, 'PUT');
  assert.equal(logs[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(logs[0].body.name, 'search_rides');
  assert.deepEqual(logs[0].body.result, [{ ride: { id: 'ride-1' } }]);
  assert.equal(logs[0].body.arguments.password, '[REDACTED]');
  assert.equal(logs[0].body.arguments.apiKey, '[REDACTED]');
  assert.equal(logs[0].body.arguments.secret, '[REDACTED]');
  assert.equal(logs[0].body.ok, true);
  assert.ok(logs[0].body.ms >= 0);
  delivered = once(upstream, 'log', { signal: AbortSignal.timeout(3000) });
  const failure = await fetch(`${url}/api/caller`, { headers: { ...headers, 'X-Mobie-Caller-Phone': '+436640000000' } });
  assert.equal(failure.status, 409);
  await delivered;
  assert.equal(logs[1].body.ok, false);
  assert.equal(logs[1].body.result.code, 'AMBIGUOUS_CALLER');
});

test('authenticated Vapi end reports and normalized reports push transcripts without caller lookup', async t => {
  const { url, logs, seen } = await fixture(t, { logging: true });
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const report = { message: { type: 'end-of-call-report', call: { id: 'vapi-call-1', type: 'webCall' },
    startedAt: '2030-01-01T10:00:00Z', endedAt: '2030-01-01T10:01:00Z',
    artifact: { transcript: 'Hallo!' + 'x'.repeat(20_000), messages: [{ role: 'system', message: 'private prompt' }, { role: 'user', message: 'Hallo!' }] } } };
  assert.equal((await fetch(`${url}/vapi/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })).status, 401);
  assert.equal(logs.length, 0);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await fetch(`${url}/vapi/events`, { method: 'POST', headers: auth, body: JSON.stringify(report) })).status, 200);
  }
  assert.equal(logs[0].url, '/integrations/voice-log/calls/vapi-call-1');
  assert.equal(logs[1].url, logs[0].url);
  assert.equal(logs[0].body.call.transcript, 'Hallo!' + 'x'.repeat(20_000));
  assert.equal(logs[0].body.reportReceived, true);
  assert.equal(logs[0].body.messages.length, 1);
  assert.equal(logs[0].headers['x-mobie-caller-phone'], undefined);
  const normalized = { call: { id: 'other-call-1', transcript: 'Guten Tag!' }, messages: [{ seq: 0, role: 'user', text: 'Guten Tag!' }], reportReceived: true };
  const upload = await fetch(`${url}/api/calls/other-call-1`, { method: 'PUT', headers: auth, body: JSON.stringify(normalized) });
  assert.equal(upload.status, 204);
  assert.equal(logs[2].body.call.transcript, 'Guten Tag!');
  const tool = await fetch(`${url}/api/calls/other-call-1/tools/tool-1`, { method: 'PUT', headers: auth, body: JSON.stringify({ name: 'custom_tool', result: { ok: true } }) });
  assert.equal(tool.status, 204);
  assert.equal(logs[3].url, '/integrations/voice-log/calls/other-call-1/tools/tool-1');
  assert.equal(seen.length, 0);
  assert.equal((await fetch(`${url}/api/calls/other-call-1`, { method: 'PUT', headers: auth, body: JSON.stringify({ call: { id: 'wrong-id' } }) })).status, 400);
});

test('logging failure never changes a submitted booking, while final reports return a retryable error', async t => {
  const errors = [];
  t.mock.method(console, 'error', message => { errors.push(message); });
  let writes = 0;
  const failingLogs = createBackendCallLog({ baseUrl: 'https://unused.example', secret, sleep: async () => {}, fetch: async () => new Response(null, { status: 500 }) });
  const server = createServer({ apiKey: key }, {
    calls: failingLogs,
    mobie: { joinRide: async () => { writes++; return { status: 'PENDING' }; } },
    mapbox: {},
  });
  const url = await listen(t, server);
  const booking = await fetch(`${url}/api/rides/ride-1/join-detailed`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'confirmed-action' }, body: JSON.stringify({ ...payload, confirmed: true }),
  });
  assert.equal(booking.status, 200);
  assert.equal((await booking.json()).status, 'PENDING');
  assert.equal(writes, 1);
  const final = await fetch(`${url}/vapi/events`, { method: 'POST', headers, body: JSON.stringify({ message: { type: 'end-of-call-report', call: { id: 'provider-call-1' } } }) });
  assert.equal(final.status, 503);
  assert.doesNotMatch(await final.text(), new RegExp(secret));
  assert.equal(writes, 1);
  assert.ok(errors.length > 0);
  assert.doesNotMatch(errors.join(' '), new RegExp(secret));
});
