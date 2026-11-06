# Server readiness and booking recovery

Use these server checks while the German dialogue, staging fixtures and Vapi configuration are being completed. They do not require the collaborator's implementation and do not place live bookings.

## Check a deployment locally

Run `npm run check:deployment` from the project folder with the intended private environment configured. In the container, the same command uses the container environment; a local `.env` file is optional.

The command checks the Node runtime, validates server configuration, and writes, reads and removes a private temporary probe in the session directory. It never reads saved call contents or prints credential values. Exit status 1 means a required local check failed. Warnings identify checks that need operator or live verification.

Use Node 24 LTS for deployment. Node 22 or newer passes the minimum runtime requirement, with a warning for versions other than 24. A configured Mapbox token establishes presence only; a collaborator-provided location service may be used instead. The storage probe verifies local access, not persistence through redeployment or exclusive ownership by one process.

Successful local readiness does not establish a reachable HTTPS address, valid upstream credentials, a registered passenger, provider authentication, geocoder eligibility, driver approval or complete central call history. Those require the joint live acceptance steps in [the integration handoff](provider-adapter.md#acceptance-and-remaining-external-work).

## Recover an uncertain booking

If a booking tool times out or the process stops before its response arrives, preserve the session volume. Restart with the same team integration and state directory, then retry `confirm_booking` using the original call metadata. The adapter restores the prepared summary, recorded consent, saved key, target and exact payload.

Do not delete the session, choose a new ride or generate a new action key to bypass an unresolved booking. The upstream write may already have succeeded. Once the original action returns its result, query current booking status separately; the original submission result does not establish the driver's latest decision.

If the volume is unavailable or its contents cannot be parsed, restore access or restore the correct saved state before retrying. An identity mismatch is rejected rather than treated as a fresh session. If the action record is lost, inspect the caller's bookings with the organizers before considering any new confirmed action. An empty status list alone does not prove that an earlier write failed.

## Preserve state through upgrades

Call-state filenames are SHA-256 hashes of the exact, case-sensitive call ID. This keeps `Call-A` and `call-a` separate on Windows and avoids reserved filenames. The original call ID remains inside the private state record and must match when loaded.

Existing records named directly after call IDs remain readable when their stored identity matches exactly. Saving an existing record creates the hashed version; a newer hashed record takes precedence over an older legacy copy. Keep both formats in backups until retention cleanup is agreed, and never restore just a stale legacy copy over the current action history.

Run one process per volume. Back up the complete session directory during a controlled stop so no action record is changing during the copy. Restore it privately with the required filesystem permissions. Do not commit or share this directory through GitHub: it contains caller and trip data.

## Verification available without live access

The local suite exercises separate callers, case-sensitive IDs, refusal, stale summaries, saved-state corruption, unavailable storage, unchanged retry keys and actual child-process exit after a controlled backend side effect. It also checks that failed queued work releases its call lock while other calls continue.

Run `npm test` after server changes. These controlled tests do not charge the provider or write to staging. The Docker image still requires a running Docker engine for build verification; these checks do not start Docker Desktop or publish a deployment.

On 6 November 2026, all 46 automated tests passed on Node 24 after these changes. The local readiness probe confirmed readable and writable session storage. Deployment configuration still fails because the organizer secret is missing; location access and live Vapi, HTTPS and report delivery remain to be verified with the team.

At the later integration checkpoint on 6 November 2026, all 56 combined tests
passed on Node 24. The organizer credential was configured privately; local
configuration and storage checks then passed. Local Node 24 startup, the page,
health and authentication guards were verified without staging requests.
Location-service access and joint live acceptance remain outstanding. See
[the current roadmap checkpoint](../ROADMAP.md#starting-conditions).
