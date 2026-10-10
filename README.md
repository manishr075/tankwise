# Tankwise

**When should this building book its next water tanker?** Tankwise is a rain-aware tanker-planning tool for one hostel, PG or housing building. It projects the tank day by day from current stock, daily use, supplier lead time and roof rain capture, gives a latest safe booking day, and always shows a **no-rain stress test** next to the forecast case. Decisions (exact inputs + recalculated output) are saved to Amazon DynamoDB through API Gateway + Lambda.

> Hackathon prototype, not a certified water-management system. Example values are not measured building data, forecast rain is not guaranteed, and collected rain is not assumed drinkable.

## Layout

| Path | What it is |
| --- | --- |
| `frontend/` | React + Vite UI. `src/engine.js` is the browser copy of the model; `src/api.js` handles AWS/Open-Meteo calls with timeouts. |
| `backend/water_balance.py` | Python model, formula-for-formula identical to `engine.js`. |
| `backend/app.py` | Lambda routes: `GET /health`, `POST /simulate`, `POST /records`, `GET /history`. |
| `template.yaml`, `samconfig.toml` | SAM stack: HTTP API (CORS, throttling), Python 3.12 Lambda, DynamoDB (`building_id` + `sort_key`), 14-day logs. |
| `scripts/check_parity.py` | Runs both engines on 26 edge cases + 2,000 seeded random cases and requires identical output and error messages. |
| `scripts/local_api.py` | Runs the real Lambda handler locally with an in-memory table, labelled **local mock, not AWS**, for UI testing without credentials. |

## Model

1. Rain capture (L) = rain (mm) × roof area (m²) × collection efficiency (0–1). 1 mm on 1 m² = 1 L before losses.
2. Each day: subtract demand first, then add rain capture, then cap at tank capacity. Overflow and unmet demand are tracked separately; stock never goes below 0.
3. **Latest booking day** = the most days you can wait before ordering such that, with the supplier lead time, every day until the tanker arrives ends at or above the safety stock with no unmet demand. An order placed on day *d* arrives at the start of day *d + lead time*, before that day's use. Checked up to 14 days ahead; `null` means it is not safe even if ordered today.
4. Calculated twice: with forecast rain and with zero rain (stress test). Days beyond the forecast count as 0 mm.
5. **Estimated top-up** = target stock (safety stock + 2 days of use, capped at capacity) − projected stock when a tanker booked on the latest safe day arrives. It is not a tanker size; supplier minimum orders are not modelled.
6. Inputs are rejected if: non-numeric/blank, stock > capacity, efficiency outside 0–1, lead time not a whole number 0–14, safety stock > capacity, rain negative or > 500 mm/day, more than 14 forecast days.

## Run locally

Node.js 20+ and Python 3.12 (Lambda runtime; 3.11+ works for tests).

```bash
cd frontend
npm install
npm test           # 22 engine tests
npm run dev        # http://localhost:5173
```

With no `VITE_API_BASE_URL`, the header says **Preview mode · no AWS configured**: calculations run in the browser and saves go only to browser localStorage, labelled as such.

Backend and parity checks (start at the project root). Install the optional test dependencies, run the backend tests from the `backend/` directory so Python can import `app` and `water_balance`, then return to the project root for parity:

```bash
python -m pip install -r backend/requirements-dev.txt
cd backend
python -m unittest discover -s tests -v
cd ..
python scripts/check_parity.py
```

Optional: exercise the connected UI path without AWS:

```bash
python scripts/local_api.py                                  # http://127.0.0.1:8787
cd frontend && VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev
```

The header then reads **Local API mock · not AWS** and saved records are badged "Local mock".

## Deploy to AWS (ap-south-1 suggested)

Needs AWS CLI credentials on your own machine (`aws configure` or `aws sso login`) and the SAM CLI. Never paste keys into chat, the frontend, or Git.

```bash
sam validate --lint
sam build                       # needs python3.12 on PATH (or: sam build --use-container)
sam deploy --guided             # defaults come from samconfig.toml; confirm the changeset
```

Optional: lock CORS to your frontend host with `--parameter-overrides AllowedOrigin=https://your-frontend.example`.

**Windows PowerShell helper:** after installing the AWS CLI and SAM CLI, signing in with `aws configure` or `aws sso login`, and ensuring Python 3.12 is available for SAM, run this from the project root:

```powershell
.\deploy-tankwise.ps1
```

The helper validates and builds the SAM project, runs the guided deployment, checks the real DynamoDB health endpoint, writes the gitignored `frontend/.env.local`, then runs frontend tests and the production build. Review and confirm the SAM changeset; do not claim deployment succeeded unless the script reaches its final success message and a decision can be saved and reloaded in the UI.

Copy the `TankwiseApiUrl` output, then check it:

```bash
curl https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/health
# expect {"status": "ok", "storage": "dynamodb", ...}
```

Point the frontend at it:

```bash
cd frontend
echo "VITE_API_BASE_URL=https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com" > .env.local
npm run dev        # or: npm run build, then host frontend/dist/ on any static host
```

The header should say **AWS + DynamoDB connected · ap-south-1**; the decision card says "Calculated by AWS Lambda"; **Save this decision** shows a record ID and the item appears under Saved decisions · Amazon DynamoDB. The "Last API call" line shows each real request, status and latency.

Cost/cleanup: DynamoDB is on-demand and the API is throttled, but these are billable resources. Remove them with `sam delete --stack-name tankwise-hackathon --region ap-south-1`.

## API

`POST /simulate` takes the input object (see `DEFAULT_INPUTS` in `frontend/src/engine.js`) and returns `{"result": {...}, "calculatedBy": "aws-lambda"}`. Invalid input → `400 {"error": "..."}`.

`POST /records`:

```json
{
  "building_id": "Sample hostel",
  "input": {
    "buildingName": "Sample hostel", "currentStockLiters": 8000, "tankCapacityLiters": 10000,
    "dailyConsumptionLiters": 1800, "roofAreaM2": 120, "collectionEfficiency": 0.8,
    "leadTimeDays": 2, "safetyStockLiters": 1800, "forecastMm": [0, 0, 20, 10, 0, 0, 0],
    "latitude": 12.9716, "longitude": 77.5946
  },
  "forecast_source": "Open-Meteo live forecast",
  "forecast_dates": ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
}
```

Lambda keeps only known input fields, **recalculates the output itself** (any client `result`/`output` is ignored), and stores `building_id`, `sort_key` (`<created_at>#<uuid>`, so rapid saves never overwrite), `created_at`, `record_id`, `input`, `output`, `forecast_source`, `forecast_dates`, `calculated_by`. Returns `201 {"saved": true, "item": {...}}`.

`GET /history?building_id=Sample%20hostel` returns the latest 8 records, newest first. `GET /health` queries the table and returns `503` with a generic message if DynamoDB is unreachable. Server errors never include stack traces or AWS details.

## Before real use

- Replace example values with measured tank readings and real daily use.
- Check the assumptions with whoever runs the building's water system; consider tanker sizes, emergency supply, hourly demand and roof/pipe losses.
- Do not claim water or cost savings without measured outcomes against a baseline.
