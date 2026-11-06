import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { callerHeaders } from '../src/mobie.js';

try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run example:search -- ./my-search.json\nCopy examples/search.json and set a future time and coordinates matching staging rides.');
  const body = JSON.parse(await readFile(file, 'utf8'));
  const caller = callerHeaders({ phone: process.env.MOBIE_CALLER_PHONE, callType: process.env.MOBIE_CALL_TYPE, callId: `example-${randomUUID()}` });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/rides/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STARTER_API_KEY}`, ...caller, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
