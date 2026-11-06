import { createServer as httpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createMobieClient } from './mobie.js';
import { createMapboxClient } from './mapbox.js';
import { HttpError } from './http.js';
import { loadConfig } from './config.js';

const page = readFileSync(new URL('./index.html', import.meta.url));
const script = readFileSync(new URL('./page.js', import.meta.url));

function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use Content-Type: application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, 'JSON body is too large (maximum 16 KiB).');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object.');
  return value;
}

export function createServer(config, services = {}) {
  const mobie = services.mobie ?? createMobieClient({ baseUrl: config.baseUrl, secret: config.secret });
  const mapbox = services.mapbox ?? createMapboxClient({ token: config.mapboxToken });

  const server = httpServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/page.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(script);
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
      if (!equalSecret(req.headers.authorization, `Bearer ${config.apiKey}`)) throw new HttpError(401, 'Use the STARTER_API_KEY as a Bearer token for this server.');
      // The authenticated provider adapter supplies these from call metadata, never model arguments.
      const context = {
        phone: req.headers['x-mobie-caller-phone'], callId: req.headers['x-mobie-call-id'],
        callType: req.headers['x-mobie-call-type'], idempotencyKey: req.headers['idempotency-key'],
      };
      if (req.method === 'GET' && url.pathname === '/api/caller') return json(200, await mobie.caller(context));
      if (req.method === 'POST' && url.pathname === '/api/locations/search') {
        return json(200, await mapbox.searchLocations((await readJson(req)).query));
      }
      if (req.method === 'POST' && url.pathname === '/api/rides/search') {
        return json(200, await mobie.searchRides(await readJson(req), context));
      }
      if (req.method === 'POST' && url.pathname === '/api/rides/nearby') return json(200, await mobie.nearbyRides(await readJson(req), context));
      if (url.pathname === '/api/ride-requests') {
        if (req.method === 'POST') return json(200, await mobie.createRequest(await readJson(req), context));
        if (req.method === 'GET') {
          const openOnly = url.searchParams.get('openOnly');
          if (openOnly !== null && !['true', 'false'].includes(openOnly)) throw new HttpError(400, 'openOnly must be true or false.');
          return json(200, await mobie.requests(context, openOnly === 'true'));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/bookings') {
        const page = url.searchParams.get('page') ?? '0';
        if (!/^\d+$/.test(page)) throw new HttpError(400, 'page must be a nonnegative integer.');
        return json(200, await mobie.bookings(Number(page), context));
      }
      const booking = /^\/api\/bookings\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
      if (booking && req.method === 'GET') return json(200, await mobie.booking(booking[1], context));
      const withdraw = /^\/api\/ride-requests\/([a-zA-Z0-9_-]{1,128})\/withdraw$/.exec(url.pathname);
      if (withdraw && req.method === 'POST') return json(200, await mobie.withdrawRequest(withdraw[1], await readJson(req), context));
      const cancel = /^\/api\/rides\/([a-zA-Z0-9_-]{1,128})\/bookings\/([a-zA-Z0-9_-]{1,128})\/cancel$/.exec(url.pathname);
      if (cancel && req.method === 'POST') return json(200, await mobie.cancelBooking(cancel[1], cancel[2], await readJson(req), context));
      const ride = /^\/api\/rides\/([a-zA-Z0-9_-]{1,128})\/(join-detailed|rider-detail)$/.exec(url.pathname);
      if (ride && req.method === 'POST' && ride[2] === 'join-detailed') {
        return json(200, await mobie.joinRide(ride[1], await readJson(req), context));
      }
      if (ride && req.method === 'GET' && ride[2] === 'rider-detail') return json(200, await mobie.riderRideDetails(ride[1], context));
      throw new HttpError(404, 'Endpoint not found. See docs/api.md.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : 'Unexpected server error.',
        ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = loadConfig();
    const server = createServer(config);
    server.on('error', error => { console.error(`Cannot start server (${error.code ?? 'unknown error'}).`); process.exitCode = 1; });
    server.listen(config.port, config.host, () => console.log(`mobie starter: http://localhost:${config.port}\nTeam voice access configured. Open the page to verify a staging caller; no browser login is required.`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
