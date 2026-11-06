# Central call logs: push from the team server

Call logging is part of the hackathon integration. The starter sends logs to
mobie using your existing `VOICE_INTEGRATION_SECRET`. No additional backend log
credential or polling job is needed. The admin portal can attribute the calls
to your team from that secret.

```text
Telephone provider → team starter → mobie backend → admin call history
                  final reports    PUT call/tool logs
```

## What happens automatically

Every supported starter API operation carrying a valid `X-Mobie-Call-Id` pushes
a tool event with its name, arguments, result, success/failure, timestamp and
duration. This includes caller lookup, search, booking and geocoding; operations
without a valid call ID cannot be attached to a call. Errors such as an unknown
or ambiguous passenger are logged without requiring a successful caller lookup.

Send the provider's tool ID as `X-Mobie-Tool-Call-Id` when available. It accepts
1–128 letters, digits, `_` or `-`. This lets exact API results and provider report
tool entries share an ID. Otherwise the starter generates a UUID for each HTTP
operation. **This is separate from the booking `Idempotency-Key`.**

The backend also records basic activity on successful voice requests. Full spoken
conversation content must arrive from your telephone provider; it cannot be
reconstructed from ride searches alone. Configure final report delivery as below.

## Vapi setup

1. Expose the running starter over HTTPS.
2. In your Vapi assistant's **server/event URL**, set
   `https://<your-starter>/vapi/events`.
3. Attach an HTTP Bearer credential containing your local `STARTER_API_KEY`.
   Do not use `VOICE_INTEGRATION_SECRET` or the Vapi account API key here.
4. Enable the `end-of-call-report` and `status-update` server messages. Make sure
   the provider includes the transcript and conversation messages in its report.
5. Keep the same `call.id` in events and in `X-Mobie-Call-Id` on your API calls.

The starter accepts Vapi's `{ "message": { "type": "end-of-call-report", ... } }`
envelope, normalizes metadata, transcript, ordered messages and included tool
calls, then pushes them to mobie. Status updates are interim reports. System
prompts/assistant configuration are excluded from the stored conversation.
This endpoint receives events; it is not a Vapi tool-call adapter.

A successful event delivery returns HTTP 200 **after** the backend accepts the
report. Unavailable backend delivery returns 503 so the provider can retry.
Ensure your provider retries failed delivery or resend the saved final report
from your own server. Repeat the same call/tool IDs; do not invent new IDs on retry.

## Other providers, including Fonio

Your trusted provider adapter converts its final conversation into the shared
JSON format and submits it to the starter:

| Method | Starter route | Result |
| --- | --- | --- |
| PUT | `/api/calls/{callId}` | Forward a normalized call report; 204 after persistence |
| PUT | `/api/calls/{callId}/tools/{toolId}` | Forward a tool event performed outside the starter; 204 after persistence |

Both routes use `Authorization: Bearer <STARTER_API_KEY>` and
`Content-Type: application/json`. No caller phone header is needed for log uploads,
so private/unknown callers can still have conversation history. The log endpoints
grant no account or ride actions. Provider-native Fonio envelopes are not parsed
automatically: normalize them in your adapter using the format below.

See [examples/call-report.json](../examples/call-report.json) for a complete sample.
Replace the sample ID and timestamps with the actual provider values; the body
`call.id` must match the route ID. For example:

```json
{
  "call": {
    "id": "team-call-unique-id",
    "type": "webCall",
    "transcript": "Anrufer: Hallo!\nAssistent: Wohin möchtest du fahren?"
  },
  "messages": [
    { "seq": 0, "role": "user", "text": "Hallo!", "secondsFromStart": 0 },
    { "seq": 1, "role": "assistant", "text": "Wohin möchtest du fahren?", "secondsFromStart": 1 }
  ],
  "toolCalls": [],
  "reportReceived": true
}
```

- `call`: metadata with matching `id`; include actual `startedAt`/`endedAt` ISO
  timestamps, `type`, and provider `customerNumber` when available. Optional
  fields include `assistantId`, `endedReason`, `model`, `voice`, `transcriber`,
  nonnegative `cost`, `recordingUrl` and `transcript`.
- `messages`: ordered entries with unique nonnegative `seq`, `role`, `text`, and
  optional finite `secondsFromStart`/`time`. Additional structured data goes in
  `data`. Omit system prompts and provider configuration.
- `toolCalls`: optional entries with `toolCallId`, `name`, `arguments`, `result`,
  `ok`, nonnegative `ms` and an ISO timestamp `at`. For a direct tool PUT the ID
  is already in the URL; `name` is required. Starter API events are uploaded
  automatically, so do not invent duplicate IDs for them.
- `reportReceived`: `true` for a complete final report, `false` for interim updates.

The backend merges repeated IDs without creating new calls. Keep message sequence
numbers stable on retries. A delayed interim update cannot erase an existing
final report. Call IDs must be globally unique across teams; a collision with
another integration returns 409.

The [Postman collection](postman_collection.json) includes a manual final-report
upload to the starter. Its log request uses the local starter credential; the
ride requests in that collection call mobie directly and bypass automatic starter
tool logging.

## Backend delivery and operational limits

The starter translates the two PUT routes to
`/integrations/voice-log/calls/{callId}` and
`/integrations/voice-log/calls/{callId}/tools/{toolId}`, authenticating with the
team integration secret. The backend derives team attribution from the secret.

Tool log uploads run asynchronously so a logging outage cannot change a successful
booking or delay its response. Uploads retry transient failures (network, 408,
429, 5xx) up to three attempts with the same path/body. Permanent 4xx errors are
returned without retry. Final reports return 503 after transient exhaustion.

Reports are limited to 8 MiB; ordinary business requests remain limited to
16 KiB. At most 256 uploads are in flight. There is no durable disk queue: a
restart can interrupt pending tool uploads. Configure provider final-report
retries/replay; exhausted tool delivery is reported on the server's stderr.
The backend remains responsible for persistence and configured retention.

Configured team/local credentials and recognizable credential fields are redacted
before upload; HTTP authentication headers are never recorded as tool arguments.
Keep personal conversation data and secrets out of Git and public debugging output.
Audio remains with the provider; recording playback for a separate team provider
account requires organizer support and is independent of transcript/tool storage.
