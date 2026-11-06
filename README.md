# mobie Voice AI Hackathon Starter

Build a German-speaking phone assistant that resolves locations, searches rides
and submits booking requests after explicit caller confirmation. This starter
uses the dedicated **`/integrations/voice` API** and your organizer-issued **team
integration secret**. There is no browser login, callback or token refresh flow.
Node.js built-ins only; no runtime dependencies.

## Update and start

Requirements: Node.js **22+** (24 LTS recommended), enabled team access from
Maximilian/the organizers, and registered staging test passengers. Use the API
origin and credential supplied by the organizers. Credentials are shared privately.

For an existing clone:

```sh
git pull --ff-only
npm run setup
```

For a new checkout:

```sh
git clone https://github.com/mobie-code/mobie-hackathon-starter.git
cd mobie-hackathon-starter
npm run setup
```

1. Put the organizer-issued `VOICE_INTEGRATION_SECRET` in `.env`. Keep
   `MOBIE_API_URL=https://api-staging.mobie.at` unless instructed otherwise.
2. Run `npm start` and open **http://localhost:3000**.
3. Enter the generated `STARTER_API_KEY` and a registered test passenger's phone
   number in international format. Click **API-Verbindung prüfen**. The server
   checks `/integrations/voice/caller`; it does not book anything.
4. For browser tests without a number, select the browser-test checkbox only if
   the organizers assigned an active **Web test user** to your integration.

`npm start`, `npm run dev` and `npm run example:search` automatically run setup
before starting. Existing `.env` files are migrated: obsolete identity-provider
settings are removed, missing settings added, and existing local/provider/team
keys preserved. The team secret must be supplied once; it cannot be shipped in
Git. A server restart keeps working with that configured secret.

Create test passengers and rides in the staging app. Use separate passenger and
driver accounts; drivers need approval and a vehicle. Every incoming call uses
the account matching its trusted provider phone number. A team credential does
not isolate rides or limit your server to one passenger.

## Two credentials for two connections

| Connection | Authorization |
| --- | --- |
| Phone provider → your starter `/api/...` | `Bearer <STARTER_API_KEY>` |
| Starter → mobie `/integrations/voice/...` | `Bearer <VOICE_INTEGRATION_SECRET>` (added server-side) |

Keep both credentials private. Do not put the mobie secret into model prompts,
browser code or public screenshots. Organizers can disable/rotate team access.
The normal app/admin login is managed separately from this starter.

## Connect your telephone service

Expose the starter through an HTTPS tunnel or deploy it with `HOST=0.0.0.0`
and HTTPS termination. Point your provider's HTTP integration at your public
starter URL and an endpoint in [docs/api.md](docs/api.md). Authenticate using
the local `STARTER_API_KEY`.

Your trusted provider adapter must add `X-Mobie-Caller-Phone` and
`X-Mobie-Call-Id` from **provider metadata**, never model tool arguments. The
starter forwards these headers to mobie; it does not parse Vapi/Fonio envelopes
or independently verify phone-number ownership. Keep each conversation's
locations, selected ride and confirmed action keys in your adapter. There is no
shared signed-in passenger or server-side fallback phone number.

For each write, add a stable `Idempotency-Key` and `confirmed: true` only after
explicit spoken consent. Save the key before sending and reuse it unchanged for
retries of that same action. Successful booking submission still requires driver
approval; read `/api/bookings` for the current decision.

## Call logs: configure the provider event webhook

The starter automatically **pushes tool logs** (arguments, results, timing and
errors) to the mobie backend for requests with a valid call ID. Full conversation
logging is also part of the integration: the provider must send its final report.

For **Vapi**, set the assistant's server/event URL to
`https://<your-starter>/vapi/events`, attach a Bearer credential with your local
`STARTER_API_KEY`, and enable `end-of-call-report` and `status-update`. The starter
normalizes and forwards those reports with the same mobie team secret.

For **other providers**, send a normalized report to `PUT /api/calls/{callId}`.
See **[central call log setup and report schema](docs/call-logs.md)** for the
required provider setup, delivery/retry behavior and examples. The backend does
not poll the teams for transcripts.

## First ride search

Copy `examples/search.json` to `my-search.json`; set confirmed locations and a
future ISO datetime with an explicit offset. Set `MOBIE_CALLER_PHONE` in `.env`
to your registered test passenger, then:

```sh
npm run example:search -- ./my-search.json
```

The example calls the running local starter. It only searches; `[]` is a valid
result. `MOBIE_CALLER_PHONE` and optional `MOBIE_CALL_TYPE=webCall` are used only
by this manual example, never as defaults for incoming telephone calls.

## Locations and POIs

The local `/api/locations/search` endpoint demonstrates Mapbox Geocoding v6 with
`permanent=true`; set your own `MAPBOX_ACCESS_TOKEN` to use it. Permanent geocoding
requires an eligible Mapbox account and can incur charges. It covers addresses,
streets and places, rather than POIs. You may replace it with a suitable geocoder,
POI service or dataset; your data source must permit storing the resulting
locations in mobie. Clarify ambiguity with callers and preserve attribution.

## Documentation and development

- [Two person project roadmap and delivery milestones](ROADMAP.md)
- [Vapi server adapter, tool definitions and collaborator handoff](docs/provider-adapter.md)
- [Team access, caller identity, payloads and retry rules](docs/voice-integration.md)
- [Starter and upstream API endpoints](docs/api.md)
- [Authentication and setup](docs/authentication.md)
- [Call logs and provider event webhook](docs/call-logs.md)
- [Direct voice API Postman collection](docs/postman_collection.json)
- [Challenge and evaluation](docs/challenge.md)

```sh
npm test
npm run dev
```

Tests use controlled responses and a local HTTP backend, without staging writes,
provider charges or credentials. CI runs Node 22 and 24. These checks do not
replace a live phone/provider integration test.

| File | Purpose |
| --- | --- |
| `src/config.js` | Team credentials and staging configuration |
| `src/mobie.js` | Voice API, caller validation, consent and action keys |
| `src/server.js` | Authenticated local HTTP endpoints and automatic tool logs |
| `src/call-log.js` | Vapi report normalization and central call/tool log delivery |
| `src/mapbox.js` | Optional location candidates |
| `src/index.html`, `src/page.js` | Manual caller connection check |
| `scripts/setup.js` | Safe configuration migration |
| `examples/search.js` | Search through the running starter |

Keep `.env`, call transcripts and personal test data out of commits. This is a
classroom starter for trusted team servers and staging accounts.
