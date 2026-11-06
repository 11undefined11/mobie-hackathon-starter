import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from './http.js';

// One server process owns this directory. Atomic replacement preserves the last
// complete state across restarts; the volume must survive deployment restarts.
export function createSessionStore(directory) {
  const root = resolve(directory);
  const queues = new Map();
  function path(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'Invalid call ID.');
    // Hash names keep case-sensitive call IDs distinct on Windows and avoid
    // reserved device filenames such as CON.json.
    return join(root, `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  return {
    read(id) {
      const target = path(id);
      let raw;
      try { raw = readFileSync(target, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Preserve action keys saved by the previous version. Never accept a
        // different case variant from a case-insensitive legacy filesystem.
        if (process.platform === 'win32' && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(id)) return null;
        try { raw = readFileSync(join(root, `${id}.json`), 'utf8'); }
        catch (legacyError) { if (legacyError.code === 'ENOENT') return null; throw legacyError; }
      }
      const state = JSON.parse(raw);
      if (!state || state.callId !== id) throw new HttpError(503, 'Saved call identity does not match. Restore the correct state before retrying.');
      return state;
    },
    save(state) {
      const target = path(state.callId);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temporary, target);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
    async exclusive(id, operation) {
      path(id);
      const previous = queues.get(id) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(operation);
      queues.set(id, current);
      try { return await current; }
      finally { if (queues.get(id) === current) queues.delete(id); }
    },
  };
}
