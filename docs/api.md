# mobie API for the hackathon

The current hackathon integration uses the dedicated **`/integrations/voice` API**
and an organizer-issued team secret. Start with [the voice integration guide](voice-integration.md)
for access, caller identity, routes, payloads and idempotent writes. No Auth0 login
or token refresh is needed for that integration.

The JavaScript starter has not yet been migrated. Its existing endpoints and
Auth0 implementation are documented below for reference.

<details>
<summary>Legacy Auth0 REST API and starter endpoints (existing starter code)</summary>

# mobie REST API for the hackathon

This page documents the **existing mobie REST API** first, then the starter's convenience endpoints. All examples are illustrative, not live staging records. No legacy telephone webhook or provider-specific function-call envelope is needed.

## Direct access to mobie

```http
Authorization: Bearer <AUTH0_USER_ACCESS_TOKEN>
Content-Type: application/json
```

Base URL: **`https://api-staging.mobie.at`**. Use an access token for the correct Auth0 audience and a staging **passenger** for searches and joins. See [authentication.md](authentication.md). Do not use the starter team key, an ID token or a client-credentials/M2M token here.

| Method | Backend path | Access and purpose |
| --- | --- | --- |
| GET | `/me` | Current authenticated user; useful for checking login |
| POST | `/rides/search` | Find ride suggestions using exact locations |
| POST | `/rides/{rideId}/join-detailed` | Create a ride request and pending booking |
| GET | `/rides/{rideId}` | **Driver only**: manage/view your own offered ride |
| GET | `/rides/{rideId}/rider-detail` | **Approved passenger only**: view your ride and booking details |

Before booking, answer the passenger's questions from the search result. `GET /rides/{rideId}` is not a general passenger detail lookup. An unapproved pending request does not grant access to `/rider-detail` either.

## Location payload

For the challenge, send a resolved location:

```json
{
  "publicName": "Stephansplatz, Wien",
  "addressLine": "Stephansplatz, 1010 Wien, Österreich",
  "longitude": 16.3738,
  "latitude": 48.2082
}
```

- `longitude` and `latitude` are JSON **numbers**, in degrees. Do not swap them.
- `publicName` and `addressLine` help explain the trip to the caller.
- The backend also accepts `{ "id": "<accessible-mobie-location-id>" }`. This must be a **mobie** ID, never a Mapbox feature ID. When `id` is supplied it takes precedence over coordinates.
- `rawFeatureJson` is an optional backend field containing a **string**, not an object. The starter does not require or forward it.
- New coordinates can be persisted as location records by the backend even for a search. Only send data you are permitted to store. The included Mapbox example uses permanent geocoding.

Neither the direct REST search nor the join endpoint performs free-text address lookup for you. Use Mapbox or another geocoding service, POI search API or suitable location dataset, and clarify which candidate the caller means. Any provider can be used if its results may be stored in mobie; send resolved coordinates using the location payload above. The starter's included lookup endpoint uses Mapbox until you adapt or replace that integration.

## Search: `POST /rides/search`

```json
{
  "departure": {
    "publicName": "Stephansplatz, Wien",
    "longitude": 16.3738,
    "latitude": 48.2082
  },
  "destination": {
    "publicName": "Wien Hauptbahnhof",
    "longitude": 16.3765,
    "latitude": 48.185
  },
  "time": "2026-10-20T09:00:00+02:00",
  "seatsRequested": 1
}
```

Change the date and locations to match real event test rides. `departure`, `destination` and a usable `time` are necessary. Always provide `seatsRequested` (1–8 for search); the starter defaults it to 1.

The backend accepts an ISO-8601 instant/offset datetime or a local datetime interpreted in `Europe/Vienna`. **The starter deliberately requires `Z` or an explicit offset** to avoid timezone ambiguity. Austria's offset depends on the date; do not hard-code `+02:00` throughout the year. Relative words such as “tomorrow” must be converted by the assistant. The direct REST API has no `from`, `to`, `date`, `timeWindow` or `seats` fields from the old voice tools.

Success is HTTP 200 with a **JSON array**, including `[]` when no matches exist. It is not `{ "status": "OK", "rides": [...] }`.

Reduced example (additional fields omitted):

```json
[
  {
    "ride": {
      "id": "ride-example",
      "driverId": "driver-example",
      "numberOfSeats": 3,
      "time": "2026-10-20T07:00:00Z"
    },
    "driver": { "id": "driver-example", "firstName": "Alex", "lastName": "Beispiel" },
    "departure": { "publicName": "Start of driver's route", "longitude": 16.37, "latitude": 48.21 },
    "destination": { "publicName": "End of driver's route", "longitude": 16.38, "latitude": 48.18 },
    "availableSeats": 2,
    "estimatedPrice": 0,
    "estimatedPriceInCents": 0,
    "requiresPayment": false,
    "compensationMode": "FREE",
    "pickupEta": "2026-10-20T07:05:00Z",
    "minutesDiff": 0,
    "matchScore": 0.9
  }
]
```

Useful response fields:

| Field | Meaning |
| --- | --- |
| `ride.id` | Ride ID to use when joining |
| `ride.time` | Driver's departure time; not necessarily the passenger's pickup time |
| `ride.numberOfSeats` | Offered seat capacity; use `availableSeats` for current availability when present |
| `driver` | Driver summary, including ID/name/verification status |
| `departure`, `destination` | **Driver's route** endpoints; preserve the passenger's original search coordinates separately |
| `pickupEta` | Estimated pickup instant when available |
| `estimatedPriceInCents`, `estimatedPrice` | Payable estimate in **cents**, not euros; values may be null |
| `finalPriceInCents` | Final price when available; an estimate is not a final quote |
| `requiresPayment`, `compensationMode` | Payment information; free staging rides simplify testing |
| `minutesDiff`, `matchScore` | Search comparison/ranking information |

