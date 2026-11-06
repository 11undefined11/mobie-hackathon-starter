# Vapi server integration and team handoff

The server implements R1 and the server portions of R3, R4, R6 and R8 from [the roadmap](../ROADMAP.md). Vapi is the chosen telephone provider. The collaborator owns the German conversation, location-source improvements, phone configuration and staging fixtures. Live phone acceptance remains a joint checkpoint.

## Run locally

Use Node 24 LTS, then run:

```sh
npm run setup
npm test
npm start
```

Setup generates the local `STARTER_API_KEY`. Supply the organizer-issued `VOICE_INTEGRATION_SECRET` privately in `.env`. Configure an eligible `MAPBOX_ACCESS_TOKEN`, or replace the location service with one that permits storing coordinates in mobie. Starting without the team secret fails; test fixtures do not grant staging access.

Expose port 3000 through an HTTPS tunnel or deploy behind HTTPS termination. Set `HOST=0.0.0.0` for container or external interface access. `/health` checks the process only. Check a registered passenger through the existing connection page or `/api/caller` to verify upstream access.

## Vapi configuration for the collaborator

1. Create synchronous Function tools using the definitions in [vapi-tools.json](../examples/vapi-tools.json). Set each tool's server URL to `https://YOUR_HOST/vapi/tools`. Attach an HTTP Bearer credential containing this server's `STARTER_API_KEY`. Do not send the mobie secret to Vapi.
2. Add all six tools to the assistant. Configure the German voice, transcription and conversation instructions. Execute tools one at a time where supported; search, selection and booking depend on previous results. Set the tool timeout above the starter's 15-second upstream timeout with a margin for delivery. Booking-list reads can take longer across multiple pages; prefer a known booking ID.
3. Set the assistant's event/server URL to `https://YOUR_HOST/vapi/events` with the same local Bearer credential. Enable `end-of-call-report` and `status-update`, and include transcript and ordered messages in the final report. The tools and event URLs serve different purposes.
4. Attach the assistant to a callable number. Use actual registered staging passenger numbers. The server reads the customer number from `message.call.customer.number` or `message.customer.number`; conflicting values are rejected. It never uses model-supplied identity.
5. Use a real test call to verify envelopes. Vapi's dashboard Function Test panel can send raw arguments rather than the full live `tool-calls` envelope; raw arguments are intentionally rejected by this endpoint.
6. Enable provider retries or a supported final-report replay process. A failed central report delivery returns 503. Preserve original call IDs, message ordering and tool IDs when replaying. Never replay business writes using new action identities.

This implementation follows Vapi's [server event envelope](https://docs.vapi.ai/server-url/events) and [Function tool response format](https://docs.vapi.ai/tools/custom-tools). Tool results are serialized strings keyed by `toolCallId`; failures use a separate flat `error` string. Invalid envelopes or authentication return HTTP errors; valid tool envelopes return per-tool outcomes under HTTP 200.

## Conversation contract

| Tool | Arguments | Result and required next step |
| --- | --- | --- |
| `get_caller` | Empty object | Registered caller details. Resolve registration problems before proceeding. |
| `search_locations` | `query` | Named coordinate candidates with server-generated `id` and source attribution. Ask follow-up questions and read the chosen places to the caller. |
| `search_rides` | `departureId`, `destinationId`, `time`, `seatsRequested`, `locationsConfirmed: true` | `rides` and the retained passenger `trip`. IDs must come from location searches within this call; time must be future ISO with an offset and seats must be 1–8. |
| `select_ride` | `rideId` from a returned `ride.id` | `summaryId`, retained `trip` and original `suggestion`. Summarize the complete trip and available pickup and price details before asking for consent. |
| `book_ride` | Current `summaryId`, boolean `confirmed` | False sends no request and invalidates the summary. True submits the retained trip with a server-generated persisted action key. Successful submission still requires driver approval. |
| `get_booking_status` | Optional `bookingId` | Current upstream status, or all caller bookings when omitted. A request ID is not a booking ID. Listing follows empty intermediate pages and rejects pagination cycles or more than 100 pages. |

All other top-level tool arguments are rejected. The model cannot choose a phone number, call ID, coordinates, upstream path or booking action key. Each session retains up to 256 tool IDs and 256 location candidates. After a limit, explain the issue and end the call; do not restart a call to retry an uncertain booking with a new identity.

The collaborator's conversation instructions must establish explicit spoken consent. The adapter checks the current summary and boolean confirmation; it does not independently classify audio or prove that a summary was spoken. A prompt must never set `confirmed: true` because of silence, uncertainty, an earlier trip or a request merely to search.

