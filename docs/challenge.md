# mobie Voice AI Challenge

## Short description

Build a solution using an AI phone assistant of your choice in 24 hours. It should understand German-speaking callers' travel needs, resolve start and destination using Mapbox or another geocoding or point-of-interest (POI) search service, find suitable rides and submit a real booking request through the mobie REST API after explicit confirmation. Optionally, develop a matcher that identifies and corrects mistranscribed Austrian street and place names.

## Your task

Connect a phone-accessible AI assistant to the mobie staging API. Collect the caller's starting point, destination, travel date and time, and required seats. Resolve locations unambiguously, ask follow-up questions when needed, and send their coordinates to the ride search. Explain the results and answer questions using the returned ride information.

Once the caller selects a ride, summarize the ride, pickup location, destination, time, seats and available price information. Submit the booking request only after explicit confirmation. The request must actually be stored in the backend. The driver still needs to approve it, so communicate the pending status accurately.

Use Mapbox or another geocoding service, POI search API or suitable location dataset, with your own account or credentials where required. Mapbox is optional: the starter demonstrates address and street geocoding, and you can extend or replace it to search for landmarks, stations and other points of interest. Send the resolved coordinates to mobie. Your data source must permit storing location data in mobie. You choose the phone platform, conversation design and implementation. At least one team member should speak German.

An additional matcher for transcription errors is optional. The phone assistant can call your server for this step; use actual location data and, when necessary, a follow-up question to decide which coordinates to send to mobie. You may limit your matcher to a smaller region or specific districts. Describe the exact geographic boundary, why you chose it and how the assistant handles requests outside it. A geographically restricted matcher is valid, but cannot receive the highest matcher evaluation.

You will receive access to the mobie staging app and an organizer-approved team integration secret for the dedicated voice API. Create test accounts and rides in staging; use separate driver and passenger accounts. Drivers need the appropriate approval and a vehicle before offering rides.

Your telephone service calls `/integrations/voice` with its team secret, a trusted caller number and call ID. Mobie resolves the registered passenger on every request. Browser tests without a number require an organizer-configured web test user and the corresponding backend rollout. See [voice-integration.md](voice-integration.md) for setup and examples. This replaces the shared, browser-signed-in passenger approach for the new integration. The repository's existing JavaScript starter remains a legacy Auth0 implementation until your team migrates its client.

## Evaluation

The following organizer-provided rides, plus at least two additional rides designed and created by your team, will be used for evaluation. Dates and times are in Austrian local time. Each listed ride offers four seats.

| Date | Time | Start | Destination |
| --- | --- | --- | --- |
| 2026-10-18 | 15:00 | Muthgasse 24, 1190 Wien | Stephansplatz, 1010 Wien |
| 2026-10-19 | 15:00 | Villagarten 4, 4221 Steyregg | Bethlehemstraße, 4020 Linz |
| 2026-10-20 | 15:00 | Muthgasse 24, 1190 Wien | Hauptstraße, 2531 Gaaden |
| 2026-10-21 | 15:05 | Stephansplatz, 1010 Wien | Karlsplatz, 1040 Wien |
| 2026-10-22 | 15:05 | Gartenstraße, 6832 Sulz | Gartenstraße, 6833 Klaus |
| 2026-10-24 | 15:05 | Muthgasse 24, 1190 Wien | Flughafen Wien-Schwechat, 1300 Schwechat |

Create at least two further rides with comparably challenging locations or spoken descriptions, even if your matcher covers only a small region or district. Straightforward rides chosen merely to fit that boundary do not satisfy this requirement. For each, provide its date, time, start and destination (including postal codes), and explain what makes the case difficult and how your assistant resolves it. Evaluation will consider whether the assistant identifies the intended locations, finds the appropriate ride and submits a booking request only after the caller explicitly confirms it.

Submit a working phone assistant and a short description of its architecture, API usage and known limitations. Access details, the staging app, phone service and credit arrangements, and the submission deadline will be provided separately.
