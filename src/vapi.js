import { HttpError } from './http.js';
import { callerHeaders } from './mobie.js';

export function vapiContext(message, { allowWebCalls = false } = {}) {
  const call = message?.call;
  if (!call || typeof call !== 'object') throw new HttpError(400, 'Vapi call metadata is required.');
  const phone = call.customer?.number ?? message.customer?.number;
  if (call.customer?.number && message.customer?.number && call.customer.number !== message.customer.number) {
    throw new HttpError(400, 'Conflicting Vapi customer metadata.');
  }
  const web = call.type === 'webCall';
  if (web && !allowWebCalls) throw new HttpError(400, 'Web calls are disabled. Arrange an organizer-assigned web test user before enabling them.');
  if (!web && !['inboundPhoneCall', 'outboundPhoneCall'].includes(call.type)) throw new HttpError(400, 'Unsupported Vapi call type.');
  const context = { callId: call.id, ...(web ? { callType: 'webCall' } : {}), ...(phone !== undefined ? { phone } : {}) };
  callerHeaders(context);
  return context;
}

export function createVapiAdapter({ flow, calls, allowWebCalls = false }) {
  return {
    async handle(source) {
      const message = source?.message;
      if (message?.type !== 'tool-calls') throw new HttpError(400, 'Expected a Vapi tool-calls message.');
      const context = vapiContext(message, { allowWebCalls });
      const list = message.toolCallList;
      if (!Array.isArray(list) || !list.length || list.length > 16 ||
          list.some(tool => typeof tool?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.id)) ||
          new Set(list.map(tool => tool.id)).size !== list.length) throw new HttpError(400, 'Supply 1–16 uniquely identified Vapi tool calls.');
      const results = [];
      // Ordered execution preserves dependencies when several tools share a call.
      for (const tool of list) {
        const started = Date.now();
        let args, result, error;
        try {
          args = tool.function?.arguments ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { throw new HttpError(400, 'Invalid JSON tool arguments.'); }
          }
          result = await flow.execute(context, tool.id, tool.function?.name, args, {
            messages: message.artifact?.messages ?? message.messages ?? [],
          });
        } catch (failure) {
          error = failure instanceof HttpError ? `${failure.status}: ${failure.message}${failure.code ? ` (${failure.code})` : ''}` : '500: Voice tool failed. Retry the same booking summary after checking the server.';
        }
        results.push({ toolCallId: tool.id, ...(error ? { error } : { result: JSON.stringify(result) }) });
        // Match provider tool IDs so final reports merge rather than duplicate.
        Promise.resolve().then(() => calls.recordToolCall({ callId: context.callId, toolCallId: tool.id,
          customerNumber: context.phone, name: tool.function?.name ?? 'unknown_tool', args,
          result: error ? { error } : result, ok: !error, ms: Date.now() - started,
          at: new Date(started).toISOString() }))
          .catch(() => console.error('Voice tool log delivery failed; check backend access and the provider final report.'));
      }
      return { results };
    },
  };
}
