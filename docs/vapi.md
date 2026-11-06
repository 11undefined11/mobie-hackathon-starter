# Connect Vapi

The starter accepts Vapi call reports and function-tool calls. It translates
Vapi's tool-call envelope into local `/api/...` operations, adds caller identity
from Vapi call metadata, and returns results in Vapi's response format. Do not
send `VOICE_INTEGRATION_SECRET` to Vapi; the starter adds it when calling mobie.

## 1. Make the starter reachable

Vapi must be able to reach the server over HTTPS. For local development, expose
port `3000` through an HTTPS tunnel. Keep `npm start` running while the tunnel
and calls are in use. The default `HOST=127.0.0.1` works with a tunnel that
forwards to `localhost:3000`.

Create a Vapi custom credential containing the local `STARTER_API_KEY` as a
Bearer token. Use that credential on the assistant webhook and every Function
tool. Never use the mobie team secret or Vapi account API key there.

## 2. Send call reports

In the Vapi Dashboard, open **Assistants → your assistant → Advanced → Webhook
Server** and set:

```text
https://<public-starter-host>/vapi/events
```

Select the custom credential containing `STARTER_API_KEY`, enable the
`end-of-call-report` and `status-update` server messages, save, and publish.
This endpoint forwards transcripts and ordered messages to mobie's call
history. See [call-logs.md](call-logs.md).

## 3. Add Function tools

Create the following Function tools in **Tools**, then attach them to the
assistant. For each tool, set the Server URL to
`https://<public-starter-host>/vapi/tools`, select the same custom credential,
and use a request timeout of at least 20 seconds. The function names and
arguments must match this table:

| Function name | Arguments | Purpose |
| --- | --- | --- |
| `get_caller_profile` | None | Resolve the registered caller from Vapi call metadata |
| `find_location` | `slot`: `departure` or `destination`; `query`: string | Find address candidates and return IDs and coordinates |
| `confirm_location` | `slot`: `departure` or `destination`; `candidateId`: string | Retain the candidate the caller confirmed |
| `search_rides` | `time`: future ISO datetime with offset; `seatsRequested`: integer 1–8 | Search with the two confirmed locations |
| `prepare_booking` | `rideId`: ID from the latest search result | Return the trip summary for the assistant to speak |
| `confirm_booking` | None | Submit after the adapter verifies the spoken summary and a clear yes |
| `get_booking_status` | Optional `bookingId` | Read the current driver decision; omit the ID to list all caller bookings |

Use the seven definitions in [examples/vapi-tools.json](../examples/vapi-tools.json)
as the shared contract. Distinct operations require unique provider tool IDs;
retries preserve the original ID and arguments.

Use an object JSON schema for each function's **Parameters** and define only the
arguments listed above. Do not add caller phone, call ID, `confirmed`, or an
idempotency key to the model-visible schema. The adapter takes call ID and phone
from Vapi's authenticated call metadata and creates and persists the write key
itself. A phone-less Vapi web call works only if mobie assigned your team an
active browser-test passenger and `VOICE_ALLOW_WEB_CALLS=true` is configured
privately on the starter. This flag defaults to false.

Add instructions like these to the assistant's system prompt:

```text
Speak German. Resolve departure and destination separately with find_location.
Present ambiguous candidates and ask which one the caller means. Call
confirm_location only after you have spoken the candidate's name and the caller
has clearly confirmed it. Collect a future date and local time in Europe/Vienna
and the number of seats before calling search_rides.

When the caller chooses a result, call prepare_booking. Speak the returned
summary exactly as written and ask whether to send the booking request. Call
confirm_booking only after a clear, unambiguous yes to that exact summary. Do
not call it after a no, hesitation, changed trip, or question. If the tool says
no confirmation was found, ask again and do not claim a booking was submitted.
Explain that a submitted request is pending until the driver approves it. Never
invent a price; if the summary says the price is not shown, say it is unknown.
```

The adapter checks the last caller message against a conservative set of direct
German yes responses and requires the assistant's immediately preceding turn to contain
the exact summary. This can reject paraphrased confirmations; the assistant
should read the summary as returned. A location or trip change clears prior
booking preparation. Booking idempotency keys and exact write payloads are kept
in `.local/voice-sessions`, or `VOICE_SESSION_DIRECTORY` when configured. Retry
`confirm_booking` in the same call after a timeout to reuse the saved key. If the
previous single-file `.local/vapi-call-state.json` exists, startup stops for
reviewed migration; preserve its action keys. See [booking recovery](server-operations.md).

## 4. Check the connection

1. Use Vapi's Function tool **Test** panel to check the endpoint and credential.
   That test does not include in-call `message.call` metadata; use a real Vapi
   test call to verify caller resolution.
2. Call the Vapi number from a registered staging passenger phone.
3. Confirm Vapi tool logs show successful calls and mobie's call history receives
   the final report.
4. For booking tests, use an approved staging driver/ride and remember that
   driver approval is a separate step.

The location tool uses the starter's optional Mapbox permanent geocoding setup.
Set `MAPBOX_ACCESS_TOKEN` to use it; permanent geocoding requires an eligible
Mapbox account. It covers addresses, streets and places, not every landmark or
POI. Use a storage-permitted source if you replace it.
