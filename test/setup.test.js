import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';

const key = 'local-server-key-at-least-32-characters';
const secret = 'organizer-team-secret-at-least-32-characters';

test('configuration requires team credentials and rejects production/invalid origins without identity-provider settings', () => {
  const env = { STARTER_API_KEY: key, VOICE_INTEGRATION_SECRET: secret };
  assert.deepEqual(loadConfig(env), { baseUrl: 'https://api-staging.mobie.at', apiKey: key, secret, mapboxToken: '', port: 3000, host: '127.0.0.1' });
  for (const changes of [{ VOICE_INTEGRATION_SECRET: '' }, { VOICE_INTEGRATION_SECRET: 'short' }, { VOICE_INTEGRATION_SECRET: 'x'.repeat(32) + '\nheader' }, { STARTER_API_KEY: 'short' }, { MOBIE_API_URL: 'https://api.mobie.at' }, { MOBIE_API_URL: 'http://staging.example' }, { MOBIE_API_URL: 'https://staging.example/integrations/voice' }, { MOBIE_API_URL: 'https://user:password@staging.example' }, { PORT: '0' }]) assert.throws(() => loadConfig({ ...env, ...changes }));
  assert.equal(loadConfig({ ...env, VOICE_ALLOW_WEB_CALLS: 'true' }).allowWebCalls, true);
  assert.equal(loadConfig({ ...env, VOICE_ALLOW_WEB_CALLS: 'false' }).allowWebCalls, false);
  assert.throws(() => loadConfig({ ...env, VOICE_ALLOW_WEB_CALLS: 'yes' }), /true or false/);
});

test('setup creates or migrates .env, preserves existing keys and is repeatable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-setup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  copyFileSync(new URL('../scripts/setup.js', import.meta.url), join(directory, 'scripts/setup.mjs'));
  copyFileSync(new URL('../.env.example', import.meta.url), join(directory, '.env.example'));
  const run = () => {
    const result = spawnSync(process.execPath, [join(directory, 'scripts/setup.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(`${key}|${secret}`));
    return readFileSync(join(directory, '.env'), 'utf8');
  };
  const fresh = run();
  assert.match(fresh, /^STARTER_API_KEY=[A-Za-z0-9_-]{43}$/m);
  assert.match(fresh, /^VOICE_INTEGRATION_SECRET=$/m);
  // Windows uses ACLs rather than POSIX permission bits.
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
  assert.equal(run(), fresh);
  const old = `AUTH0_DOMAIN=obsolete\r\nexport AUTH0_CLIENT_ID=obsolete\r\nAUTH0_AUDIENCE=obsolete\r\nAUTH0_REDIRECT_URI=obsolete\r\nSTARTER_API_KEY=${key}\r\nVOICE_INTEGRATION_SECRET=${secret}\r\nMAPBOX_ACCESS_TOKEN=keep-mapbox`;
  writeFileSync(join(directory, '.env'), old);
  const migrated = run();
  assert.doesNotMatch(migrated, /AUTH0_|obsolete/);
  assert.match(migrated, new RegExp(`STARTER_API_KEY=${key}`));
  assert.match(migrated, new RegExp(`VOICE_INTEGRATION_SECRET=${secret}`));
  assert.match(migrated, /MAPBOX_ACCESS_TOKEN=keep-mapbox/);
  assert.equal(run(), migrated);
  writeFileSync(join(directory, '.env'), 'STARTER_API_KEY=\n');
  assert.match(run(), /^STARTER_API_KEY=[A-Za-z0-9_-]{43}$/m);
  // Explicitly exercise CRLF even when Git checks out the template with LF.
  const template = readFileSync(join(directory, '.env.example'), 'utf8').replace(/\r?\n/g, '\r\n');
  writeFileSync(join(directory, '.env.example'), template);
  writeFileSync(join(directory, '.env'), 'STARTER_API_KEY=\r\n');
  const windows = run();
  assert.match(windows, /^STARTER_API_KEY=[A-Za-z0-9_-]{43}$/m);
  assert.match(windows, /^MOBIE_API_URL=https:\/\/api-staging.mobie.at$/m);
  assert.equal(run(), windows);
});
