# Dedicated mobie voice integration

The hackathon uses a dedicated, organizer-approved voice API at
`/integrations/voice`. Ask Maximilian/the organizers for your enabled **team
integration secret** and the API origin to use. Teams do not need an Auth0
browser login, callback registration, access token or refresh token for this API.
Auth0 remains in use for the normal mobie app and admin portal.

## Get access and update your checkout

1. Pull the latest documentation with `git pull --ff-only` in your existing clone.
2. Ask the organizers to create/enable your named team integration and share its
   secret privately. The secret is shown only once when created or rotated; it
   cannot be retrieved later. Organizers can revoke access or replace a secret.
3. Create a staging passenger account with a unique international phone number.
   Use a separate approved driver account with a vehicle to offer test rides and
   approve booking requests in the staging app.
4. Keep the supplied secret in your team's server environment, for example as
   `VOICE_INTEGRATION_SECRET`. Set `MOBIE_API_URL` to the organizer-supplied origin
   (normally `https://api-staging.mobie.at`, without `/integrations/voice`). Never
   commit secrets or put them in model prompts, browser code or screenshots.
5. Verify the passenger with `GET /integrations/voice/caller` before implementing
   search and booking. A successful identity check does not submit a booking.

**Rollout:** the voice routes exist on the staging branch. Per-team credential
management is a newer backend addition; the organizers must deploy/enable it on
that environment before issuing usable team access. This documentation update
alone does not activate credentials or deploy the backend. Use the URL and
credential explicitly supplied by the organizers.

## Request headers and caller identity

Your telephone provider calls **your team's server/webhook**. Your server handles
provider-specific tool envelopes, geocoding and conversation state, then calls
mobie's synchronous JSON API:

```text
Phone provider → team's webhook/server → mobie /integrations/voice/…
```

Do not point Vapi/Fonio tool envelopes directly at mobie. Each account/ride request
needs these headers:

```http
Authorization: Bearer <team integration secret>
X-Mobie-Caller-Phone: +436641234567
X-Mobie-Call-Id: <provider call ID>
Content-Type: application/json
```

The phone number above is illustrative: use the number of your registered test
passenger. In telephone calls, take it from trusted provider call metadata,
**never from model arguments or a number spoken by the caller**. Use E.164 (`+`
and 8–15 digits). The call ID accepts 1–128 ASCII letters, digits, `_` or `-`;
keep it stable throughout a call and unique across teams.

Mobie resolves the account on every request. Different callers can therefore use
their own registered accounts, instead of sharing whichever passenger logged
into the old starter. Unknown numbers return 404; numbers shared by multiple
active accounts return 409 with `code: "AMBIGUOUS_CALLER"`. Private/absent numbers
are rejected unless the explicit browser-test mode below is enabled.

The credential authorizes your trusted server to act for the supplied caller.
It does not independently verify phone-number ownership and does not restrict
the team to one passenger or a separate set of rides. Keep it server-side and
use registered test accounts for the classroom.

### Browser tests without a caller number

Once the organizers deploy the per-integration **Web test user** feature, ask them
to assign an active test passenger to your team in the admin portal. Your trusted
server can then send `X-Mobie-Call-Type: webCall` and the normal call ID, omitting
`X-Mobie-Caller-Phone`. The backend selects only the admin-configured test user;
a user ID supplied by the client cannot choose an account. Without an assignment,
this mode returns 400; a removed/deleted account returns 404.

A supplied phone number takes precedence. Invalid, unknown or ambiguous numbers
never fall back to the web test user. Until this feature is enabled, use a
registered test passenger's number explicitly in manual server-side API tests.

## First request

Set the organizer-supplied values in your local shell; the variables here are
for these curl examples, not settings already consumed by the legacy starter.
Use a real registered test number and a unique call ID:

```sh
export MOBIE_API_URL='https://api-staging.mobie.at'
read -r -s 'VOICE_INTEGRATION_SECRET?Team secret: '; echo
export VOICE_INTEGRATION_SECRET
export MOBIE_CALLER_PHONE='+436641234567'
export MOBIE_CALL_ID="team-test-$(uuidgen)"

curl --fail-with-body --silent --show-error \
  "$MOBIE_API_URL/integrations/voice/caller" \
  -H "Authorization: Bearer $VOICE_INTEGRATION_SECRET" \
  -H "X-Mobie-Caller-Phone: $MOBIE_CALLER_PHONE" \
  -H "X-Mobie-Call-Id: $MOBIE_CALL_ID"
```

The hidden-input `read` command above uses zsh (the macOS default). In bash use
`read -r -s -p 'Team secret: ' VOICE_INTEGRATION_SECRET; echo` instead. The response
contains `userId`, `firstName` and `savedPlaces`. Do not send internal user IDs or
private saved-place names back as public location identifiers.

Alternatively import [postman_collection.json](postman_collection.json). Set the
API origin, secret, caller phone and call ID in your private local Postman values.
Run requests manually; the booking example defaults to `confirmed: false`.

## Routes

