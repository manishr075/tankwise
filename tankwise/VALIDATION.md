# Validation status — final checklist

Last run: 2026-10-10, Windows dev VM, Node 20.19.0, Python 3.13 (tests) + 3.12 (SAM build), SAM CLI 1.168.0.

## Verified (actually run)

- [x] Frontend engine tests: `npm test` → **22 passed, 0 failed** (formula, demand-before-rain, overflow, known answer, lead time 0, already below reserve, safety above stock, empty forecast, rain vs no-rain, extreme rain + 14-day cap, demand > stock, rounding, invalid inputs).
- [x] Backend tests: `cd backend && python -m unittest discover -s tests -v` → **26 passed** in the original Windows dev environment when `backend/requirements-dev.txt` is installed (engine edge cases; API routes, CORS preflight, invalid/oversized JSON, server-side recalculation and input whitelisting, rapid-save collision resistance, newest-first history, error sanitising, 404s; moto DynamoDB health → save → history roundtrip).
- [x] JS ↔ Python parity: `python scripts/check_parity.py` → identical output on **2,026 scenarios** (26 named edge cases, 1,803 valid random, 223 invalid with identical error messages). Known answer: 3 days / 1 day no-rain / 3,520 L top-up.
- [x] Frontend production build: `npm run build` succeeds.
- [x] `sam validate --lint`: valid SAM template. `sam build`: succeeds with Python 3.12 on PATH.
- [x] Browser checks (Chromium, 1440 px and 390 px widths): no horizontal overflow, no page errors.
- [x] Preview mode: header says "Preview mode · no AWS configured"; save shows "Saved in this browser only (localStorage). This is not an AWS save."; record survives reload, badged "Browser"; reopening it restores inputs.
- [x] Connected path against `scripts/local_api.py` (real Lambda handler, in-memory table, **not AWS**): health → "Local API mock · not AWS"; simulate; two saves → two distinct history rows newest first; "Last API call" line shows method, path, status, latency.
- [x] Stale-data guard: editing an input shows "Inputs changed…" and disables Save until Recalculate; summary cards keep showing the last calculated inputs.
- [x] Invalid input (efficiency 1.5) → clear error, previous valid plan stays visible.
- [x] Live Open-Meteo forecast loaded in the browser for 12.97, 77.59; source chip switched to "Open-Meteo live forecast · fetched hh:mm" and the plan recalculated.
- [x] Weather outage (requests blocked) → "Live forecast unavailable … Still using: <previous source>"; previous rainfall kept.
- [x] API outage (requests blocked) → "AWS API offline"; Save falls back to "Browser-only save · not AWS".

## Not verified

- [ ] Real AWS deployment (`sam deploy`), API Gateway URL, Lambda execution in AWS, and DynamoDB writes/reads. No AWS credentials were available, so nothing was deployed. **Do not claim AWS is live until you complete the steps below.**
- [ ] CORS from a hosted frontend origin to the deployed API (tested only against the local mock).
- [ ] The "degraded" state (API up, DynamoDB down) in a real browser — covered by unit tests only.
- [ ] Hosting the built frontend on a public URL.
- [ ] Screen-reader testing (labels, roles and keyboard focus are in place but not tested with assistive tech).

## Requires your action

1. On your own machine with AWS access: `aws configure` (or `aws sso login`), install SAM CLI and Python 3.12.
2. On Windows, from the repo root, run `.\deploy-tankwise.ps1` after AWS CLI/SAM/Python 3.12 are installed and AWS authentication works. Otherwise run `sam validate --lint`, `sam build`, and `sam deploy --guided` from the repo root (region `ap-south-1`, stack `tankwise-hackathon`; review the changeset).
3. `curl <TankwiseHealthUrl>` → must return `"storage": "dynamodb"`.
4. `frontend/.env.local`: `VITE_API_BASE_URL=<TankwiseApiUrl>` (no trailing slash), then `npm run dev` (or build and host `frontend/dist/`; then redeploy with `AllowedOrigin=<your frontend URL>`).
5. In the app: confirm "AWS + DynamoDB connected · ap-south-1", click Save, confirm the record appears under "Saved decisions · Amazon DynamoDB" (optionally in the DynamoDB console).
6. Record the demo (`DEMO_SCRIPT.md`) and edit `SUBMISSION_DRAFT.md` (AI-tools line, [AFTER DEPLOY] line).
7. After judging: `sam delete --stack-name tankwise-hackathon --region ap-south-1` to stop charges.

## Commands to re-run everything

Run these from the project root, one section at a time:

```bash
cd frontend
npm install
npm test
npm run build
cd ..
python -m pip install -r backend/requirements-dev.txt
cd backend
python -m unittest discover -s tests -v
cd ..
python scripts/check_parity.py
sam validate --lint
sam build
```