Other current fields include `driverProfilePictureUrl`, `depDistanceMeters`, `destDistanceMeters`, `sumDistanceMeters`, `direction`, `totalDistanceMeters`, `calculatedPrice`, `platformPriceEstimate`, `chargedPrice`, `payableAmount` and `recurringOffer`. The starter returns the backend response without renaming fields. This starter's booking example is for ordinary one-off rides; recurring/group/child flows are outside its scope.

## Join: `POST /rides/{rideId}/join-detailed`

1. Keep the chosen `ride.id` and the **passenger's** start, destination, time and seat count.
2. Read a summary and the available price information to the caller.
3. Ask for explicit consent.
4. Only after consent, POST the same basic payload structure as the search to the chosen ride's join endpoint.

The normal REST API does **not** provide the old voice `prepare_join_ride`/`confirmationToken` sequence. Your assistant owns consent and conversation state. The starter adds a local `confirmed: true` guard (documented below); direct mobie requests do not have that field.

`time` must be non-empty. The direct join DTO requires `seatsRequested` of at least 1; available capacity is checked separately. The starter consistently limits seats to 1–8. Optional backend event/recurring/child fields are not forwarded by this starter.

Success is HTTP 200 with a `RideRequestCreateResponse`. Reduced example:

```json
{
  "rideRequest": {
    "id": "request-example",
    "userId": "passenger-example",
    "departureLocationId": "location-start",
    "destinationLocationId": "location-end",
    "status": "PENDING",
    "time": "2026-10-20T07:00:00Z",
    "createdAt": "2026-10-19T12:00:00Z",
    "updatedAt": "2026-10-19T12:00:00Z"
  },
  "suggestions": []
}
```

This represents a real stored request and booking awaiting **driver approval**. Say that the request was sent, not that the driver has accepted. The driver can approve it through the staging app. Repeated active requests for the same passenger/ride can be rejected. Do not assume a booking POST is idempotent, and never blindly retry after a network timeout.

## Detail endpoints

`GET /rides/{rideId}` returns a `RideDetailsDto` for the driver: `id`, `numberOfSeats`, `time`, `createdAt`, `updatedAt`, `selectedRoute`, `requestedRoutes`, `visibility`, `cancelledAt`. `selectedRoute` contains `id`, `departureLocation`, `destinationLocation` and `distance`.

`GET /rides/{rideId}/rider-detail` requires an **approved** passenger booking and returns the ride times/status, `departure`, `destination`, route `coordinates`, `driver`, `vehicle`, `myBooking` and payment-mode fields. This is useful after the driver has approved in the app, not as a pre-booking lookup.

## Errors

Check the HTTP status first. The normal REST API is not the old voice webhook: do not expect `NO_RESULTS`, `JOIN_REQUESTED` or a `results/toolCallId` envelope.

- A successful search with no results returns `[]`.
- Auth errors include an expired token, wrong issuer/audience or missing user grant.
- Search/join can fail for invalid coordinates/time, an unavailable ride, insufficient seats, own-ride booking, duplicate requests or payment requirements.
- Detail endpoints apply the access restrictions described above. Exact error bodies/status mapping depend on the deployed backend; do not hard-code a single error-body schema.
- The starter preserves upstream HTTP error status and returns a short `{ "error": "mobie API returned HTTP ..." }`. Upstream response bodies are intentionally not echoed, since provider errors can contain credentials. For deeper diagnostics, contact hackathon support with the endpoint, HTTP status and request time.

## Starter HTTP endpoints

These run on **your server**, not on mobie. Use `Authorization: Bearer <STARTER_API_KEY>` and JSON bodies. Successful mobie responses are passed through unchanged.

| Endpoint | Request / behavior |
| --- | --- |
| `GET /health` | Unauthenticated process health only; does not prove upstream readiness |
| `POST /auth/login` | Team key required; returns an Auth0 URL and sets the browser state cookie; use the supplied page |
| `GET /callback` | Browser callback, validated using one-time state and cookie |
| `GET /api/status` | Login state and access-token expiry; never the tokens |
| `POST /api/logout` | Clears this process's login |
| `GET /api/me` | Proxies mobie `/me` |
| `POST /api/locations/search` | `{ "query": "Stephansplatz 1, Wien" }`; returns `{ "candidates": [...], "attribution": "..." }` |
| `POST /api/rides/search` | Same basic location/time/seat payload as mobie |
| `POST /api/rides/{rideId}/join-detailed` | Same basic payload **plus `confirmed: true`** |
| `GET /api/rides/{rideId}` | Proxies driver-only details |
| `GET /api/rides/{rideId}/rider-detail` | Proxies approved-passenger details |

The `confirmed` boolean must reflect actual spoken consent; setting it automatically defeats its purpose. This starter does not prove consent cryptographically or persist call state. No automatic retries are performed for writes.

The starter only forwards its explicitly listed routes and fields, not arbitrary URLs or administrative APIs. Request bodies are limited to 16 KiB. Its own errors use `{ "error": "..." }` (400 invalid payload/consent, 401 missing key/login, 404 route, 413 size, 415 content type, 502 upstream network/JSON issue, 503 missing Mapbox token). A timeout may have an unknown write outcome.

## Current request examples

The [Postman collection](postman_collection.json) now targets the dedicated voice
API directly. It does not call these legacy starter endpoints or use the browser
login. Follow [voice-integration.md](voice-integration.md) for its setup.

</details>
