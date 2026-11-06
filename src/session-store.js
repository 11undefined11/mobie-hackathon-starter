import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';

// One server process owns this directory. Atomic replacement preserves the last
// complete state across restarts; the volume must survive deployment restarts.
export function createSessionStore(directory) {
  const root = resolve(directory);
  const queues = new Map();
  function path(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'Invalid call ID.');
    return join(root, `${id}.json`);
  }
  return {
    read(id) {
      try { return JSON.parse(readFileSync(path(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
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
