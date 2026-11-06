import { randomUUID } from 'node:crypto';
import { callerHeaders, ridePayload, location } from './mobie.js';
import { HttpError } from './http.js';

const fields = {
  get_caller: [], search_locations: ['query'],
  search_rides: ['departureId', 'destinationId', 'time', 'seatsRequested', 'locationsConfirmed'],
  select_ride: ['rideId'], book_ride: ['summaryId', 'confirmed'],
  get_booking_status: ['bookingId'],
};
const requireValue = (condition, message, status = 400) => { if (!condition) throw new HttpError(status, message); };

export function createVoiceFlow({ mobie, locations, store, now = Date.now }) {
  return {
    async execute(context, toolId, name, args) {
      callerHeaders(context);
      requireValue(typeof toolId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(toolId), 'Invalid tool call ID.');
      requireValue(Object.hasOwn(fields, name), 'Unknown voice tool.');
      requireValue(args && typeof args === 'object' && !Array.isArray(args), 'Tool arguments must be an object.');
      requireValue(Object.keys(args).every(key => fields[name].includes(key)), 'Unexpected tool argument; identity and action keys are server controlled.');
      const identity = JSON.stringify([context.phone ?? '', context.callType ?? '']);
      const input = JSON.stringify([name, args]);
      return store.exclusive(context.callId, async () => {
        const state = store.read(context.callId) ?? { callId: context.callId, identity, candidates: {}, tools: {} };
        requireValue(state.identity === identity, 'Call ID is already bound to another caller.', 409);
        const receiptKey = `tool:${toolId}`;
        const previous = state.tools[receiptKey];
        requireValue(!previous || previous.input === input, 'Tool call ID reused with different arguments.', 409);
        if (previous && Object.hasOwn(previous, 'result')) return previous.result;
        requireValue(previous || Object.keys(state.tools).length < 256, 'Call tool limit reached.', 429);
        state.tools[receiptKey] = { input };
        store.save(state);
        const pending = state.action && !state.action.completed;
        if (pending && ['search_rides', 'select_ride'].includes(name)) {
          throw new HttpError(409, 'A booking outcome is unresolved. Retry book_ride with the existing summaryId before changing the trip.');
        }
        let result;
        if (name === 'get_caller') result = await mobie.caller(context);
        if (name === 'search_locations') {
          requireValue(typeof args.query === 'string' && args.query.trim().length > 0 && args.query.length <= 256, 'A location query is required.');
          const found = await locations.searchLocations(args.query);
          requireValue(Array.isArray(found?.candidates), 'Location source returned invalid candidates.', 502);
          requireValue(Object.keys(state.candidates).length + found.candidates.length <= 256, 'Call location limit reached.', 429);
          const candidates = found.candidates.map(candidate => {
            // Reuse the same location validator as the upstream payload.
            const resolved = location(candidate, 'candidate');
            const id = randomUUID();
            state.candidates[id] = resolved;
            return { id, ...resolved };
          });
          result = { candidates, attribution: found.attribution ?? '' };
        }
        if (name === 'search_rides') {
          requireValue(args.locationsConfirmed === true, 'Confirm both resolved locations with the caller first.');
          const departure = Object.hasOwn(state.candidates, args.departureId) ? state.candidates[args.departureId] : null;
          const destination = Object.hasOwn(state.candidates, args.destinationId) ? state.candidates[args.destinationId] : null;
          requireValue(departure && destination, 'Use candidate IDs returned by search_locations in this call.');
          const trip = ridePayload({ departure, destination, time: args.time, seatsRequested: args.seatsRequested });
          requireValue(Date.parse(trip.time) > now(), 'Travel time must be in the future. Interpret spoken dates in Europe/Vienna.');
          // Persist invalidation before searching: a failed replacement search
          // must never leave an old consent summary usable.
          state.trip = null; state.rides = []; state.summary = null; state.action = null;
          store.save(state);
          const rides = await mobie.searchRides(trip, context);
          requireValue(Array.isArray(rides), 'Ride search returned an invalid response.', 502);
          state.trip = trip; state.rides = rides;
          result = { rides, trip };
        }
        if (name === 'select_ride') {
          requireValue(state.trip, 'Search for rides before selecting one.', 409);
          const suggestion = state.rides.find(item => item?.ride?.id === args.rideId);
          requireValue(suggestion, 'Select a ride.id from this call\'s latest search.');
          state.summary = { summaryId: randomUUID(), rideId: args.rideId, trip: state.trip, suggestion };
          state.action = null;
          result = { ...state.summary, requiresExplicitConsent: true, priceInstruction: 'Use only returned price information; missing price means unknown, never free.' };
        }
        if (name === 'book_ride') {
          requireValue(state.summary && args.summaryId === state.summary.summaryId, 'The booking summary is missing or outdated. Select the current ride and summarize it again.', 409);
          requireValue(typeof args.confirmed === 'boolean', 'confirmed must be a boolean after the caller answers the summary.');
          if (!args.confirmed) {
            requireValue(!state.action, 'A booking was already sent. Refusal cannot undo it; check its status.', 409);
            state.summary = null;
            result = { submitted: false, message: 'No booking request was sent.' };
          } else {
            if (!state.action) {
              requireValue(Date.parse(state.trip.time) > now(), 'Travel time has passed. Search again.');
              state.action = { key: randomUUID(), rideId: state.summary.rideId, payload: { ...state.trip, confirmed: true }, completed: false };
              // This must be durable before the upstream write, including if
              // its response is lost or this process is restarted.
              store.save(state);
            }
            if (!state.action.completed) {
              try {
                state.action.result = await mobie.joinRide(state.action.rideId, state.action.payload, { ...context, idempotencyKey: state.action.key });
              } catch (error) {
                // Definitive business rejection allows a new search. Transport
                // failures, auth failures and rate limits retain the action.
                if (error instanceof HttpError && [400, 402, 403, 404, 409, 422].includes(error.status)) {
                  state.action.completed = true;
                  state.action.failure = { status: error.status, message: error.message, code: error.code };
                  store.save(state);
                }
                throw error;
              }
              state.action.completed = true;
              store.save(state);
            }
            if (state.action.failure) throw new HttpError(state.action.failure.status, state.action.failure.message, state.action.failure.code);
            result = { submitted: true, requiresDriverApproval: true, submission: state.action.result, message: 'Buchungsanfrage übermittelt. Die Fahrerin oder der Fahrer muss noch zustimmen. Für den aktuellen Status erneut abfragen.' };
          }
        }
        if (name === 'get_booking_status') {
          if (args.bookingId !== undefined) {
            result = await mobie.booking(args.bookingId, context);
          } else {
            const bookings = [];
            const visited = new Set();
            let page = 0;
            do {
              requireValue(Number.isSafeInteger(page) && page >= 0 && !visited.has(page) && visited.size < 100, 'Invalid or excessive booking pagination.', 502);
              visited.add(page);
              const found = await mobie.bookings(page, context);
              requireValue(Array.isArray(found?.bookings) && (found.nextPage === null || Number.isSafeInteger(found.nextPage)), 'Invalid booking list response.', 502);
              bookings.push(...found.bookings);
              page = found.nextPage;
            } while (page !== null);
            result = { bookings };
          }
        }
        // Status reads must remain live even when a provider repeats its tool ID.
        if (name !== 'get_booking_status') state.tools[receiptKey].result = result;
        store.save(state);
        return result;
      });
    },
  };
}
