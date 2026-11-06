# Team implementation instructions

Read README.md, ROADMAP.md and docs/provider-adapter.md before changing the phone integration.

## Commands

- Use Node 24 LTS. Run `npm run setup` for local environment migration.
- Run `npm test` before handing off changes. Tests use local controlled responses, never live staging writes.
- Run `npm run check:deployment` to validate local deployment configuration and session storage without making upstream requests.
- Run `npm run rehearse:local` for an isolated synthetic conversation and final-report rehearsal; it does not read .env or contact live services.
- No runtime dependencies are needed. Keep the existing starter routes compatible.

## Ownership

- Server owner: scripts/setup.js, src/server.js, src/session-store.js, src/voice-flow.js, src/vapi.js and corresponding tests and deployment configuration.
- Collaborator: German dialogue, phone and Vapi assistant configuration, location resolution in src/mapbox.js or a replacement service, staging fixtures and evaluation.
- Coordinate changes to shared contracts before editing another owner's module. Use separate branches and review each other's changes.

## Integration rules

- Caller phone and call ID come from authenticated provider metadata, never model tool arguments.
- Use server-issued location candidate IDs. Preserve attribution and only use sources permitting storage in mobie.
- Booking requires an explicit spoken agreement after the current complete summary. A trip change requires a new summary and consent.
- Persist the action key, target and exact payload before sending a booking. Reuse them on uncertain retries, including after restarts.
- A successful submission still needs driver approval. Read current status separately.
- Keep concurrent calls isolated. Use one server process per session volume; do not deploy replicas with this file store.
- Preserve provider call and tool IDs in central logs and configure final-report retries.
- Never commit .env, .local state, transcripts, personal staging data or credentials.

## Handoff

Record changed behavior, checks, dependencies and the next step in the relevant pull request or repository document. Do not mark live phone or staging acceptance complete based on simulated tests.
