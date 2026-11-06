export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Only allow known error codes through; provider bodies/messages can contain secrets.
export async function requestJson(url, options = {}, { fetch = globalThis.fetch, service = 'Upstream', safeCodes = [] } = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, `${service} request failed or timed out. A write may have succeeded; check before retrying.`);
  }
  if (!response.ok) {
    let code;
    if (safeCodes.length) {
      try {
        const body = await response.json();
        if (safeCodes.includes(body?.code)) code = body.code;
      } catch { /* Keep the sanitized status when the upstream body is not JSON. */ }
    }
    throw new HttpError(response.status >= 400 && response.status < 600 ? response.status : 502, `${service} returned HTTP ${response.status}.`, code);
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, `${service} returned an invalid JSON response.`);
  }
}
