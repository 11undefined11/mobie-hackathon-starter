import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';

// Local checks only: no provider calls, staging requests, bookings or key output.
export function checkDeployment({ env = process.env, version = process.versions.node } = {}) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const major = Number(version.split('.')[0]);
  add('Node runtime', major >= 22 ? (major === 24 ? 'PASS' : 'WARN') : 'FAIL',
    major === 24 ? 'Node 24 LTS is active.' : major >= 22 ? 'Node 22+ is available; use Node 24 LTS for the recommended deployment.' : 'Node 22 or newer is required.');
  try {
    loadConfig(env);
    add('Server configuration', 'PASS', 'Required credentials and staging configuration are valid locally. Upstream access is not verified.');
  } catch {
    // Do not echo environment values or parser errors that might embed them.
    add('Server configuration', 'FAIL', 'Check STARTER_API_KEY, VOICE_INTEGRATION_SECRET, MOBIE_API_URL, PORT and VOICE_ALLOW_WEB_CALLS against .env.example.');
  }
  const directory = env.VOICE_SESSION_DIRECTORY || fileURLToPath(new URL('../.local/voice-sessions', import.meta.url));
  let temporary;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `.readiness-${randomUUID()}.tmp`);
    const marker = randomUUID();
    writeFileSync(temporary, marker, { flag: 'wx', mode: 0o600, flush: true });
    if (readFileSync(temporary, 'utf8') !== marker) throw new Error('Readback mismatch');
    unlinkSync(temporary);
    temporary = undefined;
    add('Session storage', 'PASS', 'Private probe was written, read and removed without changing saved calls.');
  } catch {
    add('Session storage', 'FAIL', 'Session storage is unavailable. Check the state volume and its permissions before starting.');
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Report storage failure without exposing the path. */ } }
  }
  add('Volume persistence', 'WARN', 'Confirm the session directory survives redeployment and only one server process owns it. This local probe cannot establish either.');
  add('Location access', env.MAPBOX_ACCESS_TOKEN?.trim() ? 'PASS' : 'WARN',
    env.MAPBOX_ACCESS_TOKEN?.trim() ? 'A Mapbox token is present; eligibility and upstream access are not verified.' : 'Configure Mapbox or the collaborator\'s replacement location service before live testing.');
  add('Phone and HTTPS', 'WARN', 'Live Vapi authentication, public HTTPS, caller registration and final-report delivery require a separate live test.');
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checks = checkDeployment();
  for (const check of checks) console.log(`${check.status} ${check.name}: ${check.message}`);
  process.exitCode = checks.some(check => check.status === 'FAIL') ? 1 : 0;
}
