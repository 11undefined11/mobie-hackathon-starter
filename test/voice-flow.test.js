import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSessionStore } from '../src/session-store.js';
import { createVoiceFlow } from '../src/voice-flow.js';
import { HttpError } from '../src/http.js';
import { spawnSync } from 'node:child_process';

const context = { callId: 'call-a', phone: '+436641234567' };
const location = { publicName: 'Stephansplatz', addressLine: '1010 Wien', longitude: 16.37, latitude: 48.2 };
const time = '2099-01-01T12:00:00+01:00';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-flow-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writes = [];
  const mobie = {
    caller: async c => ({ userId: c.phone }),
    searchRides: async () => [{ ride: { id: 'ride-1' }, price: null }],
    joinRide: async (id, payload, c) => { writes.push({ id, payload, context: c }); return { rideRequest: { id: 'request-1', status: 'PENDING' } }; },
    bookings: async () => ({ bookings: [], nextPage: null }),
    ...overrides,
  };
  const build = () => createVoiceFlow({ mobie, locations: { searchLocations: async () => ({ candidates: [location], attribution: 'Test source' }) }, store: createSessionStore(directory) });
  const flow = build();
  const run = (name, args = {}, c = context, id = randomUUID()) => flow.execute(c, id, name, args);
  return { run, flow, build, writes, directory };
}

async function search(run, c = context, extra = {}) {
  const found = await run('search_locations', { query: 'Stephansplatz Wien' }, c);
  const id = found.candidates[0].id;
  return run('search_rides', { departureId: id, destinationId: id, time, seatsRequested: 2, locationsConfirmed: true, ...extra }, c);
}
async function summary(run, c = context) {
  await search(run, c);
  return run('select_ride', { rideId: 'ride-1' }, c);
}

test('only resolved candidates and a future confirmed trip can reach ride search', async t => {
  const { run } = fixture(t);
  await assert.rejects(run('search_rides', { departureId: 'invented', destinationId: 'invented', time, locationsConfirmed: true }), /candidate IDs/);
  await assert.rejects(search(run, context, { locationsConfirmed: false }), /Confirm both/);
  await assert.rejects(search(run, context, { time: '2020-01-01T00:00:00Z' }), /future/);
  await assert.rejects(search(run, context, { seatsRequested: 9 }), /1 to 8/);
  await assert.rejects(search(run, context, { time: '2099-01-01T12:00:00' }), /offset/);
  const result = await search(run);
  assert.equal(result.trip.seatsRequested, 2);
  assert.deepEqual(result.trip.departure, location);
  await assert.rejects(run('select_ride', { rideId: 'unreturned-ride' }), /latest search/);
});

test('refusal, stale summary and argument injection cannot submit a booking', async t => {
  const { run, writes } = fixture(t);
  const selected = await summary(run);
  await assert.rejects(run('book_ride', { summaryId: selected.summaryId, confirmed: 'yes' }), /boolean/);
  await assert.rejects(run('book_ride', { summaryId: selected.summaryId, confirmed: true, phone: '+436649999999' }), /Unexpected/);
  await run('book_ride', { summaryId: selected.summaryId, confirmed: false });
  await assert.rejects(run('book_ride', { summaryId: selected.summaryId, confirmed: true }), /outdated/);
  const next = await summary(run);
  await search(run);
  await assert.rejects(run('book_ride', { summaryId: next.summaryId, confirmed: true }), /outdated/);
  assert.equal(writes.length, 0);
});

test('concurrent repeated confirmations submit once and retain passenger coordinates', async t => {
  const { run, writes } = fixture(t);
  const selected = await summary(run);
  const args = { summaryId: selected.summaryId, confirmed: true };
  const results = await Promise.all([run('book_ride', args), run('book_ride', args)]);
  assert.equal(writes.length, 1);
  assert.equal(results[0].requiresDriverApproval, true);
  assert.deepEqual(writes[0].payload.departure, location);
  assert.equal(writes[0].payload.confirmed, true);
  assert.match(writes[0].context.idempotencyKey, /^[a-f0-9-]+$/);
});

test('a lost response survives restart and reuses the exact durable booking action', async t => {
  const attempts = [];
  let first = true;
  const { run, build } = fixture(t, { joinRide: async (id, payload, c) => {
    attempts.push({ id, payload, key: c.idempotencyKey });
    if (first) { first = false; throw new HttpError(502, 'Lost response'); }
    return { rideRequest: { id: 'request-1' } };
  } });
  const selected = await summary(run);
  const args = { summaryId: selected.summaryId, confirmed: true };
  await assert.rejects(run('book_ride', args, context, 'booking-tool'), /Lost response/);
  await assert.rejects(run('select_ride', { rideId: 'ride-1' }), /unresolved/);
  await assert.rejects(search(run), /unresolved/);
  const restarted = build();
  await assert.rejects(restarted.execute({ ...context, phone: '+436641234568' }, 'booking-tool', 'book_ride', args), /another caller/);
  const result = await restarted.execute(context, 'booking-tool', 'book_ride', args);
  assert.equal(result.submitted, true);
  assert.deepEqual(attempts[0], attempts[1]);
  await build().execute(context, 'another-tool', 'book_ride', args);
  assert.equal(attempts.length, 2);
});

