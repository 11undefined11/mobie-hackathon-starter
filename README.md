# mobie Voice AI Hackathon

Build a German-speaking phone assistant that resolves locations, finds rides and
submits booking requests after explicit caller confirmation.

## Start here: organizer-approved voice access

Use the dedicated **`/integrations/voice` API** with a team integration secret
provided by Maximilian/the organizers. Your team's server/webhook forwards the
trusted caller number and call ID; mobie resolves the passenger account. This
integration needs no Auth0 browser login or rotating refresh tokens.

1. Update your existing clone with `git pull --ff-only`.
2. Ask the organizers for your enabled team access, secret and API origin.
3. Follow **[the voice integration guide](docs/voice-integration.md)** to check
   `/caller`, search rides and submit a confirmed booking with an idempotency key.
4. Import the updated [Postman collection](docs/postman_collection.json) for manual
   API tests. Set secret values locally; the booking example requires consent.

The guide also explains caller identity, browser tests, errors, revocation and
how to migrate an existing team server. Per-team access and browser test accounts
require the corresponding backend rollout; organizers confirm availability.

**Code status:** this update covers documentation and request examples. The
JavaScript starter still uses its legacy Auth0 login; it does not consume
`VOICE_INTEGRATION_SECRET` yet. Use the direct API examples or adapt your team's
server as described in the guide. Running `npm run setup` alone does not migrate it.

- [Challenge and evaluation](docs/challenge.md)
- [Voice API, authentication and migration](docs/voice-integration.md)
- [Authentication reference](docs/authentication.md)
- [API reference](docs/api.md)

<details>
<summary>Legacy starter setup and implementation reference (Auth0)</summary>

# mobie Hackathon Starter

Build a German-speaking phone assistant that finds rides and sends real booking requests through the **mobie staging REST API**. Use the AI phone platform of your choice and Mapbox or another geocoding or point-of-interest (POI) search service. An Austrian street-name matcher is an optional extension.

This starter provides Auth0 login with PKCE, automatic token renewal, a small REST client and a server your phone assistant can call. It uses **Node.js built-ins only**, with no runtime dependencies.

**One running starter = one staging test passenger.** Every caller handled by that starter acts as that passenger. It does not identify real passengers by caller phone number. Use separate instances/accounts for separate team passengers. A booking request still needs the driver's approval.

For the demo, the account you sign into in the starter's browser login represents the caller. Requests already pass through the team server, which uses that account's Auth0 token. If someone calls from a different phone number, their searches and booking requests still use the same signed-in account. Caller phone-number matching is not implemented in this starter and is not required for the challenge. A future version could associate callers with their own mobie accounts, with appropriate identity verification and authorization to act for each user.

## Start in five steps

Requirements: Node.js **22+** (24 LTS recommended), a mobie staging passenger account, and the supplied public Auth0 configuration. Creating accounts and test rides happens in the staging app. A driver account needs the appropriate approval and a vehicle.

You will receive access to the mobie staging app for the hackathon. You can create as many test user accounts as you need and use the app to set up test rides and approve booking requests. Use separate driver and passenger accounts to test the complete flow. Each running starter still uses one signed-in passenger account at a time.

```sh
git clone https://github.com/mobie-code/mobie-hackathon-starter.git
cd mobie-hackathon-starter
npm install
npm run setup
```

1. Fill in `.env`: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_AUDIENCE`. Add your own `MAPBOX_ACCESS_TOKEN` if using the included geocoding implementation; configure other location services in your own integration. `npm run setup` creates a random `STARTER_API_KEY` and does not overwrite an existing `.env`.
2. Run `npm run dev` and open **http://localhost:3000**. Use this exact hostname if your callback is `http://localhost:3000/callback`.
3. Enter your `STARTER_API_KEY`, click **Sign in with Auth0**, and log in with the staging **passenger** account.
4. After returning, enter the team key again and click **Check API connection**. This calls `GET /me` and verifies access to the actual mobie API.
5. Copy `examples/search.json` to a local file, set a future ISO datetime with offset and coordinates matching a test ride, then run:

```sh
npm run example:search -- ./my-search.json
```

The example only searches; it never books automatically. An empty array is a valid result, not a connection failure. Sample coordinates are illustrative and do not promise an available ride.

## Two different Bearer tokens

| Where you send a request | Header |
| --- | --- |
| Your team's starter (`http://localhost:3000/api/...`) | `Authorization: Bearer <STARTER_API_KEY>` |
| mobie staging (`https://api-staging.mobie.at/...`) | `Authorization: Bearer <AUTH0_ACCESS_TOKEN>` |

