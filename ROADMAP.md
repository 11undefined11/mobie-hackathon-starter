# AI Slop mobie Hackathon Roadmap

Build a German-speaking telephone assistant that resolves travel locations, finds a suitable mobie ride, and submits a real booking request only after the caller explicitly agrees. Deliver complete call history and explain that the driver must still approve the request.

This plan assumes two people working within the challenge's 24-hour build window. Hours below are elapsed team time, not a submission deadline. Confirm the actual deadline with the organizers. Suggested ownership can be swapped according to experience; at least one team member must speak German.

## Two person ownership

| Work | You | Collaborator |
| --- | --- | --- |
| Primary responsibility | Server integration, trusted caller identity, conversation state, booking consent and retries | Telephone provider configuration, German dialogue, location resolution and evaluation scenarios |
| Initial file ownership | New provider adapter and session modules; changes to `src/server.js` and server tests | New dialogue and location modules; changes to `src/mapbox.js`; provider configuration documentation and location tests |
| Shared decisions | Agree on tool inputs, outputs and error responses before implementation | Agree on provider, location source, spoken confirmation wording and test region |
| Review responsibility | Review provider identity handling and location tool integration | Review consent wording and perform German phone tests |
| Final delivery | Deployment configuration and architecture description | Demonstration call, evaluation results and known limitations |

Keep the existing starter API as the foundation. Coordinate before editing the same file; one person owns each task and the other reviews it. Neither person needs to rebuild the proxy, authentication or call-log delivery already supplied by the starter.

## Shared GitHub and Codex workflow

Use one team-controlled GitHub repository that both GitHub accounts can access. Confirm write access before development; use a team fork or copy if you cannot write to the organizer's starter repository. Do not commit credentials when preparing it.

Each person opens their own checkout in their own Codex account. Use GitHub issues, commits and pull requests to transfer decisions and progress. Put all information needed to resume a task in the repository or its issue; do not rely on the other person's chat history or local folder being available.

1. Create one issue for each task in the backlog below. Assign one owner, a milestone and the stated acceptance condition.
2. Use separate branches, such as `feature/provider-adapter` and `feature/german-dialogue`. Keep changes small enough for the other person to review quickly.
3. In each Codex task, name the issue, allowed files, agreed API contract and acceptance condition. Include relevant README and documentation references.
4. Before a handoff, record the commit, changed behavior, checks run, unresolved blockers and next step in the issue or pull request.
5. Merge reviewed changes at the integration checkpoints. Pull the shared branch before starting the next dependent task.
6. Configure each developer's local `.env` privately. A separately running server uses its own local `STARTER_API_KEY`; provider requests must use the key for the server they target. Keep the organizer-issued team secret server-side.

Proposed team convention: add a short `AGENTS.md` during milestone 1 with the shared commands, file ownership and consent rules. This repository convention is consistent with [official OpenAI documentation on development workflows](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex).

## Starting conditions

Conversation checkpoint on 7 November 2026: the live dialogue still asks for
identity, loses caller spelling corrections and announces results that have not
been verified in this server's actual-call state. Saved sessions contain the
scripted readiness checks, not an address lookup from the reported call.
Connector counters show many HTTP 401 responses; verify the configured Vapi
tool URLs and the running server's local Bearer credential before retesting.
The current credential succeeds in a controlled profile lookup. Real geocoder
checks resolve both Muthgasse and the variant Mutgasse to Muthgasse 24, 1190 Wien;
the claimed 1160 address was not returned by those checks.

A complete replacement German prompt is in `docs/vapi-system-prompt.txt`, with
updated tool descriptions in `examples/vapi-tools.json`. It requires real tool
results, server-derived identity, preserved localities and fresh lookups after
spelling corrections. The server now rejects confirmation of an old candidate
after an explicit spelling correction until a new lookup runs. All 59 tests
pass on Node 24. These are prepared repository changes; the dashboard prompt,
published assistant version and credentials still need to be checked and the
real conversation repeated. No live booking acceptance is claimed.

Browser checkpoint on 7 November 2026: the team chose Vapi browser calls.
Organizer-assigned web passenger access was verified, and
`VOICE_ALLOW_WEB_CALLS=true` was enabled only in the ignored local environment.
A temporary Cloudflare HTTPS connection was started and checked: public health
returns 200, unauthenticated API access returns 401, a phone-less Vapi-shaped
caller lookup succeeds, and the web passenger's search finds one matching ride
for 7 November at 19:20 Vienna time from Muthgasse 24 to Stephansplatz.
No booking was submitted. Current temporary URLs are in
`.local/https-connection.json`; keep both the local server and connector running.
The next joint step is entering those URLs and the starter credential in Vapi,
then an actual microphone conversation, refusal test and complete call-history
verification. Telephone-specific acceptance has not been exercised.

