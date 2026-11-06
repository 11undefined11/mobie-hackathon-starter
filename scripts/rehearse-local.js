import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from '../src/server.js';

// All services are local, isolated fixtures. No .env or live credential is read.
export async function rehearseLocal() {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'mobie-rehearsal-'));
  const servers = [];
  const apiKey = randomUUID();
  const teamSecret = randomUUID();
  const receipts = new Map(), attempts = [], toolLogs = new Map(), reports = new Map();
  const expectedTools = new Set(), backendErrors = [];
  async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  try {
    const backend = httpServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        assert.equal(req.headers.authorization, `Bearer ${teamSecret}`);
        const log = /^\/integrations\/voice-log\/calls\/([^/]+)(?:\/tools\/([^/]+))?$/.exec(req.url);
        if (log) {
          if (log[2]) toolLogs.set(`${log[1]}/${log[2]}`, body);
          else reports.set(log[1], body);
          res.writeHead(204); res.end(); return;
        }
        const callId = req.headers['x-mobie-call-id'];
        assert.match(callId, /^rehearsal-(confirmed|declined|retry)$/);
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/caller')) return res.end(JSON.stringify({ userId: callId, firstName: 'Lokaler Test', savedPlaces: [] }));
        if (req.url.endsWith('/rides/search')) return res.end(JSON.stringify([{ ride: { id: 'synthetic-ride', priceText: '4 Euro' } }]));
        if (req.url.endsWith('/join-detailed')) {
          const key = req.headers['idempotency-key'];
          assert.ok(key); assert.equal(body.confirmed, true);
          attempts.push({ callId, key, body });
          if (!receipts.has(key)) receipts.set(key, { callId, request: { rideRequest: { id: `synthetic-${callId}`, status: 'PENDING' } } });
          assert.equal(receipts.get(key).callId, callId);
          if (callId === 'rehearsal-retry' && attempts.filter(item => item.callId === callId).length === 1) {
            // Persist the fake backend effect, then lose the response.
            res.destroy(); return;
          }
          return res.end(JSON.stringify(receipts.get(key).request));
        }
        if (req.url === '/integrations/voice/bookings?page=0') return res.end(JSON.stringify({ bookings: [], nextPage: 1 }));
        if (req.url === '/integrations/voice/bookings?page=1') return res.end(JSON.stringify({ bookings: [{ id: 'synthetic-booking', status: 'APPROVED' }], nextPage: null }));
        throw new Error('Unexpected local backend route');
      } catch (error) {
        backendErrors.push(error.message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    const baseUrl = await listen(backend);
    const starter = createServer({ apiKey, secret: teamSecret, baseUrl, sessionDirectory: join(directory, 'sessions') }, {
      mapbox: { searchLocations: async query => ({ attribution: 'Synthetic local test data', candidates: [{
        publicName: query, addressLine: `${query}, Testort`, longitude: 16, latitude: 48,
      }] }) },
    });
    const origin = await listen(starter);
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const time = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    for (const [scenarioIndex, scenario] of ['confirmed', 'declined', 'retry'].entries()) {
      const callId = `rehearsal-${scenario}`;
      const call = { id: callId, type: 'inboundPhoneCall', customer: { number: `+43664000000${scenarioIndex + 1}` } };
      const messages = [{ role: 'user', message: 'Ich möchte eine Testfahrt anfragen.' }];
      async function invoke(name, args = {}) {
        const id = randomUUID();
        expectedTools.add(`${callId}/${id}`);
        const tool = { id, type: 'function', function: { name, arguments: args } };
        const response = await fetch(`${origin}/vapi/tools`, { method: 'POST', headers,
          body: JSON.stringify({ message: { type: 'tool-calls', call, artifact: { messages }, toolCallList: [tool] } }),
        });
        assert.equal(response.status, 200);
        const item = (await response.json()).results[0];
        messages.push({ role: 'tool_calls', toolCalls: [tool] }, { role: 'tool_call_result', toolCallId: id, result: item.result ?? JSON.stringify({ error: item.error }) });
        return item.error ? { error: item.error } : JSON.parse(item.result);
      }
      await invoke('get_caller_profile');
      for (const [slot, query] of [['departure', 'Teststart 1'], ['destination', 'Testziel 2']]) {
        const found = await invoke('find_location', { slot, query });
        const candidate = found.candidates[0];
        messages.push({ role: 'bot', message: `${candidate.addressLine}. Ist das richtig?` }, { role: 'user', message: 'Ja.' });
        const confirmed = await invoke('confirm_location', { slot, candidateId: candidate.candidateId });
        assert.ok(confirmed.confirmedLocation);
      }
      const found = await invoke('search_rides', { time, seatsRequested: 1 });
      const prepared = await invoke('prepare_booking', { rideId: found.suggestions[0].ride.id });
      assert.ok(prepared.summary);
      messages.push({ role: 'bot', message: prepared.summary }, { role: 'user', message: scenario === 'declined' ? 'Nein, danke.' : 'Ja, bitte.' });
      const submitted = await invoke('confirm_booking');
      if (scenario === 'declined') assert.ok(submitted.error);
      else if (scenario === 'retry') {
        assert.ok(submitted.error);
        const recovered = await invoke('confirm_booking');
        assert.equal(recovered.request.rideRequest.status, 'PENDING');
      } else assert.equal(submitted.request.rideRequest.status, 'PENDING');
      if (scenario !== 'declined') {
        const replay = await invoke('confirm_booking');
        assert.equal(replay.request.rideRequest.status, 'PENDING');
        const status = await invoke('get_booking_status');
        assert.equal(status.bookings[0].status, 'APPROVED');
      }
      const final = await fetch(`${origin}/vapi/events`, { method: 'POST', headers, body: JSON.stringify({ message: {
        type: 'end-of-call-report', call, artifact: {
          messages, transcript: messages.filter(item => ['bot', 'user'].includes(item.role)).map(item => `${item.role}: ${item.message}`).join('\n'),
        },
      } }) });
      assert.equal(final.status, 200);
    }
    const deadline = Date.now() + 3_000;
    while ([...expectedTools].some(id => !toolLogs.has(id)) && Date.now() < deadline) await pause(20);
    assert.equal(backendErrors.length, 0);
    assert.equal(receipts.size, 2);
    assert.equal(attempts.filter(item => item.callId === 'rehearsal-confirmed').length, 1);
    assert.equal(attempts.filter(item => item.callId === 'rehearsal-declined').length, 0);
    const retries = attempts.filter(item => item.callId === 'rehearsal-retry');
    assert.equal(retries.length, 2); assert.deepEqual(retries[0], retries[1]);
    assert.equal(toolLogs.size, expectedTools.size);
    assert.equal(reports.size, 3);
    for (const report of reports.values()) {
      assert.equal(report.reportReceived, true);
      assert.ok(report.call.transcript);
      assert.ok(report.messages.length); assert.ok(report.toolCalls.length);
    }
    return {
      mode: 'local-synthetic-rehearsal', generatedAt: new Date().toISOString(),
      checks: [
        { name: 'Explicit consent creates one pending request', passed: true },
        { name: 'Refusal creates no request', passed: true },
        { name: 'Lost response retries the same action without duplicating the stored request', passed: true },
        { name: 'Current status follows empty intermediate pages', passed: true },
        { name: 'All final transcripts and correlated tool events reach the local backend', passed: true },
      ],
      calls: reports.size, storedRequests: receipts.size, bookingAttempts: attempts.length,
      toolEvents: toolLogs.size, liveAccessVerified: false,
    };
  } finally {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    if (!directory.startsWith(temporaryRoot + sep)) throw new Error('Unexpected temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--report')) throw new Error('Use --report PATH or no arguments.');
    const reportPath = args[1] ? resolve(args[1]) : fileURLToPath(new URL('../.local/rehearsal-report.json', import.meta.url));
    const report = await rehearseLocal();
    mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    for (const check of report.checks) console.log(`PASS ${check.name}`);
    console.log('Local synthetic rehearsal complete. No staging or provider services were used.');
    console.log(`Aggregate report: ${reportPath}`);
  } catch (error) {
    console.error(`Local rehearsal failed: ${error.message}`);
    process.exitCode = 1;
  }
}
