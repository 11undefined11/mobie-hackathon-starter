const key = document.querySelector('#api-key');
const phone = document.querySelector('#caller-phone');
const webTest = document.querySelector('#web-test');
const message = document.querySelector('#message');
webTest.addEventListener('change', () => {
  phone.disabled = webTest.checked;
  phone.required = !webTest.checked;
});
document.querySelector('#connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = 'Verbindung wird geprüft …';
  try {
    const response = await fetch('/api/caller', {
      headers: {
        Authorization: `Bearer ${key.value}`,
        'X-Mobie-Call-Id': `browser-${crypto.randomUUID()}`,
        ...(webTest.checked ? { 'X-Mobie-Call-Type': 'webCall' } : { 'X-Mobie-Caller-Phone': phone.value.trim() }),
      },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${data.error ?? 'Anfrage fehlgeschlagen.'}${data.code ? ` (${data.code})` : ''}`);
    message.textContent = `Mit mobie verbunden: ${data.firstName ?? 'Test-Mitfahrer'} (${data.userId}).`;
  } catch (error) { message.textContent = error.message; }
});