All paths below are relative to `/integrations/voice`. All requests need the
integration and caller headers above. Responses use ordinary HTTP status codes
and JSON, without a Vapi `results/toolCallId` envelope.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/caller` | Verify caller and fetch saved places |
| POST | `/rides/nearby` | Optional upcoming rides near a resolved departure |
| POST | `/rides/search` | Search using resolved start/destination, time and seats; returns an array, including `[]` |
| POST | `/rides/{rideId}/join-detailed` | Submit a booking request after explicit consent |
| POST | `/ride-requests` | Create an open request after explicit consent; no driver acceptance |
| GET | `/ride-requests?openOnly=true` | Open requests, including pending bookings eligible for withdrawal |
| GET | `/bookings?page=0` | Caller bookings and driver approval status; follow `nextPage` until null, even for empty pages |
| GET | `/bookings/{bookingId}` | Current status of one caller-owned booking |
| GET | `/rides/{rideId}/rider-detail` | Passenger details after driver approval |
| POST | `/ride-requests/{requestId}/withdraw` | Withdraw an eligible request after explicit consent |
| POST | `/rides/{rideId}/bookings/{bookingId}/cancel` | Cancel an eligible booking after explicit consent |

There is no generic driver-only ride detail endpoint in this integration.
Before booking, use the search result to answer questions about the selected ride.

## Search payload

Resolve and confirm the locations in your own server using a suitable geocoder
or POI service. Send numeric coordinates and a nonempty `publicName` (maximum
500 characters); `addressLine` is optional. This voice API requires coordinates,
not a location ID or a free-text lookup. The data source must permit persistence.

```json
{
  "departure": {
    "publicName": "Muthgasse 24, Wien",
    "addressLine": "Muthgasse 24, 1190 Wien",
    "longitude": 16.365,
    "latitude": 48.24
  },
  "destination": {
    "publicName": "Stephansplatz, Wien",
    "longitude": 16.3738,
    "latitude": 48.2082
  },
  "time": "REPLACE_WITH_FUTURE_ISO_DATETIME_WITH_OFFSET",
  "seatsRequested": 1
}
```

Send this to `POST /integrations/voice/rides/search`. Replace the time with a
future ISO-8601 datetime ending in `Z` or an explicit offset. Interpret spoken
dates in Europe/Vienna and account for daylight saving time. Seats must be an
integer from 1 to 8. Longitude is within ±180; latitude within ±90.

Select `ride.id` from the returned suggestions. Preserve the passenger's searched
locations: the driver's route endpoints in a result may differ. Use the returned
pickup estimate and price when available; an unknown price is not free.

## Booking, consent and retries

Summarize pickup, destination, date/time, seats and available price information.
Only after explicit spoken agreement, send the same searched payload with
`"confirmed": true` to `POST /integrations/voice/rides/{rideId}/join-detailed`.
Unlike the old Auth0 starter, the voice backend receives the confirmation flag.
Success means a submitted request/pending booking; **the driver must still
approve it**. Read `/bookings` for the current decision. There is no outbound
webhook for later driver decisions.

Every write (join, open request, withdrawal, cancellation) additionally needs:

```http
Idempotency-Key: <stable ID for this confirmed action>
```

Generate and retain the key server-side before sending the write. Use 1–128
letters, digits, `.`, `_`, `:`, `/` or `-`. Reuse the **same key, target and payload**
for retries of the same action, including after a timeout. A new confirmed action
gets a new key. Reusing a key with changed data returns 409. Keys are scoped to
the authenticated integration and resolved user, and successful results survive
backend restarts. A replay returns the original result; query booking status
for the latest driver decision.

Open-request creation uses the search payload plus `confirmed: true`, without a
ride ID. Withdrawal/cancellation use `{"confirmed":true}`. Never automatically
turn a failed/empty search into a booking or open request without new consent.

## Errors

| Status | Check |
| --- | --- |
| 400 | Caller headers, call ID, payload, confirmation, idempotency key or web test configuration |
| 401 | Missing/invalid/disabled/rotated integration secret; ask organizers to check access |
| 402 | Existing payment requirements |
| 403 | Existing lifecycle restrictions |
| 404 | No active caller, inaccessible booking or removed web test user |
| 409 | `AMBIGUOUS_CALLER`, domain conflict, changed idempotent payload or conflicting call ID |
| 429 | Rate limit; avoid uncontrolled retries |

For support, share endpoint, HTTP status, call ID and request time. Keep secrets
and personal account data out of public issues and logs.

## Migrating the existing starter

The JavaScript starter in this repository still implements the **legacy Auth0
flow**. Pulling this documentation does not migrate that code. In particular,
`npm run setup`, the browser login page and `npm run example:search` still use
Auth0; adding `VOICE_INTEGRATION_SECRET` to `.env` alone will not switch them.

In your team's server, replace the upstream client authentication with the team
secret, use `/integrations/voice/...`, forward trusted caller metadata and retain
idempotency keys for writes. Replace the old `/me` identity check with `/caller`.
Remove the OAuth login/refresh dependency from that integration. Keep your phone
provider adapter, geocoder/matcher and conversation state. Your own webhook key
(e.g. `STARTER_API_KEY`) and the mobie integration secret protect different hops;
an Auth0 access token or Vapi API key cannot replace the integration secret.

Optional enriched transcripts/tool logs can be uploaded with the same integration
secret to `/integrations/voice-log/calls/...`; these uploads need no caller header
and grant no account/ride actions. The backend attributes authenticated voice
activity to the integration automatically. Ask organizers for the normalized
call-log schema before adding uploads.
