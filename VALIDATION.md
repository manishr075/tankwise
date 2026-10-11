# Validation status

Last run: 2026-10-11, Linux sandbox (no AWS access), Node 22.22.3, Python 3.11.2 with a local venv for `backend/requirements-dev.txt` (boto3 + moto) and `cfn-lint`. No AWS CLI or SAM CLI was available, so no template build or deployment was run.

Earlier run (2026-10-10, Windows dev VM, Node 20.19.0, Python 3.13/3.12, SAM CLI 1.168.0) is summarised at the end. Its AWS and deployment checkboxes were never run against a real account.

## Verified in this session

| Check | Command | Result |
|---|---|---|
| Frontend tests | `cd frontend && npm test` | **32 pass, 0 fail**: 23 engine tests (including days 8–14), 9 Open-Meteo/AWS client tests (14-day request, null handling, provider error reasons, malformed bodies, >14 days, network failure, cancellation) |
| Frontend build | `cd frontend && npm run build` | Succeeds |
| Backend tests | `cd backend && python -m unittest discover -s tests -v` (venv with `requirements-dev.txt`) | **37 run, OK**: includes 8 CORS tests, 2 new 14-day save tests, and the moto DynamoDB save/history roundtrip (previously skipped without moto) |
| JS ↔ Python parity | `python scripts/check_parity.py` | **PASS on 2,027 scenarios**: 27 named edge cases (including late rain on days 8–14), 1,804 valid, 223 rejected with identical messages |
| CloudFormation lint | `cfn-lint template.yaml` | No findings (exit 0). This is not `sam validate`. |
| Browser: layout | Headless Chromium, desktop 1440 px and mobile 390 px | Both render with **0 px horizontal overflow**. Screenshots were reviewed and drove the Stage 1 spacing fixes. |
| Browser: history rows | Local API mock (`scripts/local_api.py`, labelled not AWS) | Saved record shows the top-up and **both** booking dates (forecast and no rain). Header reads "Local API mock · not AWS". |
| Browser: 14-day live forecast | Open-Meteo responses **mocked** in the browser (the sandbox cannot reach Open-Meteo) | Request uses `forecast_days=14`; timeline shows 14 rows; success message is correct. A mocked 400 shows Open-Meteo's reason and keeps the previous forecast. |
| Browser: stale calculation race | Local API mock with the 5,000 L request artificially delayed, then "Reset example" | **Pre-fix build** shows a stale 5,000 L plan while the input box says 8,000 L. **Fixed build** shows 8,000 L. |

Note on the race test: the Recalculate button is disabled while a calculation runs, so the overlap happens through "Reset example" and the health-check path. The fix covers those paths.

## Not verified

- [ ] **Real AWS deployment.** Nothing was deployed or changed in AWS. The Lambda CORS change and the new `ALLOWED_ORIGIN` environment variable are in the code and template only.
- [ ] **CORS against the deployed API.** Tested by unit tests only. After the next deploy, check the response headers with `curl -i -H "Origin: https://your-frontend" <api>/health`. Also confirm there is no duplicate `Access-Control-Allow-Origin` header: API Gateway's own CORS settings may also add one.
- [ ] **Live Open-Meteo call.** The sandbox does not allow `api.open-meteo.com`. The 14-day request format follows the Open-Meteo documentation (`forecast_days` up to 16), but the live response has not been observed.
- [ ] **`sam validate --lint` and `sam build`.** SAM CLI was not installed.
- [ ] **`deploy-tankwise.ps1`.** PowerShell and AWS credentials were not available.
- [ ] **Screen-reader testing.** Labels, roles, and keyboard focus are in place. No assistive technology was used.
- [ ] **Hosted frontend.** Not deployed.

## How to re-run

```bash
cd frontend && npm install && npm test && npm run build
cd ..
python -m pip install -r backend/requirements-dev.txt
cd backend && python -m unittest discover -s tests -v && cd ..
python scripts/check_parity.py
cfn-lint template.yaml   # optional; or: sam validate --lint
```

## Earlier run (2026-10-10, Windows dev VM)

That run reported 22 engine tests, 26 backend tests, a 2,026-scenario parity check, a successful frontend build, `sam validate --lint`, and `sam build` with Python 3.12. It also included browser checks against the local mock and a live Open-Meteo request from the developer machine. It did not include any AWS deployment. The 7-day forecast and the earlier CORS behaviour described there have since changed.
