import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http.js';
import { createSessionStore } from './session-store.js';
import { createVoiceFlow } from './voice-flow.js';
import { createVapiAdapter } from './vapi.js';

const defaultDirectory = fileURLToPath(new URL('../.local/voice-sessions', import.meta.url));
const legacyPath = fileURLToPath(new URL('../.local/vapi-call-state.json', import.meta.url));
const fields = {
  get_caller_profile: [], find_location: ['slot', 'query'],
  confirm_location: ['slot', 'candidateId'], search_rides: ['time', 'seatsRequested'],
  prepare_booking: ['rideId'], confirm_booking: [], get_booking_status: ['bookingId'],
};
function textOf(message) {
  const value = message?.message ?? message?.content ?? message?.text;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text ?? '').join(' ');
  return '';
}
function normalize(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-AT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const affirmative = /^(?:ja|ja bitte|ja bitte buchen|ja bitte anfragen|bitte buchen|bitte anfragen|bitte senden|genau|das passt|einverstanden|ich bin einverstanden|ich bestaetige|ich bestatige|stimmt|klingt gut|mach das)$/;
function verifySpokenConfirmation(messages, after, expectedPhrase) {
  if (!Array.isArray(messages) || messages.length <= after) return false;
  const later = messages.slice(after);
  let lastUser = -1;
  for (let index = 0; index < later.length; index++) if (later[index]?.role === 'user' && textOf(later[index]).trim()) lastUser = index;
  if (lastUser < 1 || !affirmative.test(normalize(textOf(later[lastUser])))) return false;
  // An older summary followed by an unrelated yes/no question is not consent.
  let previousUser = lastUser - 1;
  while (previousUser >= 0 && later[previousUser]?.role !== 'user') previousUser--;
  const assistant = later.slice(previousUser + 1, lastUser).filter(m => ['assistant', 'bot'].includes(m?.role)).map(textOf).join(' ');
  const expected = normalize(expectedPhrase);
  return expected.length > 0 && normalize(assistant).includes(expected);
}
function priceText(suggestion) {
  const ride = suggestion?.ride ?? {};
  const value = suggestion?.priceText ?? suggestion?.priceFormatted ?? suggestion?.priceDisplay ?? ride.priceText ?? ride.priceFormatted ?? ride.priceDisplay;
  return typeof value === 'string' && value.trim() ? value.trim() : 'Der Preis ist in den Suchergebnissen nicht angegeben.';
}
function summaryFor(trip, suggestion) {
  const time = new Intl.DateTimeFormat('de-AT', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Vienna' }).format(new Date(trip.time));
  const departure = trip.departure.addressLine || trip.departure.publicName;
  const destination = trip.destination.addressLine || trip.destination.publicName;
  return `Abholung: ${departure}. Ziel: ${destination}. Zeit: ${time}. ${trip.seatsRequested} ${trip.seatsRequested === 1 ? 'Sitzplatz' : 'Sitzplätze'}. Preis: ${priceText(suggestion)}. Soll ich die Buchungsanfrage jetzt senden?`;
}
function clearTrip(state, dialogue) {
  if (state.action && !state.action.completed) throw new HttpError(409, 'A booking submission is unresolved. Retry confirm_booking before changing the trip.');
  state.trip = null; state.rides = []; state.summary = null; state.action = null;
  dialogue.pending = null;
}

// Collaborator dialogue tools backed by the shared durable booking engine.
export function createVapiToolHandler({ mobie, mapbox, calls, store, statePath, allowWebCalls = false } = {}) {
  if (!mobie || !mapbox) throw new Error('Vapi tools require mobie and location services.');
  if (existsSync(statePath ?? legacyPath)) throw new Error('Legacy Vapi state requires reviewed migration before startup. Preserve its action keys; do not delete the file to bypass recovery.');
  store ??= createSessionStore(statePath ? `${statePath}.sessions` : defaultDirectory);
  // The outer dialogue transaction owns the call lock for both layers.
  const engine = createVoiceFlow({ mobie, locations: mapbox, store: { ...store, exclusive: async (_id, operation) => operation() } });
  const flow = {
    async execute(context, toolId, name, args, { messages = [] } = {}) {
      if (!Object.hasOwn(fields, name)) throw new HttpError(400, 'Unknown Vapi tool. Use the canonical definitions in examples/vapi-tools.json.');
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields[name].includes(key))) throw new HttpError(400, 'Unexpected tool argument; identity and action keys are server controlled.');
      if (!Array.isArray(messages)) throw new HttpError(400, 'Vapi conversation messages must be an array.');
      return store.exclusive(context.callId, async () => {
        const identity = JSON.stringify([context.phone ?? '', context.callType ?? '']);
        const state = store.read(context.callId) ?? { callId: context.callId, identity, candidates: {}, tools: {} };
        if (state.identity !== identity) throw new HttpError(409, 'Call ID is already bound to another caller.');
        const dialogue = state.dialogue ?? { locations: {}, receipts: {}, pending: null };
        if (!state.dialogue && state.action && state.summary) {
          // Preserve recovery of writes sent by the pre-merge server engine.
          dialogue.pending = { summaryId: state.summary.summaryId, summary: summaryFor(state.summary.trip, state.summary.suggestion), after: 0 };
        }
        state.dialogue = dialogue;
        const receiptKey = `vapi:${toolId}`;
        const input = JSON.stringify([name, args]);
        const previous = dialogue.receipts[receiptKey];
        if (previous && previous.input !== input) throw new HttpError(409, 'Tool call ID reused with different arguments.');
        if (previous && Object.hasOwn(previous, 'result') && name !== 'get_booking_status') return previous.result;
        if (!previous && Object.keys(dialogue.receipts).length >= 256) throw new HttpError(429, 'Call tool limit reached.');
        dialogue.receipts[receiptKey] = { input };
        store.save(state);
        const run = (mapped, value) => engine.execute(context, toolId, mapped, value);
        let result;
        if (name === 'get_caller_profile') result = await run('get_caller', {});
        if (name === 'find_location') {
          if (!['departure', 'destination'].includes(args.slot)) throw new HttpError(400, 'slot must be departure or destination.');
          clearTrip(state, dialogue);
          delete dialogue.locations[args.slot];
          store.save(state);
          const found = await run('search_locations', { query: args.query });
          dialogue.locations[args.slot] = { candidates: found.candidates, foundAfter: messages.length };
          result = { ...found, candidates: found.candidates.map((candidate, index) => ({ ...candidate, candidateId: String(index + 1) })) };
        }
        if (name === 'confirm_location') {
          if (!['departure', 'destination'].includes(args.slot)) throw new HttpError(400, 'slot must be departure or destination.');
          const slot = dialogue.locations[args.slot];
          const index = typeof args.candidateId === 'string' && /^[1-9]\d*$/.test(args.candidateId) ? Number(args.candidateId) - 1 : -1;
          const candidate = slot?.candidates[index];
          if (!candidate) throw new HttpError(400, 'Choose a candidate returned by find_location.');
          if (!verifySpokenConfirmation(messages, slot.foundAfter, candidate.addressLine || candidate.publicName)) throw new HttpError(400, 'Speak the selected location including its full address when available, then wait for a clear caller confirmation.');
          clearTrip(state, dialogue);
          slot.confirmed = candidate;
          result = { confirmedLocation: candidate };
          store.save(state);
        }
        if (name === 'search_rides') {
          const departure = dialogue.locations.departure?.confirmed;
          const destination = dialogue.locations.destination?.confirmed;
          if (!departure || !destination) throw new HttpError(400, 'Resolve and confirm both locations before searching.');
          clearTrip(state, dialogue);
          store.save(state);
          const found = await run('search_rides', { departureId: departure.id, destinationId: destination.id, time: args.time, seatsRequested: args.seatsRequested ?? 1, locationsConfirmed: true });
          result = { suggestions: found.rides };
        }
        if (name === 'prepare_booking') {
          const selected = await run('select_ride', { rideId: args.rideId });
          const summary = summaryFor(selected.trip, selected.suggestion);
          dialogue.pending = { summaryId: selected.summaryId, summary, after: messages.length };
          result = { summary, instruction: 'Say the summary exactly, then wait for a clear yes or no. Only call confirm_booking after an explicit yes.' };
        }
        if (name === 'confirm_booking') {
          const pending = dialogue.pending;
          if (!pending) throw new HttpError(400, 'Prepare and speak the complete booking summary first.');
          // Previously recorded consent survives transcript truncation on retry;
          // a new trip cannot reuse it because it clears the pending summary.
          if (!state.action && !verifySpokenConfirmation(messages, pending.after, pending.summary)) throw new HttpError(400, 'No clear spoken yes after the complete current summary was found; no booking was submitted.');
          const submission = await run('book_ride', { summaryId: pending.summaryId, confirmed: true });
          result = { request: submission.submission, message: 'The request was submitted; the driver must still approve it.' };
        }
        if (name === 'get_booking_status') result = await run('get_booking_status', args);
        const saved = store.read(context.callId);
        saved.dialogue = dialogue;
        if (name !== 'get_booking_status') dialogue.receipts[receiptKey].result = result;
        store.save(saved);
        return result;
      });
    },
  };
  const adapter = createVapiAdapter({ flow, calls, allowWebCalls });
  return report => adapter.handle(report);
}
