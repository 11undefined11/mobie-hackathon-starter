import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDeployment } from '../scripts/check-deployment.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mobie-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { VOICE_SESSION_DIRECTORY: directory, STARTER_API_KEY: 'local-test-secret-with-at-least-32-characters', VOICE_INTEGRATION_SECRET: 'team-test-secret-with-at-least-32-characters' };
  return { directory, env };
}

test('deployment checks leave existing calls intact and expose no credential values', t => {
  const { directory, env } = fixture(t);
  writeFileSync(join(directory, 'existing.json'), 'private saved action');
  const checks = checkDeployment({ env, version: '24.0.0' });
  assert.ok(!checks.some(check => check.status === 'FAIL'));
  assert.deepEqual(readdirSync(directory), ['existing.json']);
  assert.equal(readFileSync(join(directory, 'existing.json'), 'utf8'), 'private saved action');
  const output = JSON.stringify(checks);
  assert.ok(!output.includes(env.STARTER_API_KEY));
  assert.ok(!output.includes(env.VOICE_INTEGRATION_SECRET));
  assert.ok(!output.includes(directory));
  assert.equal(checks.find(check => check.name === 'Volume persistence').status, 'WARN');
});

test('missing credentials, unsupported runtime and unavailable storage block readiness', t => {
  const { directory } = fixture(t);
  const file = join(directory, 'not-a-directory');
  writeFileSync(file, 'existing file');
  const checks = checkDeployment({ env: { VOICE_SESSION_DIRECTORY: file }, version: '20.0.0' });
  assert.deepEqual(checks.filter(check => check.status === 'FAIL').map(check => check.name), ['Node runtime', 'Server configuration', 'Session storage']);
  assert.equal(readFileSync(file, 'utf8'), 'existing file');
});

test('invalid origins are rejected without echoing credentials embedded in URLs', t => {
  const { env } = fixture(t);
  env.MOBIE_API_URL = 'https://private-user:private-password@staging.example';
  const output = JSON.stringify(checkDeployment({ env, version: '24.0.0' }));
  assert.match(output, /FAIL/);
  assert.ok(!output.includes('private-password'));
});
