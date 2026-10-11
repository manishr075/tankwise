# Devin execution brief — Tankwise (hackathon final day)

You are the senior full-stack engineer and delivery owner. Work directly in the provided `tankwise-starter` repository. Do not return only advice, a plan, or code snippets: inspect the actual files, run the app and tests, implement/fix the project, verify it, and leave a demo-ready result plus exact human steps for anything you cannot do because credentials or platform access are missing.

## Goal

Finish **Tankwise**, a credible environmental-hackathon MVP for one hostel/PG/housing building. It helps a caretaker decide when to book the next water tanker using tank stock, daily consumption, supplier lead time, roof catchment and rainfall forecast. Its key differentiator is a transparent day-by-day water balance with a visible **no-rain stress test** and a saved decision history. Do not turn it into a generic environmental dashboard or chatbot.

## Hackathon constraints

- Time left is approximately one day. Prioritize one complete, reliable end-to-end workflow over breadth.
- Judges assess idea/impact, actual AWS use, design/usability, execution, and the demo. The demo video is limited to three minutes; unshown functionality does not count.
- The project must genuinely use AWS, and the submitted video must visibly show it. Do not fake an AWS connection, database write, weather call, output, screenshot or metric.
- Local preview is acceptable for development but must be clearly labelled. If the deployed AWS API is not configured or does not work, say so and provide the exact remaining action; never represent local storage/calculation as AWS.
- AI coding assistants are permitted by the rules; document Devin and any other AI tools in the submission write-up.
- Keep the scope small. Do not add a chatbot, multi-agent system, user accounts, IoT hardware, ML predictions, maps, payments, or a complex admin console.

## Start by inspecting and verifying the repository

1. Read `README.md`, this prompt, `frontend/src/engine.js`, `backend/water_balance.py`, `backend/app.py`, and `template.yaml`.
2. Run frontend tests (`cd frontend && npm install && npm test`) and backend tests (`cd backend && python -m unittest discover -s tests -v`). Fix every test or build failure. Build frontend with `npm run build`.
3. Check that the JavaScript and Python water-balance outputs agree on shared test scenarios. Add a parity test or a small script if useful. Do not casually change formulas in only one implementation.
4. Inspect the UI in a real browser where available at desktop and mobile widths. Correct functional bugs, overflow, confusing labels, broken forms, stale data, or visual defects.
5. Validate the SAM template. If AWS credentials are available and authorization permits, deploy to `ap-south-1`, test the real health/simulation/save/history paths, and configure the frontend. If credentials are not available, do not stall: complete all local work and give only the exact commands / AWS actions that I must perform.

## Required end-to-end flow

A judge must be able to:
1. View an example building and immediately understand the problem.
2. Change tank stock, capacity, daily usage, roof area, collection efficiency, supplier lead time and required safety stock.
3. Fetch a real 7-day rainfall forecast from Open-Meteo for the entered latitude/longitude, with source/status clearly displayed. If the request fails, show an honest error and keep the last known values; do not relabel sample data as live.
4. Recalculate and inspect a day-by-day tank timeline and booking window.
5. Compare forecast rainfall with a no-rain stress case, seeing both the latest order window and safety-buffer warning.
6. Save the exact input + calculated output and reload recent records from DynamoDB when AWS is connected. In local preview mode, local browser storage is acceptable only when explicitly labelled as browser-only.
7. See trustworthy states for loading, success, invalid inputs, unavailable weather, unavailable AWS and failed saves.

## Engineering requirements

- Keep the model deterministic and transparent. One millimetre of rainfall on one square metre equals one litre before collection losses: `potential_litres = rain_mm * roof_area_m2 * efficiency`.
- Daily demand is subtracted before rain capture is added. Make the assumption visible. Track shortages and overflow separately; stock cannot fall below zero or exceed tank capacity.
- Reject invalid inputs, including stock/capacity inconsistency, negative rain, efficiency outside 0–1, invalid lead times and safety stock above capacity.
- Show a no-rain scenario. Forecast rainfall is uncertain and collected rain is not guaranteed. Never imply that collected rain is potable.
- Clearly define the meaning of “latest order window,” account for the supplier lead time, and test edge cases (lead time zero, water already below reserve, no forecast days, no-rain, extreme rain, tank overflow, demand exceeding stock, and a safety buffer above current stock).
- The suggested top-up quantity is an estimate, not a guaranteed tanker order. Show its target assumption and don't imply it knows local supplier sizes. If needed, rename it “estimated top-up to target stock”.
- Ensure Lambda recomputes the result on save rather than trusting a client-supplied result.
- Use API Gateway + Lambda + DynamoDB in a real working path. The frontend must distinguish `AWS + DynamoDB connected`, `AWS API offline`, and `Preview mode` correctly. Health should verify DynamoDB when configured.
- Handle API Gateway CORS and HTTP error responses. Never expose stack traces, credentials, API tokens or secrets in client-visible errors.
- DynamoDB records should include building ID, timestamp, input, output and forecast source. History should return recent records in descending timestamp order. Avoid overwriting records due to timestamp collisions if multiple saves happen quickly.
- Make UI controls keyboard usable, labelled, responsive, and readable. Avoid decorative features that do not help make the water decision.
- No false impact claims. If actual delivery/outcome observations are not implemented, state that the current history logs decisions only and do not say it already measures savings or improves prediction over time.
- The project needs a clear known-limitations section in README and submission write-up.

## Judge-facing polish

Make the main decision the visual focal point. A first-time user should understand within five seconds: current stock, latest safe booking window, estimated top-up, what rain changes, and what happens in the no-rain case. Use plain language; no wall of text. The app should feel like a purposeful water-operations tool, not a generic template dashboard.

Do not overfit on animation or graphics. Prioritize accuracy, consistency, responsiveness, legibility, loading/error states and evidence behind the recommendation. Verify the top summary numbers match the chart/model and update whenever input changes and recalculation succeeds.

## Security and cloud rules

- Never ask the user to paste long-lived AWS secrets into chat or commit them to Git.
- Never place AWS credentials in frontend bundles or client-side environment variables.
- Review the SAM changeset before deploying resources. Use the least privilege needed for the DynamoDB table.
- If deploying, confirm the API URL output, `GET /health`, `POST /simulate`, `POST /records`, and `GET /history?building_id=...` with real responses. Verify a saved record exists in DynamoDB.
- Do not claim successful deploy or API integration unless you actually verified it.
- In final handoff, report which tests/builds ran, their results, what was actually deployed and verified, what remains unverified, and the exact next command(s) I need to run. Keep it factual and concise.

## Deliverables before stopping

1. A fixed, buildable, tested app in this repository.
2. Correct and consistent calculation behavior across frontend/backend.
3. Working deployment configuration and updated commands in README.
4. A short submission write-up draft: problem, target user, what was built, differentiated mechanism, real AWS services used, AI tools used, test/demo data, and limitations.
5. A demo script under 3 minutes with clear screen-by-screen actions, including a visible genuine AWS-backed request/save when deployed.
6. A short final checklist separating `verified`, `not verified`, and `requires my action`.

## Do not stop to ask me routine implementation questions

Use sensible defaults, finish what can be done independently, and list only genuinely blocking questions/action items at the end. Make a strong engineering decision, verify it, and explain trade-offs briefly. The owner will review changes and request modifications if needed.
