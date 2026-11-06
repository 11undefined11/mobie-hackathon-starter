import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('local rehearsal runs without live credentials and reports consent, recovery and full call history', t => {
  const root = resolve(tmpdir());
  const directory = mkdtempSync(join(root, 'mobie-rehearsal-test-'));
  t.after(() => {
    assert.ok(directory.startsWith(root + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const reportPath = join(directory, 'report.json');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/rehearse-local.js', import.meta.url)), '--report', reportPath], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, VOICE_INTEGRATION_SECRET: '', MAPBOX_ACCESS_TOKEN: '', MOBIE_API_URL: 'https://must-not-contact.invalid' },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.mode, 'local-synthetic-rehearsal');
  assert.equal(report.liveAccessVerified, false);
  assert.equal(report.storedRequests, 2);
  assert.equal(report.bookingAttempts, 3);
  assert.equal(report.calls, 3);
  assert.ok(report.toolEvents >= 24);
  assert.equal(report.checks.length, 5);
  assert.ok(report.checks.every(check => check.passed));
  assert.match(child.stdout, /No staging or provider services were used/);
});