Interpret “morgen” and other relative dates in `Europe/Vienna` using the current call date. Ask when a date or daylight-saving transition is ambiguous. Send the offset appropriate for that date. The server validates a future instant and explicit offset; it does not interpret German dates or infer a time zone from speech.

For pre-booking questions, use only returned suggestion data. Summarize the passenger's confirmed pickup and destination, date and time, seats, pickup estimate if provided, and available price. Missing price is unknown. After a change to the trip, run a new search and selection, then repeat the summary and obtain fresh consent.

The location service must implement `searchLocations(query)` returning `{ candidates: [{ publicName, addressLine?, longitude, latitude }], attribution }`. The collaborator can replace or extend the Mapbox implementation without changing the tool contract. IDs are assigned by the server; the assistant cannot invent coordinates or pass one call's IDs to another. Mapbox's current address geocoder does not establish full POI coverage.

## Booking retries and caller isolation

The server binds each call ID to its original caller identity and serializes operations within the call. Different calls run independently. It rejects attempts to bind the same call ID to another phone or call type. Keep Vapi's globally unique call IDs unchanged in tool requests and final reports.

Before sending a booking, the server saves the exact target, payload and generated idempotency key. After a timeout or transport failure, the action remains unresolved. Retry `book_ride` with the same `summaryId`; it sends the same key and payload. A new search or selection is blocked until that action is resolved. If the original response was lost, mobie can replay its original successful result.

Completed submissions are reused even when Vapi issues a new tool ID for the same summary. Reusing a provider tool ID with different arguments is rejected. A known business rejection such as a removed ride permits a new search; auth errors, rate limits and uncertain transport failures retain the saved action for recovery.

A repeated submission receipt is historical. Use `get_booking_status` for the driver's current decision. Refusal after a request has already been sent does not withdraw it. Withdrawal and cancellation are outside this adapter's current tool set.

## State and deployment

State defaults to `.local/voice-sessions`, which is ignored by Git. It contains personal trip data and action records. Use a private persistent volume via `VOICE_SESSION_DIRECTORY`; protect it with host ACLs on Windows or permissions on Linux. Retain it through restarts and releases so unresolved actions remain recoverable. Arrange a retention policy for completed sessions with the team; do not delete unresolved action records as routine cleanup.

Run exactly one Node process against each state directory. This file store serializes within one process and is not a distributed lock. Multiple replicas require a transactional shared store and cross-process locking before deployment. A deployment cannot reconstruct action keys after its state volume is lost.

The [Dockerfile](../Dockerfile) uses Node 24, runs as the unprivileged `node` user and starts directly from environment variables. It has no runtime package installation. Build with:

```sh
docker build -t mobie-voice-hackathon:local .
```

For deployment, provide the required secrets through the host's private environment configuration, publish port 3000 behind HTTPS, and mount a persistent volume at `/app/.local`. The Docker entry point does not run setup or read a `.env` file: `STARTER_API_KEY` and `VOICE_INTEGRATION_SECRET` must be set in the container environment. `.env` and local session data are excluded from the image context. The health check verifies process health, not organizer access.

`VOICE_ALLOW_WEB_CALLS` defaults to false. Set it to true only after organizers assign a browser test passenger. Invalid supplied phone numbers never fall back to that passenger. Phone-less test calls use explicit Vapi `webCall` metadata.

Existing direct `/api/...` routes remain available for manual tests and trusted integrations. They enforce their original confirmation and key rules; they do not participate in the adapter's summary state. Point model tools at `/vapi/tools` to use the new conversation guards.

## Acceptance and remaining external work

Automated tests cover setup with Windows line endings, trusted metadata, real local HTTP forwarding, isolated concurrent callers, candidate ownership, invalid and past trips, refusal, stale summaries, repeated consent, retry after restart, tool identity reuse, current status reads and empty-page traversal. Existing tests cover final-report retries, redaction and logging failures without changing booking outcomes.

Live acceptance requires the organizer secret, configured geocoding, registered callers, an approved driver and vehicle, future staging rides, a public HTTPS host and the collaborator's Vapi assistant configuration. Complete these checks together:

1. Call from each of two registered passenger numbers and verify the correct account.
2. Resolve ambiguous locations, find an actual future seeded ride, then decline. Verify no booking write.
3. Repeat and explicitly agree after the complete German summary. Verify one real stored request and accurate pending wording.
4. Verify the driver decision using a fresh status read and inspect central transcript, ordered messages and tool results.
5. Verify a controlled retry with the same saved action; do not induce duplicate live bookings through new calls.
6. Run the six organizer routes with refreshed dates and the collaborator's two extra challenging routes.

Docker build verification also requires a running Docker engine. No phone number, provider account or public deployment is created by the local implementation.
