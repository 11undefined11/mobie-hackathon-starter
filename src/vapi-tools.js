import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http.js';
import { callerHeaders } from './mobie.js';

const defaultStatePath = fileURLToPath(new URL('../.local/vapi-call-state.json', import.meta.url));
const validCallId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validToolId = validCallId;

function createStateStore(filePath) {
  const states = new Map();
  try {
    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error();
    for (const [callId, state] of Object.entries(stored)) if (validCallId(callId) && state && typeof state === 'object') states.set(callId, state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Vapi call state could not be read; preserve .local/vapi-call-state.json and restore it before retrying.');
  }
  return {
    get(callId) { return states.get(callId) ?? { locations: {}, search: null, pendingBooking: null, action: null }; },
    save(callId, state) {
      state.updatedAt = new Date().toISOString();
      states.set(callId, state);
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const [id, value] of states) if (Date.parse(value.updatedAt ?? '') < cutoff) states.delete(id);
      mkdirSync(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(states)), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, filePath);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* Best effort cleanup. */ }
        throw error;
      }
    },
  };
}

function providerContext(report) {
  const message = report?.message ?? {};
  const call = message.call ?? {};
  const callPhone = call.customer?.number;
  const messagePhone = message.customer?.number;
  if (callPhone && messagePhone && callPhone !== messagePhone) throw new HttpError(400, 'Vapi caller metadata is inconsistent.');
  const phone = callPhone ?? messagePhone;
  const context = {
    callId: call.id,
    ...(phone ? { phone } : {}),
    ...(!phone && call.type === 'webCall' ? { callType: 'webCall' } : {}),
  };
  callerHeaders(context);
  return context;
}

function parseArguments(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new HttpError(400, 'Vapi tool arguments must be valid JSON.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Vapi tool arguments must be an object.');
  return value;
}

function textOf(message) {
  const value = message?.message ?? message?.content ?? message?.text;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text ?? '').join(' ');
  return '';
}

