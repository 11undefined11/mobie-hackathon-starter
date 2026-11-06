import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

test('connection form checks the caller with local credentials and supports explicit web tests', async () => {
  const elements = Object.fromEntries(['api-key', 'caller-phone', 'web-test', 'message', 'connection-form'].map(id => [id, {
    value: '', checked: false, required: false, disabled: false, textContent: '',
    listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
  }]));
  const requests = [];
  let status = 200;
  runInNewContext(readFileSync(new URL('../src/page.js', import.meta.url), 'utf8'), {
    document: { querySelector: selector => elements[selector.slice(1)] },
    crypto: { randomUUID },
    fetch: async (path, options) => {
      requests.push({ path, headers: options.headers });
      return Response.json(status === 200 ? { userId: 'user-1', firstName: 'Test' } : { error: 'mobie API returned HTTP 409.', code: 'AMBIGUOUS_CALLER' }, { status });
    },
  });
  elements['api-key'].value = 'local-starter-key';
  elements['caller-phone'].value = '+436641234567';
  const submit = () => elements['connection-form'].listeners.submit({ preventDefault() {} });
  await submit();
  assert.equal(requests[0].path, '/api/caller');
  assert.equal(requests[0].headers.Authorization, 'Bearer local-starter-key');
  assert.equal(requests[0].headers['X-Mobie-Caller-Phone'], '+436641234567');
  assert.match(elements.message.textContent, /Test.*user-1/);
  elements['web-test'].checked = true;
  elements['web-test'].listeners.change();
  assert.equal(elements['caller-phone'].disabled, true);
  assert.equal(elements['caller-phone'].required, false);
  await submit();
  assert.equal(requests[1].headers['X-Mobie-Call-Type'], 'webCall');
  assert.equal(requests[1].headers['X-Mobie-Caller-Phone'], undefined);
  assert.notEqual(requests[1].headers['X-Mobie-Call-Id'], requests[0].headers['X-Mobie-Call-Id']);
  status = 409;
  await submit();
  assert.match(elements.message.textContent, /AMBIGUOUS_CALLER/);
  elements['web-test'].checked = false;
  elements['web-test'].listeners.change();
  assert.equal(elements['caller-phone'].required, true);
});