Integration checkpoint on 6 November 2026: the collaborator branch
`codex/windows-setup-fix` is reconciled with `feature/server-integration`.
The public Vapi tools now follow one contract: `get_caller_profile`,
`find_location`, `confirm_location`, `search_rides`, `prepare_booking`,
`confirm_booking` and `get_booking_status`. Transcript-based German consent
uses the collaborator's conversation flow; saved actions, caller binding and
restart recovery use the shared server engine. Both test suites are retained.
See [the current integration handoff](docs/provider-adapter.md) for the canonical
configuration and earlier state-format handling.

Current verification: all 57 tests pass on Node 24. The merged server starts on
Node 24; the local page and health route return 200, unauthenticated API access
returns 401 and invalid Vapi metadata returns 400. The organizer credential is
configured privately and local configuration and storage checks pass. The
registered passenger was recognized by staging. Real permanent-geocoding lookups
resolved Muthgasse 24 and Stephansplatz in Vienna, and a future-dated search using
those coordinates returned HTTP 200 with zero matching suggestions. No booking
was submitted. A known future staging ride is needed for positive-match
acceptance. The team chose local testing before public HTTPS setup.

The repeatable local rehearsal is also complete: `npm run rehearse:local` passes
five checks across confirmed, declined and lost-response conversations, including
current status pagination and delivery of all 29 tool events plus three complete
final call reports to a local backend. Its aggregate report is saved privately to
`.local/rehearsal-report.json`. These use synthetic data and do not establish live
provider, geocoder or staging acceptance. See [local rehearsal and setup](docs/local-rehearsal.md).

| Task | Current checkpoint | Remaining acceptance |
| --- | --- | --- |
| R1 | Setup repair and Windows regression checks complete | None for local setup |
| R2 | Organizer credential, registered passenger lookup and location access verified | Known future staging fixtures, second passenger and approved driver |
| R3 | Shared tool definitions, ownership and merged contract written | Joint review of the canonical Vapi configuration |
| R4 | Public HTTPS, authentication and phone-less Vapi-shaped requests verified | Actual Vapi browser conversation through the configured tools |
| R5 | Real Vienna address lookups verified; spoken location guards integrated | Wider Austrian ambiguity and POI cases, then real phone confirmation |
| R6 | Real staging search returned 200 with no matches; caller isolation tested locally | Find a known future seeded ride, then repeat over a phone call |
| R7 | German summary and conservative transcript consent integrated | German speaker review during the real browser conversation |
| R8 | Confirmed actions, duplicate suppression and restart retries tested | One real stored request after consent, none after refusal |
| R9 | Tool logging and final reports verified together in the local rehearsal | Verify complete history in the central staging view |
| R10 | Tests, local rehearsal, one positive staging match and temporary HTTPS verified | Actual browser dialogue, remaining evaluation routes and submission |

The earlier entries below record the initial setup and first implementation
checkpoints; they do not replace the current merged contract above.

Implementation update on 6 November 2026: R1 is repaired and locally verified.
The server portions of R3, R4, R6 and R8 are implemented on
`feature/server-integration`, including Vapi tool handling, isolated persistent
call state, candidate-based search, consent summaries and durable booking retries.
Shared contracts, tool definitions, deployment configuration and the collaborator
handoff are in [Vapi server integration](docs/provider-adapter.md). R4, R6 and R8
still need live provider and staging acceptance; R3 needs collaborator review.
R9 and R10 remain joint/live verification work. The checks below describe the
initial baseline before the setup repair.

Verification after implementation: all 38 automated tests pass on Node 24 and
the installed Node 26 runtime. The local starter key is now configured; the
organizer secret is still missing. The container build could not be verified
because the local Docker engine is not running. No live call or staging booking
has been verified.

Local checks on 6 November 2026 found 23 of 24 starter tests passing on Node 26.5.0. The setup test fails because the generated local key remains blank. Running `npm run setup` also leaves that key blank in this checkout. Investigate template line endings first: setup splits template entries on `\n`, which can leave `\r` on Windows. Confirm the cause before changing code. Use Node 24 LTS for the build, matching the README recommendation; CI covers Node 22 and 24.

