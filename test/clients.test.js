import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobieClient } from '../src/mobie.js';
import { createMapboxClient } from '../src/mapbox.js';

const ride = {
  departure: { publicName: 'Start', latitude: 48.2, longitude: 16.3 },
  destination: { publicName: 'End', latitude: 48.3, longitude: 16.4 },
  time: '2030-10-20T09:00:00+02:00', seatsRequested: 1,
};
const context = { phone: '+436641234567', callId: 'provider-call-1', idempotencyKey: 'confirmed-action-1' };

test('voice search sends the team secret, trusted caller and numeric coordinates', async () => {
  const client = createMobieClient({ baseUrl: 'https://staging.example/', secret: 'team-secret', fetch: async (url, options) => {
    assert.equal(url, 'https://staging.example/integrations/voice/rides/search');
    assert.equal(options.headers.Authorization, 'Bearer team-secret');
    assert.equal(options.headers['X-Mobie-Caller-Phone'], context.phone);
    assert.equal(options.headers['X-Mobie-Call-Id'], context.callId);
    assert.deepEqual(JSON.parse(options.body), ride);
    assert.equal(options.headers['Idempotency-Key'], undefined);
    assert.equal(options.redirect, 'error');
    return Response.json([{ ride: { id: 'ride-1' } }]);
  } });
  assert.deepEqual(await client.searchRides({ ...ride, departure: { ...ride.departure, longitude: '16.3', latitude: '48.2' }, seatsRequested: '1' }, context), [{ ride: { id: 'ride-1' } }]);
});

test('invalid payloads cannot make upstream calls, including location IDs without coordinates/names', async () => {
  const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'team-secret', fetch: async () => assert.fail('Invalid payload went upstream') });
  for (const payload of [
    { ...ride, departure: { id: 'provider-id' } },
    { ...ride, departure: { latitude: 48.2, longitude: 16.3 } },
    { ...ride, departure: { ...ride.departure, publicName: ' ' } },
    { ...ride, departure: { ...ride.departure, publicName: 'a'.repeat(501) } },
    { ...ride, departure: { ...ride.departure, latitude: '48,2' } },
    { ...ride, departure: { ...ride.departure, latitude: '' } },
    { ...ride, destination: { ...ride.destination, longitude: '0x10' } },
    { ...ride, destination: { ...ride.destination, latitude: 100 } },
    { ...ride, seatsRequested: 0 }, { ...ride, seatsRequested: '1.5' },
    { ...ride, time: 'tomorrow' }, { ...ride, time: '2030-10-20T09:00:00' },
  ]) await assert.rejects(client.searchRides(payload, context), error => error.status === 400);
});

test('caller metadata is mandatory; invalid phone numbers never fall back to web tests', async () => {
  const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'team-secret', fetch: async () => assert.fail('Invalid caller went upstream') });
  for (const value of [undefined, {}, { ...context, callId: '' }, { ...context, callId: 'bad/id' },
    { ...context, callId: 'a'.repeat(129) }, { ...context, phone: '' },
    { ...context, phone: '+012345678' }, { ...context, phone: 'private', callType: 'webCall' },
    { ...context, phone: '+4366412345678901', callType: 'webCall' }]) {
    await assert.rejects(client.caller(value), error => error.status === 400);
  }
});

test('explicit webCall omits the phone; a supplied valid phone takes precedence', async () => {
  const sent = [];
  const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'team-secret', fetch: async (_url, options) => { sent.push(options.headers); return Response.json({ userId: 'configured-user' }); } });
  await client.caller({ callId: 'web-call', callType: 'webCall' });
  assert.equal(sent[0]['X-Mobie-Call-Type'], 'webCall');
  assert.equal(sent[0]['X-Mobie-Caller-Phone'], undefined);
  await client.caller({ ...context, callType: 'webCall' });
  assert.equal(sent[1]['X-Mobie-Caller-Phone'], context.phone);
  assert.equal(sent[1]['X-Mobie-Call-Type'], undefined);
});

test('all writes require boolean consent and a stable valid key, which reaches mobie unchanged', async () => {
  const sent = [];
  const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'team-secret', fetch: async (url, options) => { sent.push({ url, options }); return Response.json({ status: 'PENDING' }); } });
  const actions = [
    (body, ctx) => client.joinRide('ride-1', { ...ride, ...body }, ctx),
    (body, ctx) => client.createRequest({ ...ride, ...body }, ctx),
    (body, ctx) => client.withdrawRequest('request-1', body, ctx),
    (body, ctx) => client.cancelBooking('ride-1', 'booking-1', body, ctx),
  ];
  for (const action of actions) {
    for (const confirmed of [undefined, false, 'true']) await assert.rejects(action({ confirmed }, context), error => error.status === 400);
    for (const idempotencyKey of [undefined, '', 'bad key', 'x'.repeat(129)]) await assert.rejects(action({ confirmed: true }, { ...context, idempotencyKey }), error => error.status === 400);
  }
  assert.equal(sent.length, 0);
  for (const action of actions) await action({ confirmed: true }, context);
  assert.equal(sent.length, 4);
  for (const { options } of sent) {
    assert.equal(options.headers['Idempotency-Key'], context.idempotencyKey);
    assert.equal(JSON.parse(options.body).confirmed, true);
  }
  assert.deepEqual(JSON.parse(sent[0].options.body), { ...ride, confirmed: true });
});

test('upstream failures preserve status and approved codes without secrets or automatic write retries', async () => {
  for (const status of [401, 404, 409, 429, 503]) {
    let calls = 0;
    const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'private-team-secret', fetch: async () => {
      calls++;
      return Response.json({ code: 'AMBIGUOUS_CALLER', message: 'private-team-secret', extra: 'private-data' }, { status });
    } });
    await assert.rejects(client.joinRide('ride-1', { ...ride, confirmed: true }, context), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'AMBIGUOUS_CALLER');
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
  }
  for (const response of [() => { throw new Error('network secret'); }, () => new Response('not JSON'), () => Response.json({ code: 'private-secret' }, { status: 403 })]) {
    const client = createMobieClient({ baseUrl: 'https://staging.example', secret: 'team-secret', fetch: response });
    await assert.rejects(client.caller(context), error => { assert.doesNotMatch(JSON.stringify(error) + error.message, /private-secret|network secret/); return true; });
  }
});

test('Mapbox results map longitude and latitude correctly without leaking provider IDs into mobie IDs', async () => {
  const client = createMapboxClient({ token: 'mapbox-secret', fetch: async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/search/geocode/v6/forward');
    assert.equal(parsed.searchParams.get('permanent'), 'true');
    assert.equal(parsed.searchParams.get('country'), 'AT');
    assert.equal(parsed.searchParams.get('q'), 'Wien Hauptstraße');
    return Response.json({ features: [{ id: 'mapbox.fake', geometry: { coordinates: [16.3, 48.2] }, properties: { name: 'Hauptstraße', full_address: 'Hauptstraße, Wien', coordinates: { longitude: 16.3, latitude: 48.2 } } }], attribution: 'Mapbox' });
  } });
  const result = await client.searchLocations('Wien Hauptstraße');
  assert.deepEqual(result, { candidates: [{ publicName: 'Hauptstraße', addressLine: 'Hauptstraße, Wien', longitude: 16.3, latitude: 48.2 }], attribution: 'Mapbox' });
  await assert.rejects(client.searchLocations(''), error => error.status === 400);
});
