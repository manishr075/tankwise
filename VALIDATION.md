# Validation status

Last run: 2026-10-11 (PR #3 review), same Linux sandbox (no AWS access), Node 22.22.3, Python 3.11.2 with a local venv for `backend/requirements-dev.txt` (boto3 + moto), `cfn-lint` and `aws-sam-translator`. The new `.github/workflows/ci.yml` ran **green** on the pull request: frontend tests + build, backend tests, engine parity and cfn-lint. No AWS CLI or SAM CLI was available, so no template build or deployment was run.

Previous run: 2026-10-11, same sandbox — the CORS/`ALLOWED_ORIGIN`, 14-day-forecast and stale-race work in the table below.

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
| Dev server reachable off localhost | `curl -H 'Host: 5173-…e2b.app' http://127.0.0.1:5173/`, before and after `allowedHosts` in `frontend/vite.config.js` | **403 "Blocked request" before, 200 after.** With `VITE_ALLOWED_HOSTS=.e2b.app`, a `*.e2b.app` host returns 200 and `evil.example` returns 403, so the allowlist still narrows. `vite preview` behaves the same. |
| Continuous integration | PR #3 runs of `.github/workflows/ci.yml` (push and pull_request) | **All four jobs green**: frontend tests + build, backend unittest suite, engine parity, cfn-lint. First automated guard for the `engine.js` ↔ `water_balance.py` parity the README relies on. |
| SAM transform of the CORS parameter | `aws-sam-translator` 1.114.0 `transform()` on `template.yaml` (with `CodeUri` repointed to an S3 URI, because SAM CLI is not installed) | Transforms cleanly: default → `allowOrigins: "*"`; one origin → `["https://front.example"]`; two origins → `["https://a.example","https://b.example"]` (a real list, not one comma-joined entry); `ALLOWED_ORIGIN` stays `Fn::Join [',', {Ref: AllowedOrigin}]`. This is the client-side translator, **not** `sam validate --lint`. |
| Whole suite re-run after the changes | `npm test`, `npm run build`, `python -m unittest discover -s tests -v`, `python scripts/check_parity.py`, `cfn-lint template.yaml` | Unchanged: 32 pass, build OK, 37 tests OK, parity PASS on 2,027 scenarios, lint exit 0. |

Note on the race test: the Recalculate button is disabled while a calculation runs, so the overlap happens through "Reset example" and the health-check path. The fix covers those paths.

## Not verified

- [ ] **Real AWS deployment.** Nothing was deployed or changed in AWS. The Lambda CORS change and the new `ALLOWED_ORIGIN` environment variable are in the code and template only.
- [ ] **CORS against the deployed API.** Tested by unit tests and a client-side SAM transform only. The `AllowedOrigin` change (a `CommaDelimitedList` passed as one `AllowOrigins` entry per origin) has never been deployed, so multi-origin behaviour is untested against a real API. After the next deploy, check a normal response with `curl -i -H "Origin: https://your-frontend" <api>/health`, check preflight with `curl -i -X OPTIONS`, and confirm there is no duplicate `Access-Control-Allow-Origin` header: API Gateway's own CORS settings may also add one.
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

The same commands run in CI (`.github/workflows/ci.yml`) on every push and pull request, so none of them has to be remembered by hand.

## Earlier run (2026-10-10, Windows dev VM)

That run reported 22 engine tests, 26 backend tests, a 2,026-scenario parity check, a successful frontend build, `sam validate --lint`, and `sam build` with Python 3.12. It also included browser checks against the local mock and a live Open-Meteo request from the developer machine. It did not include any AWS deployment. The 7-day forecast and the earlier CORS behaviour described there have since changed.
