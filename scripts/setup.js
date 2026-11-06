import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const path = new URL('../.env', import.meta.url);
let existing = '';
try { existing = readFileSync(path, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// Remove obsolete identity-provider settings while preserving team/provider credentials.
let updated = (existing || template).split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?AUTH0_[A-Z_]+\s*=/.test(line)).join('\n');
for (const line of template.split(/\r?\n/)) {
  const entry = /^([A-Z_]+)=(.*)$/.exec(line);
  if (!entry) continue;
  const [, name, defaultValue] = entry;
  const setting = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, 'm');
  const current = updated.match(setting);
  if (name === 'STARTER_API_KEY' && (!current || /^\s*(?:export\s+)?STARTER_API_KEY\s*=\s*(?:["']{2})?\s*$/.test(current[0]))) {
    const generated = `STARTER_API_KEY=${randomBytes(32).toString('base64url')}`;
    updated = current ? updated.replace(setting, generated) : `${updated.trimEnd()}\n${generated}\n`;
  } else if (!current) {
    updated = `${updated.trimEnd()}\n${name}=${defaultValue}\n`;
  }
}
updated = updated.trimStart().trimEnd() + '\n';
if (updated !== existing) {
  const temporary = new URL(`../.env.setup-${randomBytes(8).toString('hex')}`, import.meta.url);
  writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  console.log('Updated .env; existing non-obsolete values were preserved.');
}
console.log('Set the organizer-issued VOICE_INTEGRATION_SECRET in .env. Then npm start; no browser sign-in is required.');