function normalizeConsentText(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-AT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const affirmative = /^(?:ja|ja bitte|ja bitte buchen|ja bitte anfragen|bitte buchen|bitte anfragen|bitte senden|genau|das passt|einverstanden|ich bin einverstanden|ich bestaetige|ich bestatige|stimmt|klingt gut|mach das)$/;

function verifySpokenConfirmation(messages, afterMessageCount, expectedPhrase) {
  if (!Array.isArray(messages) || messages.length <= afterMessageCount) return false;
  const later = messages.slice(afterMessageCount);
  let lastUserIndex = -1;
  for (let index = 0; index < later.length; index++) if (later[index]?.role === 'user' && textOf(later[index]).trim()) lastUserIndex = index;
  if (lastUserIndex < 1 || !affirmative.test(normalizeConsentText(textOf(later[lastUserIndex])))) return false;
  const expected = normalizeConsentText(expectedPhrase);
  const assistantText = later.slice(0, lastUserIndex).filter(message => message?.role === 'assistant').map(textOf).join(' ');
  return expected.length > 0 && normalizeConsentText(assistantText).includes(expected);
}

function verifyExplicitConsent(messages, pending) {
  return verifySpokenConfirmation(messages, pending.preparedAtMessageCount, pending.summary);
}

function rideIdentifier(suggestion) {
  const ride = suggestion?.ride ?? suggestion;
  const value = ride?.id ?? suggestion?.rideId;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function ridePriceText(suggestion) {
  const ride = suggestion?.ride ?? suggestion;
  const value = suggestion?.priceText ?? suggestion?.priceFormatted ?? suggestion?.priceDisplay ??
    ride?.priceText ?? ride?.priceFormatted ?? ride?.priceDisplay;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function summaryFor(trip, ride) {
  const time = new Intl.DateTimeFormat('de-AT', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Vienna',
  }).format(new Date(trip.time));
  const seatWord = trip.seatsRequested === 1 ? 'Sitzplatz' : 'Sitzplätze';
  const price = ride.priceText ?? 'Der Preis ist in den Suchergebnissen nicht angegeben.';
  return `Abholung: ${trip.departure.publicName}. Ziel: ${trip.destination.publicName}. Zeit: ${time}. ${trip.seatsRequested} ${seatWord}. Preis: ${price}. Soll ich die Buchungsanfrage jetzt senden?`;
}

function clearTrip(state) {
  if (state.action?.status === 'pending') throw new HttpError(409, 'A booking submission is unresolved. Retry confirm_booking with the same call before changing this trip.');
  state.search = null;
  state.pendingBooking = null;
  state.action = null;
}

function safeError(error) {
  if (error instanceof HttpError) return error.message;
  return 'The mobie tool request failed. Please try again or offer another option.';
}

export function createVapiToolHandler({ mobie, mapbox, calls, statePath = defaultStatePath } = {}) {
  if (!mobie || !mapbox) throw new Error('Vapi tools require mobie and location services.');
  const store = createStateStore(statePath);
  const locks = new Map();

  async function withCallLock(callId, callback) {
    const previous = locks.get(callId) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(callId, current);
    await previous;
    try { return await callback(); }
    finally { release(); if (locks.get(callId) === current) locks.delete(callId); }
  }

  async function dispatch(name, args, context, state, messages) {
    if (name === 'get_caller_profile') return mobie.caller(context);
    if (name === 'find_location') {
      clearTrip(state);
      const slot = args.slot;
      if (!['departure', 'destination'].includes(slot)) throw new HttpError(400, 'slot must be departure or destination.');
      const found = await mapbox.searchLocations(args.query);
      const candidates = (found.candidates ?? []).filter(candidate => candidate.publicName && Number.isFinite(candidate.longitude) && Number.isFinite(candidate.latitude));
      state.locations ??= {};
      state.locations[slot] = { query: args.query, candidates, foundAfterMessageCount: Array.isArray(messages) ? messages.length : 0 };
      return { candidates: candidates.map((candidate, index) => ({ candidateId: String(index + 1), ...candidate })), attribution: found.attribution ?? '' };
    }
    if (name === 'confirm_location') {
      clearTrip(state);
      const slot = args.slot;
      if (!['departure', 'destination'].includes(slot)) throw new HttpError(400, 'slot must be departure or destination.');
      const location = state.locations?.[slot];
      const candidates = location?.candidates;
      const index = Number(args.candidateId) - 1;
      if (!Array.isArray(candidates) || !Number.isInteger(index) || index < 0 || index >= candidates.length) throw new HttpError(400, 'Choose a candidate returned by find_location.');
      if (!verifySpokenConfirmation(messages, location.foundAfterMessageCount, candidates[index].publicName)) throw new HttpError(400, 'Speak the selected location and wait for the caller to clearly confirm it before continuing.');
      state.locations[slot].confirmed = candidates[index];
      return { confirmedLocation: candidates[index] };
    }
    if (name === 'search_rides') {
      clearTrip(state);
      const departure = state.locations?.departure?.confirmed;
      const destination = state.locations?.destination?.confirmed;
      if (!departure || !destination) throw new HttpError(400, 'Resolve and confirm the departure and destination before searching.');
      const payload = { departure, destination, time: args.time, seatsRequested: args.seatsRequested ?? 1 };
      const suggestions = await mobie.searchRides(payload, context);
      if (!Array.isArray(suggestions)) throw new HttpError(502, 'mobie returned an unexpected ride-search response.');
      state.search = { payload, rides: suggestions.map(item => ({ id: rideIdentifier(item), priceText: ridePriceText(item) })).filter(item => item.id) };
      return { suggestions };
    }
    if (name === 'prepare_booking') {
      if (state.action?.status === 'pending') throw new HttpError(409, 'A booking submission is unresolved. Retry confirm_booking with the same call before preparing another.');
      const ride = state.search?.rides?.find(item => item.id === args.rideId);
      if (!ride || !state.search?.payload) throw new HttpError(400, 'Select a ride from the latest search results first.');
      const summary = summaryFor(state.search.payload, ride);
      state.pendingBooking = {
        rideId: ride.id, payload: state.search.payload, summary,
        preparedAtMessageCount: Array.isArray(messages) ? messages.length : 0,
      };
      return { summary, instruction: 'Say the summary exactly, then wait for a clear yes or no. Only call confirm_booking after an explicit yes.' };
    }
    if (name === 'confirm_booking') {
      const pending = state.pendingBooking;
      if (!pending) throw new HttpError(400, 'Prepare and speak the complete booking summary before asking for confirmation.');
      if (!verifyExplicitConsent(messages, pending)) throw new HttpError(400, 'No clear spoken yes after the complete trip summary was found; no booking was submitted.');
      if (state.action?.status === 'sent') return { request: state.action.result, message: 'The request was submitted; the driver must still approve it.' };
      if (!state.action) {
        state.action = {
          status: 'pending', key: `vapi-${randomUUID()}`, rideId: pending.rideId,
          payload: { ...pending.payload, confirmed: true }, summary: pending.summary,
        };
        store.save(context.callId, state);
      }
      const result = await mobie.joinRide(state.action.rideId, state.action.payload, { ...context, idempotencyKey: state.action.key });
      state.action.status = 'sent';
      state.action.result = result;
      store.save(context.callId, state);
      return { request: result, message: 'The request was submitted; the driver must still approve it.' };
    }
    throw new HttpError(400, `Unknown Vapi tool: ${name || '(missing name)'}.`);
  }

  return async function handleVapiTools(report) {
    const message = report?.message;
    if (message?.type !== 'tool-calls' || !Array.isArray(message.toolCallList) || message.toolCallList.length === 0) {
      throw new HttpError(400, 'Expected a Vapi tool-calls message with at least one function call.');
    }
    const context = providerContext(report);
    const messages = message.artifact?.messages ?? message.messages ?? [];
    const results = [];
    for (const item of message.toolCallList) {
      if (!validToolId(item?.id)) throw new HttpError(400, 'Vapi supplied an invalid tool-call ID.');
      const name = item.function?.name;
      const started = Date.now();
      let args = {};
      let value;
      let errorText;
      try {
        args = parseArguments(item.function?.arguments ?? {});
        value = await withCallLock(context.callId, async () => {
          const state = store.get(context.callId);
          const result = await dispatch(name, args, context, state, messages);
          store.save(context.callId, state);
          return result;
        });
      } catch (error) { errorText = safeError(error); }
      const event = {
        callId: context.callId, toolCallId: item.id, customerNumber: context.phone ?? null,
        name: typeof name === 'string' ? name : 'unknown_vapi_tool', arguments: args,
        result: errorText ? { error: errorText } : value, ok: !errorText,
        ms: Date.now() - started, at: new Date().toISOString(),
      };
      Promise.resolve().then(() => calls?.recordToolCall?.(event))
        .catch(() => console.error('Voice tool log delivery failed; check backend access and the provider final report.'));
      results.push({ name: typeof name === 'string' ? name : 'unknown', toolCallId: item.id,
        ...(errorText ? { error: errorText } : { result: JSON.stringify(value ?? null) }) });
    }
    return { results };
  };
}