At the initial baseline, `.env` had been created and ignored by Git, but both the local starter key and organizer team secret were blank. Setup success output alone is not proof that startup or upstream access works.

The organizer's six evaluation rides are dated 18–24 October 2026, which is past as of this plan. Ask for refreshed dates or approval to recreate equivalent routes on future dates. Do not use these past timestamps as search fixtures. Interpret trip times in `Europe/Vienna` with the correct offset for the chosen date.

## Milestones over 24 hours

| Hours | You | Collaborator | Exit condition |
| --- | --- | --- | --- |
| 0–2 | Resolve setup failure; use Node 24; establish the shared repository and task contracts | Confirm team access, provider access and German speaker; arrange passenger and approved driver accounts with a vehicle | Setup generates a key and preserves it on rerun; automated checks pass; `/api/caller` resolves a registered passenger |
| 2–5 | Build provider tool adapter with trusted caller metadata and per-call state; expose HTTPS endpoint | Configure phone number and German voice; implement location candidate lookup and clarification dialogue | One actual phone call reaches caller lookup and location search with a consistent call ID |
| 5–9 | Connect ride search; validate seats, future time and confirmed coordinates; retain original passenger trip | Implement trip collection, ambiguous place follow-ups, candidate confirmation and concise result presentation | A German call searches a seeded ride using confirmed locations and the correct date, time and seats |
| 9–13 | Implement guarded booking, persisted action keys and booking status lookup | Implement spoken trip summary, explicit consent, refusal and pending approval wording; configure final reports | Confirmed call creates exactly one backend request; declined call creates none; complete transcript and tool results reach central history |
| 13–18 | Test timeouts, duplicate submissions, caller isolation and API errors | Seed two additional challenging rides; test organizer routes with refreshed dates and Austrian place names | Required scenarios pass and any failures have an owner and reproduction steps |
| 18–21 | Fix integration failures and verify final-report retry behavior | Refine German dialogue and repeat full calls, including unknown and ambiguous callers | Two distinct registered callers complete isolated flows; no cross-call trip or booking state leaks |
| 21–24 | Freeze features; verify HTTPS deployment, restart behavior and clean configuration | Rehearse demonstration; finalize test results and limitations | Working phone number, reproducible setup, architecture description and submission materials are ready |

Hours 5, 9, 13 and 21 are joint integration checkpoints. If time slips, defer optional features and protect the final three hours for verification and delivery.

## Architecture and shared contracts

```text
Caller
  -> telephone provider with German speech
  -> trusted team adapter with per-call state and consent checks
  -> existing starter /api routes
  -> mobie /integrations/voice

Location tools -> geocoder or POI source -> confirmed named coordinates
Provider final report -> starter log endpoint -> mobie central call history
```

The starter accepts local HTTP requests; it does not implement provider-specific tool envelopes. Its `/vapi/events` endpoint handles event reports, not tool execution. Implement the tool adapter explicitly.

Agree on these contracts before parallel work:

- **Caller context:** derive `X-Mobie-Caller-Phone` and `X-Mobie-Call-Id` from trusted provider metadata. Model arguments and spoken phone numbers cannot set identity. Namespace or map provider IDs if needed to meet the API's character and uniqueness rules, and use the same mapping in reports.
- **Trip:** retain departure and destination as `publicName`, numeric `longitude` and `latitude`, plus optional `addressLine`; a future ISO timestamp with an explicit offset; and an integer seat count from 1 to 8. Ask callers to resolve ambiguity and confirm the chosen locations.
- **Conversation state:** index by call ID; retain confirmed locations, selected `ride.id`, consent for that exact trip and the associated action record. Changing a trip or ride invalidates previous booking consent. Keep concurrent callers isolated.
- **Booking:** summarize pickup, destination, time, seats and available price. An unknown price must be described as unknown. Only explicit spoken agreement permits `confirmed: true`. Save the action key, target and exact payload before sending; persist them so a retry or restart reuses the same action. A new confirmed action gets a new key.
- **Results:** answer pre-booking questions from the search suggestion and preserve the passenger's searched locations, which can differ from driver route endpoints. A submitted request is pending driver approval. Query `/api/bookings/{bookingId}` for a known booking; when listing bookings, follow `nextPage` until null, including across empty pages.
- **Locations:** use a geocoder or POI source that permits storing results in mobie and preserve attribution. Mapbox's demonstrated permanent geocoding needs an eligible account and covers addresses and places rather than POIs. Verify landmark and airport support before committing to a source.
- **Logs:** preserve call IDs, provider tool IDs and ordered messages. Automatic starter tool logs do not replace the provider's final transcript report. For Vapi, enable `end-of-call-report` and `status-update` on `/vapi/events`; for another provider, normalize and send `PUT /api/calls/{callId}`. Configure report retries or replay; the starter has no durable upload queue.