The starter keeps Auth0 tokens in server memory and adds the current access token when calling mobie. It never sends tokens to the phone assistant or exposes an endpoint to download them. The team key is **not** a mobie API credential. A server restart requires login again. A browser refresh does not.

## Connect your phone assistant

Expose the running starter through an HTTPS tunnel or deploy one instance per team. Set your assistant's HTTP integration URL to that public origin plus one of the paths below, and add the **team key** as its Bearer token. Keep the server running throughout the demo.

| Method | Starter endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/locations/search` | Resolve an address with your Mapbox account |
| POST | `/api/rides/search` | Send exact start/destination coordinates to mobie |
| POST | `/api/rides/{rideId}/join-detailed` | Submit a booking request **after consent** |
| GET | `/api/me` | Verify the authenticated staging account |
| GET | `/api/rides/{rideId}/rider-detail` | Passenger details **after driver approval** |
| GET | `/api/rides/{rideId}` | Driver-only details; not a passenger lookup |

Use the `ride.id`, driver, pickup estimate, route and price fields from search results to answer questions **before booking**. The generic backend `GET /rides/{id}` is driver-only. Keep each conversation's selected result and searched coordinates in your own assistant/service.

Send `{ "query": "Stephansplatz 1, Wien" }` to the geocoding endpoint. It returns candidates with `publicName`, `addressLine`, `longitude` and `latitude`, ready for `departure` or `destination`. Clarify ambiguity instead of always choosing the first result.

For booking, repeat the searched locations, time and seat count and add **`"confirmed": true`** only after the caller explicitly agrees to the spoken summary. This flag is a starter guard, not a proof of spoken consent and not a mobie REST field. The starter removes it before sending the request. Do not automatically retry booking requests after a timeout; the write may already have succeeded.

For a local tunnel you can keep the OAuth callback on `localhost`: login in the local browser, and use the tunnel only for phone integrations. For a hosted server set `HOST=0.0.0.0`, terminate HTTPS at the host, and register/set the exact public `AUTH0_REDIRECT_URI` ending in `/callback`. The login page also requires the team key.

## Mapbox, alternative location services and POI search

Mapbox is an example integration, not a requirement. You may use other geocoding services, POI search APIs or suitable location datasets to resolve addresses, landmarks, stations and other places. Bring your own provider credentials where required. Adapt `src/mapbox.js` or resolve locations in your own service, then send numeric `longitude` and `latitude` values to mobie. Your chosen data source must permit storing the resulting location data in mobie.

The sample uses **Geocoding v6 with `permanent=true`**, since mobie persists locations even during ride search. Your Mapbox account needs the prerequisites for permanent geocoding (a valid payment card or an eligible enterprise agreement); calls can incur costs. The example searches addresses, streets and places in Austria in German. It does **not** provide POI search.

For POIs, extend the client using an appropriately licensed dataset/service. Mapbox Search Box results are temporary-use by default; do not assume they may be stored in mobie without the required agreement. Preserve attribution in any UI displaying results.

- [Mapbox permanent geocoding](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results)
- [Mapbox Search Box restrictions](https://docs.mapbox.com/api/search/search-box/#search-box-api-restrictions-and-limits)

## Documentation

- [Existing mobie REST API and starter endpoints](docs/api.md)
- [Authentication, login and refresh](docs/authentication.md)
- [Challenge description](docs/challenge.md)
- [Importable Postman collection](docs/postman_collection.json)

## Develop

```sh
npm test
npm start
```

`npm run dev` restarts on code changes (and therefore clears the login). Use `npm start` during calls/demos. Tests run locally against controlled Auth0/Mapbox/mobie responses, without credentials, charges or staging writes. CI tests Node 22 and 24. These tests do not cover live Auth0 login or an actual phone-to-booking run.

| File | What to change |
| --- | --- |
| `src/auth.js` | PKCE flow and serialized rotating refresh |
| `src/mobie.js` | REST calls and coordinate validation |
| `src/mapbox.js` | Location candidates; extend for your matcher |
| `src/server.js` | Your assistant's HTTP endpoints |
| `examples/search.js` | First real staging search |

Keep `.env`, credentials, call transcripts and personal test data out of commits. Only staging is intended; the config rejects the known production API origin. This is a single-team hackathon starter, not a production identity/booking gateway.

</details>
