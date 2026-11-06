import { setTimeout as pause } from 'node:timers/promises';
import { HttpError } from './http.js';
function callerPhone(source) {
  const message = source?.message ?? source ?? {};
  const call = message.call ?? source?.call ?? message;
  const fromCall = call.customer?.number;
  const fromMessage = message.customer?.number;
  return fromCall && fromMessage && fromCall !== fromMessage ? null : fromCall ?? fromMessage ?? null;
}

const str = value => typeof value === 'string' && value ? value : null;
const num = value => Number.isFinite(value) ? value : null;
const json = value => value === undefined || value === null ? null : JSON.stringify(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const parse = value => {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
};
// What Vapi actually used (it can fall back to another transcriber): "soniox stt-rt-v5".
function component(costs, type, fallback) {
  const c = Array.isArray(costs) ? costs.find(x => x?.type === type) : null;
  const used = c?.[type] ?? fallback;
  if (!used || typeof used !== 'object') return null;
  return [used.provider, used.model ?? used.voiceId].filter(Boolean).join(' ') || null;
}

// The end-of-call report ({ message: { type: 'end-of-call-report', call, artifact, ... } }) and a call object
// from GET /call/{id} carry the same information in slightly different places; normalize both.
export function normalizeCall(source) {
  const m = source?.message ?? source ?? {};
  const call = m.call ?? m;
  const artifact = m.artifact ?? call.artifact ?? {};
  const assistant = m.assistant ?? call.assistant ?? {};
  return {
    id: str(call.id),
    orgId: str(call.orgId),
    assistantId: str(call.assistantId) ?? str(assistant.id),
    assistantVersion: str(m.assistantVersion) ?? str(call.assistantVersion),
    type: str(call.type),
    customerNumber: str(callerPhone(source)),
    startedAt: str(m.startedAt) ?? str(call.startedAt),
    endedAt: str(m.endedAt) ?? str(call.endedAt),
    endedReason: str(m.endedReason) ?? str(call.endedReason),
    transcriber: component(m.costs ?? call.costs, 'transcriber', assistant.transcriber),
    voice: component(m.costs ?? call.costs, 'voice', assistant.voice),
    model: component(m.costs ?? call.costs, 'model', assistant.model),
    cost: num(m.cost) ?? num(call.cost),
    recordingUrl: str(artifact.recordingUrl) ?? str(artifact.stereoRecordingUrl) ?? str(m.recordingUrl) ?? str(call.recordingUrl),
    transcript: str(artifact.transcript) ?? str(m.transcript) ?? str(call.transcript),
    // The system prompt (~13 kB, the same in every call) is not worth storing per call.
    messages: (Array.isArray(artifact.messages) ? artifact.messages : Array.isArray(m.messages) ? m.messages : []).filter(x => x?.role !== 'system'),
  };
}

function messageRow(msg) {
  const { role, message, secondsFromStart, time, ...rest } = msg ?? {};
  const text = typeof message === 'string' ? message : null;
  // Tool calls and results have no text: keep their payload (toolCalls, result, name) as JSON.
  const data = Object.keys(rest).length ? json(rest) : null;
  return { role: String(role ?? 'unknown'), text, secondsFromStart: num(secondsFromStart), time: num(time), data };
}


// Provider envelopes stay in this adapter; the backend receives a stable, provider-neutral report.
export function normalizeReport(source) {
  const { messages, ...call } = normalizeCall(source);
  const at = call.startedAt ?? new Date().toISOString();
  const results = new Map(messages.filter(m => m?.role === 'tool_call_result' && m.toolCallId)
    .map(m => [m.toolCallId, parse(m.result)]));
  const tools = new Map();
  for (const message of messages) {
    if (message?.role !== 'tool_calls' || !Array.isArray(message.toolCalls)) continue;
    for (const tc of message.toolCalls) {
      if (!validId(tc?.id) || !tc.function?.name) continue;
      const result = results.get(tc.id) ?? null;
      tools.set(tc.id, { toolCallId: tc.id, name: tc.function.name,
        arguments: parse(tc.function.arguments), result, ok: results.has(tc.id) ? !(result && (result.ok === false || result.error)) : null, ms: null, at });
    }
  }
  const type = source?.message?.type;
  return { call, messages: messages.map((message, seq) => {
    const row = messageRow(message);
    return { seq, ...row, data: parse(row.data) };
  }), toolCalls: [...tools.values()], reportReceived: type === 'end-of-call-report' || (!type && (Boolean(call.endedAt) || source?.status === 'ended')) };
}

export function createBackendCallLog({ baseUrl, secret, apiKey, fetch: fetchFn = globalThis.fetch, sleep = pause } = {}) {
  let pending = 0;
  async function send(path, payload) {
    // ponytail: bounded in-flight delivery, no durable spool; providers must retry failed final reports.
    if (pending >= 256) throw new HttpError(503, 'Voice log delivery capacity reached.');
    const body = JSON.stringify(payload, (key, value) => {
      if (/(authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) return '[REDACTED]';
      if (typeof value !== 'string') return value;
      for (const credential of [secret, apiKey]) if (credential) value = value.replaceAll(credential, '[REDACTED]');
      return value;
    });
    if (Buffer.byteLength(body) > 8_388_608) throw new HttpError(413, 'Voice log exceeds 8 MiB.');
    pending++;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        let status;
        try {
          const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/integrations/voice-log${path}`, {
            method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(3_000),
            headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body,
          });
          status = response.status;
          // Never forward/log provider response text, which may contain secrets or personal data.
          await response.body?.cancel();
          if (response.ok) return;
        } catch { status = 502; }
        const retryable = status === 408 || status === 429 || status >= 500;
        if (!retryable || attempt === 2) throw new HttpError(retryable ? 503 : status, `Voice log backend returned HTTP ${status}.`);
        await sleep(attempt === 0 ? 250 : 1_000);
      }
    } finally { pending--; }
  }
  async function putCall(id, report) {
    if (!validId(id) || !report?.call || typeof report.call !== 'object' || Array.isArray(report.call) ||
        (report.call.id != null && report.call.id !== id) ||
        (report.messages != null && !Array.isArray(report.messages)) ||
        (report.toolCalls != null && !Array.isArray(report.toolCalls))) {
      throw new HttpError(400, 'A valid call ID and normalized report with a matching call object are required.');
    }
    await send(`/calls/${id}`, report);
  }
  async function putTool(callId, toolId, tool) {
    if (!validId(callId) || !validId(toolId) || typeof tool?.name !== 'string' || !tool.name.trim() || tool.name.length > 200 ||
        (tool.toolCallId != null && tool.toolCallId !== toolId)) {
      throw new HttpError(400, 'Valid call/tool IDs and a tool name (at most 200 characters) are required.');
    }
    await send(`/calls/${callId}/tools/${toolId}`, tool);
  }
  return {
    putCall,
    putTool,
    async recordCall(source) {
      const report = normalizeReport(source);
      await putCall(report.call.id, report);
      return report.call.id;
    },
    async recordToolCall(event) {
      if (!validId(event.callId) || !validId(event.toolCallId)) return;
      const result = event.result ?? null;
      await putTool(event.callId, event.toolCallId, {
        customerNumber: event.customerNumber ?? null, name: event.name,
        arguments: event.args ?? null, result, ok: event.ok,
        ms: num(event.ms), at: event.at ?? new Date().toISOString(),
      });
    },
  };
}