test('two simultaneous callers cannot share candidates, summaries or identity', async t => {
  const { run, writes } = fixture(t);
  const other = { callId: 'call-b', phone: '+436641234568' };
  const [a, b] = await Promise.all([summary(run), summary(run, other)]);
  await assert.rejects(run('book_ride', { summaryId: a.summaryId, confirmed: true }, other), /outdated/);
  await Promise.all([run('book_ride', { summaryId: a.summaryId, confirmed: true }), run('book_ride', { summaryId: b.summaryId, confirmed: true }, other)]);
  assert.deepEqual(new Set(writes.map(w => w.context.phone)), new Set([context.phone, other.phone]));
  assert.notEqual(writes[0].context.idempotencyKey, writes[1].context.idempotencyKey);
});

test('tool replays preserve results, reject changed input and handle special property names safely', async t => {
  const { run } = fixture(t);
  const first = await run('search_locations', { query: 'Wien' }, context, '__proto__');
  assert.deepEqual(await run('search_locations', { query: 'Wien' }, context, '__proto__'), first);
  await assert.rejects(run('search_locations', { query: 'Linz' }, context, '__proto__'), /reused/);
  await assert.rejects(run('get_caller', { callId: 'other' }), /Unexpected/);
});

test('booking status follows empty pages and remains live across tool replays', async t => {
  const pages = [];
  let state = 'PENDING';
  const { run } = fixture(t, { bookings: async page => {
    pages.push(page);
    return page === 0 ? { bookings: [], nextPage: 1 } : { bookings: [{ status: state }], nextPage: null };
  } });
  assert.equal((await run('get_booking_status', {}, context, 'status')).bookings[0].status, 'PENDING');
  state = 'APPROVED';
  assert.equal((await run('get_booking_status', {}, context, 'status')).bookings[0].status, 'APPROVED');
  assert.deepEqual(pages, [0, 1, 0, 1]);
});

test('a definitive booking rejection permits a new trip without misreporting success', async t => {
  const { run } = fixture(t, { joinRide: async () => { throw new HttpError(409, 'Ride no longer available'); } });
  const selected = await summary(run);
  const args = { summaryId: selected.summaryId, confirmed: true };
  await assert.rejects(run('book_ride', args), /no longer available/);
  await assert.rejects(run('book_ride', args), /no longer available/);
  await search(run);
});

test('a failed durable save prevents the booking from reaching the backend', async t => {
  const { run, directory, writes } = fixture(t);
  const selected = await summary(run);
  const store = createSessionStore(directory);
  const save = store.save;
  store.save = state => {
    if (state.action) throw new Error('Disk unavailable');
    save(state);
  };
  const flow = createVoiceFlow({
    store, locations: {},
    mobie: { joinRide: async () => { writes.push('unexpected write'); } },
  });
  await assert.rejects(flow.execute(context, 'failed-save', 'book_ride', { summaryId: selected.summaryId, confirmed: true }), /Disk unavailable/);
  assert.equal(writes.length, 0);
});

test('a failed replacement search invalidates the previous booking summary', async t => {
  let fails = false;
  const { run, writes } = fixture(t, { searchRides: async () => {
    if (fails) throw new HttpError(502, 'Search failed');
    return [{ ride: { id: 'ride-1' } }];
  } });
  const selected = await summary(run);
  fails = true;
  await assert.rejects(search(run), /Search failed/);
  await assert.rejects(run('book_ride', { summaryId: selected.summaryId, confirmed: true }), /outdated/);
  assert.equal(writes.length, 0);
});

test('abrupt process exit after a backend side effect retains the original action on recovery', async t => {
  const { run, directory } = fixture(t);
  const selected = await summary(run);
  const args = { summaryId: selected.summaryId, confirmed: true };
  const receiptPath = join(directory, 'backend-receipt.txt');
  const source = `
    import { writeFileSync } from 'node:fs';
    import { createSessionStore } from ${JSON.stringify(new URL('../src/session-store.js', import.meta.url).href)};
    import { createVoiceFlow } from ${JSON.stringify(new URL('../src/voice-flow.js', import.meta.url).href)};
    const flow = createVoiceFlow({ store: createSessionStore(${JSON.stringify(directory)}), locations: {},
      mobie: { joinRide: async (rideId, payload, context) => {
        writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ rideId, payload, key: context.idempotencyKey }));
        process.exit(42);
      } } });
    await flow.execute(${JSON.stringify(context)}, 'process-crash-tool', 'book_ride', ${JSON.stringify(args)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 42, child.stderr);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const recovered = createVoiceFlow({ store: createSessionStore(directory), locations: {}, mobie: {
    joinRide: async (rideId, payload, c) => {
      assert.deepEqual({ rideId, payload, key: c.idempotencyKey }, receipt);
      return { rideRequest: { id: 'original-request', status: 'PENDING' } };
    },
  } });
  const result = await recovered.execute(context, 'process-crash-tool', 'book_ride', args);
  assert.equal(result.submission.rideRequest.id, 'original-request');
});
