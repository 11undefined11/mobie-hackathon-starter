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

Local checks on 6 November 2026 found 23 of 24 starter tests passing on Node 26.5.0. The setup test fails because the generated local key remains blank. Running `npm run setup` also leaves that key blank in this checkout. Investigate template line endings first: setup splits template entries on `\n`, which can leave `\r` on Windows. Confirm the cause before changing code. Use Node 24 LTS for the build, matching the README recommendation; CI covers Node 22 and 24.

The local `.env` has been created and is ignored by Git. Both the local starter key and organizer team secret still need to be configured. Setup success output alone is not proof that startup or upstream access works.

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
