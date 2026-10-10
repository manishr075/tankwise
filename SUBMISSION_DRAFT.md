# Tankwise — submission draft

> Edit the bracketed parts. Only keep the AWS sentences marked [AFTER DEPLOY] once you have seen a real save in DynamoDB.

## Problem
Hostel and PG caretakers in water-stressed cities book private water tankers by gut feel. Tank stock, daily use, supplier lead time and possible rain are separate numbers, so tankers get booked too late (the building runs dry) or too early (paying for water while rain could have refilled the tank).

## Target user
The caretaker or warden of a single hostel, PG or housing building with an overhead/sump tank, a tanker supplier, and a rooftop rainwater connection.

## What we built
A web app that answers one question: *by which day must we book the next tanker?*
- Inputs: water in tank, tank capacity, daily use, roof area, collection efficiency, supplier lead time, safety stock, and location.
- Live 7-day rainfall from Open-Meteo, clearly labelled live vs example data.
- A day-by-day water balance (use first, then rain capture, capped at capacity; overflow and shortages tracked separately).
- A latest safe booking day that accounts for supplier lead time and safety stock, plus an estimated top-up.
- A saved decision log: the exact inputs and recalculated output for each decision.

## What makes it different
1. **No-rain stress test, always visible.** Every plan shows the forecast date and the date if rain fails, side by side. Rain is treated as a bonus, not a promise.
2. **Transparent, not a black box.** The formula (rain mm × roof m² × efficiency) and each day's water movement are on screen. The same deterministic model runs in Python (Lambda) and JavaScript (browser); a parity test checks 2,026 scenarios for identical results.
3. **A decision log built for later checking**: each record keeps the inputs, forecast source and dates, so real deliveries can later be compared with what was recommended.

## AWS services used
- **Amazon API Gateway (HTTP API)**: `/health`, `/simulate`, `/records`, `/history`, with CORS and throttling.
- **AWS Lambda (Python 3.12)**: runs the water-balance model. On save it recalculates the result itself instead of trusting the browser.
- **Amazon DynamoDB**: decision records keyed by building and `timestamp#uuid`, so rapid saves never overwrite each other. Encrypted at rest; Lambda only has `PutItem` and `Query`.
- **AWS SAM / CloudFormation** for deployment, with **CloudWatch Logs** (14-day retention).
- [AFTER DEPLOY] Deployed in ap-south-1 (Mumbai); the demo video shows a live save to DynamoDB and the record reloaded from history.

Other: Open-Meteo forecast API, React + Vite frontend.

## AI tools used
[Edit to match what your team really used, e.g. "ChatGPT was used to draft the initial starter."] Devin (Cognition) was used to align and test the JavaScript and Python models, harden the Lambda/SAM backend, redesign the UI around the booking decision, and write tests and docs. The team reviewed the model assumptions and outputs.

## Test and demo data
- Default building ("Sample hostel"): 10,000 L tank, 8,000 L in stock, 1,800 L/day, 120 m² roof, 0.8 efficiency, 2-day lead time, 1,800 L safety stock. **These are example values, not measurements from a real building.**
- Example rainfall: 0, 0, 20, 10, 0, 0, 0 mm. Known answer: book within 3 days with forecast rain, 1 day with no rain, estimated top-up 3,520 L.
- Tests: 22 JavaScript engine tests, 26 Python tests (including a moto DynamoDB save/history roundtrip), and a 2,026-scenario JS↔Python parity check.

## Limitations
- Daily model only: no hourly demand or rain timing; one efficiency factor for all roof/pipe losses.
- Forecast rain is uncertain; collected rain is not assumed drinkable; water quality is not assessed.
- Top-up is an estimate, not a tanker size; supplier minimums and pricing are not modelled.
- One building per record; no accounts or authentication (anyone with the URL can save to a building name).
- No measured impact yet: we do not claim water or cost savings.