## First tasks for GitHub

These are proposed issues to create in the shared repository.

| ID | Task | Owner | Depends on | Acceptance condition |
| --- | --- | --- | --- | --- |
| R1 | Repair and verify local setup | You | None | Fresh setup generates a valid local key, repeated setup preserves it, and tests cover Windows line endings |
| R2 | Establish team access and future test rides | Collaborator | Organizer access | Registered callers, approved driver and vehicle are ready; current evaluation dates agreed; two additional difficult routes documented |
| R3 | Agree on tool contracts and shared instructions | Both | None | File ownership, trip fields, errors, consent and retry rules are written in the repository |
| R4 | Connect provider tool requests | You | R1, R3 | Real provider call reaches authenticated starter routes using trusted metadata |
| R5 | Resolve and confirm locations in German | Collaborator | R3 | Ambiguous locations trigger a follow-up; confirmed named coordinates are returned; source permits storage |
| R6 | Search rides with isolated call state | You | R2, R4, R5 | Correct ride found for a future trip; two concurrent calls retain separate state |
| R7 | Finish German booking conversation | Collaborator | R3, R5 | Trip and price summary precedes explicit consent; refusal and no-result cases are handled |
| R8 | Guard booking and recover retries | You | R6, R7 | Confirmation creates one real pending request; timeout retry reuses persisted key and payload |
| R9 | Deliver and verify complete call history | Collaborator, reviewed by you | R4 | Final transcript, ordered messages and tool results appear centrally; failed report delivery can be replayed |
| R10 | Run evaluation and prepare delivery | Both | R2, R6, R8, R9 | Required phone scenarios pass and architecture, limitations and access instructions are ready |

## Evaluation and completion checks

Use separate staging passenger and driver accounts. The collaborator's Codex and GitHub accounts enable development collaboration; mobie test identities and provider access must be arranged separately. Register two distinct passenger numbers to test caller isolation. Browser calls without a number require an organizer-assigned web test user.

| Scenario | Required result |
| --- | --- |
| Six organizer routes | Confirm updated future dates, resolve intended locations and find the corresponding rides |
| Two additional difficult rides | Record future date, local time, start and destination with postal codes, spoken ambiguity and how clarification resolves it |
| Explicit yes after full summary | One booking request is stored; assistant accurately states pending driver approval |
| No, hesitation or changed trip | No write until a fresh explicit agreement to the current action |
| Timeout or repeated tool call | Same confirmed action key and payload; no duplicate request; current status checked separately |
| No suitable rides | Explain the result and offer changes; any open ride request needs separate consent |
| Unknown, private or ambiguous caller | Explain the access issue without using another passenger account |
| Concurrent calls from two passengers | Separate locations, ride choices, consent, actions and booking results |
| Missing price or changed availability | No invented price or guaranteed seat; explain failure and ask what to do next |
| End of call and failed report delivery | Complete report reaches central history with stable IDs after retry or replay |

Design the two additional rides around distinct challenges: one should use a spoken landmark entrance and a station destination; the other should use a street name shared by multiple towns and require a locality follow-up. During R2, choose actual routes, verify complete addresses, postal codes and precise pickup points with the location source, and record future dates before seeding them. These scenario ideas become evaluation fixtures only once those details are filled in.

The final submission must include a reachable phone assistant, a successful real staging booking request, complete call history, the two extra ride definitions, and a short architecture and API usage description with known limitations. Record evidence through approved staging views; keep transcripts, personal test data and credentials out of commits and public screenshots.

## Optional work after the core flow passes

Add an Austrian street-name transcription matcher, saved-place shortcuts, or separately confirmed open requests, withdrawal and cancellation only if the required flow and logs already work. Document the matcher's geographic boundary and how outside requests are handled; a restricted matcher cannot receive the highest matcher evaluation. A new dashboard is lower priority than reliable phone interaction.

## Project references

- [Setup and project overview](README.md)
- [Challenge and evaluation](docs/challenge.md)
- [Caller identity, search payloads, consent and retries](docs/voice-integration.md)
- [Local API contracts](docs/api.md)
- [Authentication and team access](docs/authentication.md)
- [Required call history and report delivery](docs/call-logs.md)
