# Local rehearsal and real data setup

Run the complete server conversation locally before configuring a phone number or public HTTPS. The rehearsal uses synthetic places, test callers and a local backend. It does not use the real organizer credential, Mapbox, Vapi or staging rides.

## Run the rehearsal

From the project folder with Node 24 LTS, run:

```sh
npm run rehearse:local
```

The command starts the real starter on a temporary local port with isolated test services. It exercises the same seven Vapi tools and German transcript confirmation checks used by the application. It sends complete final reports through `/vapi/events` to a local test backend.

Five checks must pass:

1. Explicit agreement produces one pending test request.
2. Refusal produces no test request.
3. A lost booking response retries the same key and payload and produces no duplicate stored request.
4. A fresh status lookup follows an empty intermediate page and reads the test driver's decision.
5. All final transcripts and matching tool events arrive at the local backend.

The command closes its temporary servers and removes temporary call state after running. It writes only an aggregate report to `.local/rehearsal-report.json`, which is ignored by Git. The report records pass results and counts; it contains no transcripts, phone numbers or credentials. For a different report destination, use `npm run rehearse:local -- --report PATH`.

This command uses an isolated temporary port and does not require stopping an already-running server on port 3000. Its synthetic ride and status results are rehearsal evidence, not a completed live evaluation or real driver approval.

## Add the registered passenger number

Open `.env` in this project's folder. Find `MOBIE_CALLER_PHONE=` and put the number registered to your staging **passenger** account after the equals sign. Include the country code and omit spaces, for example `+436641234567`. The example is illustrative; use the registered test passenger's actual number.

This number is used only for the manual search example and connection testing. Real phone calls still derive identity from trusted Vapi metadata. If no test passenger exists yet, arrange one in the staging app with the organizers. An ordinary GitHub or ChatGPT account is not a mobie passenger account.

## Add the location token

Sign in to Mapbox and open **Access Tokens** in its Developer Console. Copy an access token after `MAPBOX_ACCESS_TOKEN=` in `.env`, then save the file. Mapbox provides [token management instructions](https://docs.mapbox.com/accounts/guides/tokens/).

The integration requests permanent geocoding because mobie stores the returned locations. Mapbox requires a valid payment card or enterprise contract for that mode; confirm eligibility with your collaborator before using it. See [Mapbox storage requirements](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results). If the team chooses another location service, it must permit storing the coordinates and retain the shared `searchLocations` contract.

Keep the existing `VOICE_INTEGRATION_SECRET` unchanged. Save credentials only in the ignored local file, not in an issue, shared screenshot or commit. Each developer configures their own local environment privately.

## Check the real configuration next

After saving, restart the local server so it reloads `.env`, then run `npm run check:deployment`. This validates local configuration and storage, not upstream access. Use the connection page at `http://localhost:3000` with the generated `STARTER_API_KEY` and registered phone to perform a read-only caller lookup. A successful lookup does not place a booking.

Continue with a real location lookup and future staging ride search before attempting any booking test. A real write still needs explicit confirmation. Public HTTPS and Vapi phone acceptance remain later steps in [the roadmap](../ROADMAP.md).
