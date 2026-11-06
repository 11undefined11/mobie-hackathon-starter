# Vapi server integration and team handoff

The combined server retains the collaborator's German location and booking conversation, backed by the shared engine's durable actions, caller isolation and live status reads. It implements the server portions of R3, R4, R6 and R8 in [the roadmap](../ROADMAP.md). Live phone and staging acceptance remain joint work.

## Run and configure Vapi

Use Node 24 LTS. Run `npm run setup`, supply the organizer-issued `VOICE_INTEGRATION_SECRET` privately in `.env`, configure Mapbox or a permitted replacement location service, and run `npm start`. Use `npm test` for controlled local tests and `npm run check:deployment` for local configuration and storage checks.

Expose port 3000 over public HTTPS. Use `HOST=0.0.0.0` for container or external interface access. `/health` verifies the process only; `/api/caller` verifies a registered passenger's upstream access.

Configure Vapi as described in [the Vapi guide](vapi.md). Add the seven synchronous Function tools in [vapi-tools.json](../examples/vapi-tools.json). Each tool uses `https://YOUR_HOST/vapi/tools` and an HTTP Bearer credential containing this server's `STARTER_API_KEY`. The mobie secret stays on the server.

Use `https://YOUR_HOST/vapi/events` for assistant reports with the same local credential. Enable `end-of-call-report` and `status-update`, including transcript and ordered messages. Configure retries or replay for failed final reports. A failure to persist a final report returns 503. Keep call IDs, message order and tool IDs unchanged when replaying.

These envelopes and response strings follow Vapi's [server events](https://docs.vapi.ai/server-url/events) and [Function tools](https://docs.vapi.ai/tools/custom-tools). Dashboard Function Test requests can contain raw arguments rather than a live tool envelope; use a real test call for identity and transcript checks.

## Shared tool contract

| Tool | Arguments | Result and next step |
| --- | --- | --- |
| `get_caller_profile` | Empty object | Registered caller details; resolve registration problems before continuing. |
| `find_location` | `slot` as departure or destination, `query` | Candidates with slot-local `candidateId` and attribution. Clarify ambiguity, speak the chosen name and address, and wait for a clear yes. |
| `confirm_location` | `slot`, `candidateId` | Retains the candidate after a spoken full address, or its name when no address is available, followed by a clear agreement. |
| `search_rides` | `time`, `seatsRequested` | `suggestions` for both confirmed locations. Time must be a future ISO datetime with an explicit offset; seats must be 1–8. |
| `prepare_booking` | `rideId` from a returned `ride.id` | German `summary` for the retained passenger trip and available formatted price. Read it exactly, then wait for explicit consent. |
| `confirm_booking` | Empty object | Verifies spoken agreement before sending the saved trip and action key. Returns `request` and a message explaining that the driver still needs to approve it. |
| `get_booking_status` | Optional `bookingId` | Current upstream decision, or all caller bookings if omitted. A ride request ID is not a booking ID. |

Function arguments cannot choose identity, coordinates, confirmation flags, transcript evidence, upstream paths or action keys. Unexpected arguments are rejected. Each distinct operation needs a unique provider tool ID; retries preserve the original ID and arguments. The per-call limit is 256 tool IDs and 256 location candidates.

The location service implements `searchLocations(query)` returning `{ candidates: [{ publicName, addressLine?, longitude, latitude }], attribution }`. The collaborator can extend `src/mapbox.js` or replace the service while retaining this contract. Use a source permitting persistence in mobie and preserve attribution. The current Mapbox geocoder does not establish full POI coverage.

## Transcript checks and dates

The adapter reads authenticated provider evidence from `message.artifact.messages` or `message.messages`. The latest caller answer must be a conservative German affirmative, and the immediately preceding assistant turn must contain the expected location name or entire booking summary. A yes to an unrelated later question is rejected. This checks provider transcription, not raw audio; paraphrases can be rejected, so read the summary verbatim.

Assistant turns accept both normalized `assistant` roles and Vapi's native `bot` roles, as documented in [Vapi call messages](https://docs.vapi.ai/observability/logs/call-logs).

Location changes invalidate the prepared trip and consent. A replacement search also invalidates the old summary even if its upstream request fails. A new trip needs a new search, summary and agreement. Declining a summary sends no booking write. The public endpoint rejects earlier engine-only functions such as `book_ride` and `select_ride`, so a model cannot bypass spoken consent with a boolean flag.

Interpret relative dates in `Europe/Vienna` using the current call date. Clarify ambiguous dates and daylight-saving transitions, then send the offset for that date. The server validates a future instant and explicit offset; it does not interpret German speech. Answer pre-booking questions from returned suggestions. Missing formatted price is unknown, not free.

## Identity and recovery

The server derives phone and call ID from Vapi call metadata and binds the saved call to that identity. Conflicting customer numbers, changed caller identity and invalid supplied phones are rejected. Concurrent callers retain separate locations, summaries and action keys, including case-sensitive call IDs on Windows.

Before a booking write, the engine saves its target, exact payload and action key. After a timeout, retry `confirm_booking` in the same call; it reuses the saved action and already-recorded consent even if older transcript messages are omitted from the retry. New searches and selections are blocked while an action is unresolved. Successful submissions are reused; fresh status reads establish the driver's latest decision.

Listing status follows `nextPage` across empty pages and rejects pagination cycles or more than 100 pages. Refusal after a request was sent does not withdraw it. Cancellation and withdrawal are outside this tool set.

Keep `.local/voice-sessions`, or the configured `VOICE_SESSION_DIRECTORY`, on a private persistent volume. Run one process per volume; the file store does not provide distributed locking. Do not delete unresolved action records or put state, transcripts or credentials in Git. See [server readiness and recovery](server-operations.md).

Pending actions from the earlier server engine remain recoverable through `confirm_booking`. If the collaborator's older `.local/vapi-call-state.json` exists, startup stops for reviewed migration. Preserve its action keys; do not delete it just to make startup succeed. That earlier format did not bind sessions to saved caller identity, so automatic conversion would need additional identity evidence.

## Deployment and live acceptance

The [Dockerfile](../Dockerfile) runs Node 24 as the unprivileged `node` user. Build with `docker build -t mobie-voice-hackathon:local .` when Docker is running. Supply `STARTER_API_KEY` and `VOICE_INTEGRATION_SECRET` as private container environment variables, publish port 3000 behind HTTPS, and mount persistent storage at `/app/.local`. The container starts directly; it does not run setup or load a `.env` file. Its health check verifies process health only.

Phone-less tests require an organizer-assigned web test user and `VOICE_ALLOW_WEB_CALLS=true`. The flag defaults to false. Invalid supplied phones never fall back to that user.

Live acceptance requires organizer access, registered callers, a driver with approval and a vehicle, future staging rides, a public HTTPS host and the configured Vapi assistant. Verify two callers, ambiguous locations, a declined booking, one explicitly confirmed real request, a current driver-status read and complete central call history. Then run the six organizer routes with refreshed dates and two additional challenging team routes. Local tests do not satisfy those live criteria.

Direct `/api/...` routes retain their original manual-test contracts. They enforce confirmation and idempotency headers without participating in the transcript state; model tools must use `/vapi/tools`.
