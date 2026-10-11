"""Check that frontend/src/engine.js and backend/water_balance.py agree.

Runs the shared known-answer case, named edge cases and a seeded set of
random scenarios (valid and invalid) through both engines and compares the
full outputs, including validation error messages.
Run from repo root: python scripts/check_parity.py [--cases N]
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from water_balance import simulate_water_balance  # noqa: E402

BASE = {
    "buildingName": "Sample hostel",
    "currentStockLiters": 8000,
    "tankCapacityLiters": 10000,
    "dailyConsumptionLiters": 1800,
    "roofAreaM2": 120,
    "collectionEfficiency": 0.8,
    "leadTimeDays": 2,
    "safetyStockLiters": 1800,
    "latitude": 12.9716,
    "longitude": 77.5946,
    "forecastMm": [0, 0, 20, 10, 0, 0, 0],
}

EDGE_CASES = {
    "known answer": BASE,
    "lead time zero": {**BASE, "leadTimeDays": 0},
    "already below reserve": {**BASE, "currentStockLiters": 1000},
    "no forecast days": {**BASE, "forecastMm": []},
    "no rain": {**BASE, "forecastMm": [0] * 7},
    "late rain days 8-14": {**BASE, "currentStockLiters": 8000, "dailyConsumptionLiters": 500, "leadTimeDays": 0, "safetyStockLiters": 1800, "forecastMm": [0] * 9 + [20] + [0] * 4},
    "extreme rain": {**BASE, "forecastMm": [500] * 14},
    "tank overflow": {**BASE, "currentStockLiters": 9900, "forecastMm": [80, 0, 0]},
    "demand exceeds stock": {**BASE, "currentStockLiters": 900, "safetyStockLiters": 0},
    "safety above stock": {**BASE, "currentStockLiters": 3000, "safetyStockLiters": 4000},
    "window capped at 14": {**BASE, "dailyConsumptionLiters": 100, "safetyStockLiters": 0},
    "max lead time": {**BASE, "leadTimeDays": 14, "currentStockLiters": 10000, "dailyConsumptionLiters": 300, "safetyStockLiters": 500},
    "half-up rounding": {**BASE, "roofAreaM2": 1, "collectionEfficiency": 1, "forecastMm": [2.675, 0.125, 1.005]},
    "string numbers": {**BASE, "currentStockLiters": " 8000 ", "leadTimeDays": "2"},
    "invalid: stock > capacity": {**BASE, "currentStockLiters": 12000},
    "invalid: negative rain": {**BASE, "forecastMm": [0, -1]},
    "invalid: efficiency > 1": {**BASE, "collectionEfficiency": 1.2},
    "invalid: fractional lead": {**BASE, "leadTimeDays": 1.5},
    "invalid: negative lead": {**BASE, "leadTimeDays": -1},
    "invalid: safety > capacity": {**BASE, "safetyStockLiters": 20000},
    "invalid: blank field": {**BASE, "dailyConsumptionLiters": ""},
    "invalid: boolean": {**BASE, "roofAreaM2": True},
    "invalid: null": {**BASE, "tankCapacityLiters": None},
    "invalid: 15 forecast days": {**BASE, "forecastMm": [0] * 15},
    "invalid: rain > 500": {**BASE, "forecastMm": [501]},
    "invalid: forecast not list": {**BASE, "forecastMm": "0,0"},
    "invalid: underscore number": {**BASE, "currentStockLiters": "1_000"},
}

JS = """
import { simulateWaterBalance } from './src/engine.js';
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const out = JSON.parse(raw).map((input) => {
    try { return { ok: true, result: simulateWaterBalance(input) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  process.stdout.write(JSON.stringify(out));
});
"""


def random_case(rng: random.Random) -> dict:
    capacity = rng.choice([500, 1000, 5000, 10000, 25000, rng.uniform(100, 50000)])
    case = {
        "tankCapacityLiters": capacity,
        "currentStockLiters": rng.uniform(0, capacity),
        "dailyConsumptionLiters": rng.choice([rng.uniform(1, capacity / 2), rng.randint(1, 5000)]),
        "roofAreaM2": rng.choice([0, rng.uniform(0, 1000), rng.randint(1, 400)]),
        "collectionEfficiency": rng.choice([0, 1, round(rng.random(), 3), rng.random()]),
        "leadTimeDays": rng.randint(0, 14),
        "safetyStockLiters": rng.uniform(0, capacity),
        "forecastMm": [rng.choice([0, 0, rng.uniform(0, 80), round(rng.uniform(0, 500), 1)])
                       for _ in range(rng.randint(0, 14))],
    }
    if rng.random() < 0.12:  # sprinkle invalid inputs to compare error messages
        key = rng.choice(list(case))
        case[key] = rng.choice([-1, "", None, True, "abc", 1e9, 1.5, [1], 600])
    return case


def run_js(cases: list[dict]) -> list[dict]:
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", JS],
        cwd=ROOT / "frontend", input=json.dumps(cases), text=True,
        capture_output=True, check=True, encoding="utf-8",
    )
    return json.loads(completed.stdout)


def run_py(case: dict) -> dict:
    try:
        return {"ok": True, "result": simulate_water_balance(case)}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20261010)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    names = list(EDGE_CASES) + [f"random #{i}" for i in range(args.cases)]
    cases = list(EDGE_CASES.values()) + [random_case(rng) for _ in range(args.cases)]
    js_results = run_js(cases)
    failures = 0
    for name, case, js_out in zip(names, cases, js_results):
        py_out = run_py(case)
        if js_out != py_out:
            failures += 1
            if failures <= 5:
                print(f"MISMATCH in {name}: input={json.dumps(case)}")
                print(f"  frontend={json.dumps(js_out)[:600]}")
                print(f"  backend ={json.dumps(py_out)[:600]}")
    if failures:
        print(f"FAIL: {failures} of {len(cases)} scenarios differ.")
        return 1
    valid = sum(1 for out in js_results if out["ok"])
    known = js_results[0]["result"]
    print(f"PASS: JS and Python engines match on {len(cases)} scenarios "
          f"({len(EDGE_CASES)} named edge cases, {valid} valid, {len(cases) - valid} rejected with identical errors).")
    print(f"  Known answer: order window {known['forecastDeadlineDays']} day(s), no-rain {known['noRainDeadlineDays']} day(s), "
          f"estimated top-up {known['estimatedTopUpLiters']:,.0f} L")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
