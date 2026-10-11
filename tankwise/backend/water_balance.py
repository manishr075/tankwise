"""Deterministic water-balance and tanker-timing engine for Tankwise.

frontend/src/engine.js must stay formula-for-formula identical; run
`python scripts/check_parity.py` after any change to either file.

Potential capture (L) = rainfall_mm * roof_area_m2 * efficiency.
Daily demand is subtracted before rainfall capture is added. This is a
planning aid, not a guarantee of water supply or potability.
"""
from __future__ import annotations

import math
import re
from typing import Any

MAX_ORDER_WINDOW_DAYS = 14
MAX_FORECAST_DAYS = 14
MAX_RAIN_MM_PER_DAY = 500
TARGET_DAYS_OF_DEMAND = 2

_NUMERIC_TEXT = re.compile(r"^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$")

NOTES = [
    "Potential capture (L) = rainfall (mm) x roof area (m2) x collection efficiency.",
    "Each day, demand is subtracted before rain capture is added, then stock is capped at tank capacity.",
    "An order placed on a day arrives lead-time days later, before that day's use.",
    "Estimated top-up = target stock (safety stock + 2 days of demand, capped at capacity) minus projected stock on arrival if booked on the latest safe day. Not a supplier tanker size.",
    "The no-rain scenario is a stress test, not a prediction. Collected rain is not assumed to be potable.",
]


def _number(value: Any, name: str, allow_zero: bool = False) -> float:
    parsed = math.nan
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
    elif isinstance(value, str) and _NUMERIC_TEXT.match(value):
        parsed = float(value)
    if math.isnan(parsed):
        raise ValueError(f"{name} must be a number.")
    if math.isinf(parsed):
        raise ValueError(f"{name} must be a finite number.")
    if allow_zero and parsed < 0:
        raise ValueError(f"{name} must be zero or greater.")
    if not allow_zero and parsed <= 0:
        raise ValueError(f"{name} must be greater than zero.")
    return parsed


def validate_inputs(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")
    capacity = _number(data.get("tankCapacityLiters"), "Tank capacity")
    stock = _number(data.get("currentStockLiters"), "Current stock", allow_zero=True)
    if stock > capacity:
        raise ValueError("Current stock cannot exceed tank capacity.")
    consumption = _number(data.get("dailyConsumptionLiters"), "Daily consumption")
    roof = _number(data.get("roofAreaM2"), "Roof area", allow_zero=True)
    efficiency = _number(data.get("collectionEfficiency"), "Collection efficiency", allow_zero=True)
    if efficiency > 1:
        raise ValueError("Collection efficiency must be between 0 and 1.")
    lead_float = _number(data.get("leadTimeDays"), "Delivery lead time", allow_zero=True)
    if not lead_float.is_integer() or lead_float > MAX_ORDER_WINDOW_DAYS:
        raise ValueError("Delivery lead time must be a whole number from 0 to 14 days.")
    safety = _number(data.get("safetyStockLiters"), "Safety stock", allow_zero=True)
    if safety > capacity:
        raise ValueError("Safety stock cannot exceed tank capacity.")
    raw_rainfall = data.get("forecastMm")
    if raw_rainfall is None:
        raw_rainfall = []
    if not isinstance(raw_rainfall, list):
        raise ValueError("forecastMm must be an array of daily rainfall amounts.")
    if len(raw_rainfall) > MAX_FORECAST_DAYS:
        raise ValueError("Use no more than 14 forecast days.")
    rainfall: list[float] = []
    for index, value in enumerate(raw_rainfall):
        mm = _number(value, f"Rainfall for day {index + 1}", allow_zero=True)
        if mm > MAX_RAIN_MM_PER_DAY:
            raise ValueError(f"Rainfall for day {index + 1} must be between 0 and 500 mm.")
        rainfall.append(mm)
    return {
        "capacity": capacity,
        "stock": stock,
        "consumption": consumption,
        "roof": roof,
        "efficiency": efficiency,
        "lead": int(lead_float),
        "safety": safety,
        "rainfall": rainfall,
    }


def round2(value: float) -> float:
    """Half-up rounding to 2 dp, bit-identical to round2() in engine.js."""
    return math.floor(value * 100 + 0.5) / 100


def _simulate_scenario(parsed: dict[str, Any], rainfall: list[float], days: int) -> list[dict[str, Any]]:
    water = parsed["stock"]
    timeline: list[dict[str, Any]] = []
    for index in range(days):
        rain_mm = rainfall[index] if index < len(rainfall) else 0.0
        stock_at_start = water
        stock_after_demand = max(0.0, stock_at_start - parsed["consumption"])
        shortage = max(0.0, parsed["consumption"] - stock_at_start)
        harvest = rain_mm * parsed["roof"] * parsed["efficiency"]
        before_capacity = stock_after_demand + harvest
        overflow = max(0.0, before_capacity - parsed["capacity"])
        water = min(parsed["capacity"], before_capacity)
        timeline.append({
            "day": index + 1,
            "rainfallMm": round2(rain_mm),
            "stockAtStartLiters": round2(stock_at_start),
            "demandLiters": round2(parsed["consumption"]),
            "stockAfterDemandLiters": round2(stock_after_demand),
            "potentialHarvestLiters": round2(harvest),
            "overflowLiters": round2(overflow),
            "shortageLiters": round2(shortage),
            "stockAfterLiters": round2(water),
        })
    return timeline


def _is_unsafe(day: dict[str, Any], safety: float) -> bool:
    return day["shortageLiters"] > 0 or day["stockAfterLiters"] < safety


def _latest_safe_order_delay(parsed: dict[str, Any], rainfall: list[float]) -> int | None:
    """Latest number of days the order can be postponed.

    An order placed at the start of day (delay + 1) arrives at the start of day
    (delay + lead + 1), before that day's demand. Every day before arrival must
    end at or above safety stock with no unmet demand. None = not safe even if
    ordered now.
    """
    if parsed["stock"] < parsed["safety"]:
        return None
    timeline = _simulate_scenario(parsed, rainfall, MAX_ORDER_WINDOW_DAYS + parsed["lead"])
    latest: int | None = None
    for delay in range(MAX_ORDER_WINDOW_DAYS + 1):
        if any(_is_unsafe(day, parsed["safety"]) for day in timeline[:delay + parsed["lead"]]):
            break
        latest = delay
    return latest


def _stock_after_days(parsed: dict[str, Any], rainfall: list[float], days: int) -> float:
    if days == 0:
        return parsed["stock"]
    return _simulate_scenario(parsed, rainfall, days)[days - 1]["stockAfterLiters"]


def _first_day(timeline: list[dict[str, Any]], predicate) -> int | None:
    return next((day["day"] for day in timeline if predicate(day)), None)


def _plural(n: int) -> str:
    return f"{n} day" if n == 1 else f"{n} days"


def _window_text(deadline: int | None) -> str:
    if deadline is None:
        return "book now and arrange a backup supply"
    if deadline == 0:
        return "book today"
    if deadline >= MAX_ORDER_WINDOW_DAYS:
        return f"booking can wait at least {_plural(deadline)}"
    return f"booking can wait up to {_plural(deadline)}"


def _sum(timeline: list[dict[str, Any]], key: str) -> float:
    total = 0.0
    for day in timeline:
        total += day[key]
    return round2(total)


def simulate_water_balance(data: dict[str, Any]) -> dict[str, Any]:
    parsed = validate_inputs(data)
    forecast = parsed["rainfall"]
    no_rain = [0.0] * len(forecast)
    safety = parsed["safety"]
    horizon = max(7, len(forecast), parsed["lead"] + 1)
    forecast_timeline = _simulate_scenario(parsed, forecast, horizon)
    no_rain_timeline = _simulate_scenario(parsed, no_rain, horizon)
    forecast_deadline = _latest_safe_order_delay(parsed, forecast)
    no_rain_deadline = _latest_safe_order_delay(parsed, no_rain)
    forecast_arrival_day = (forecast_deadline or 0) + parsed["lead"]
    no_rain_arrival_day = (no_rain_deadline or 0) + parsed["lead"]
    forecast_arrival_stock = _stock_after_days(parsed, forecast, forecast_arrival_day)
    no_rain_arrival_stock = _stock_after_days(parsed, no_rain, no_rain_arrival_day)
    target_stock = min(parsed["capacity"], safety + parsed["consumption"] * TARGET_DAYS_OF_DEMAND)
    below_safety_now = parsed["stock"] < safety
    supply_risk_before_delivery = below_safety_now or any(
        _is_unsafe(day, safety) for day in forecast_timeline[:parsed["lead"]]
    )

    if forecast_deadline is None:
        urgency = "critical"
    elif forecast_deadline == 0:
        urgency = "critical" if supply_risk_before_delivery else "high"
    elif forecast_deadline <= 2 or no_rain_deadline is None or no_rain_deadline == 0:
        urgency = "high"
    else:
        urgency = "planned"

    if below_safety_now:
        recommendation = "Stock is already below the safety buffer. Book a tanker now and arrange a backup supply."
    elif forecast_deadline is None:
        recommendation = "Book now and arrange a backup supply: even a tanker ordered today arrives after the safety buffer is breached."
    else:
        recommendation = (
            f"With the rain forecast, {_window_text(forecast_deadline)}. "
            f"With no rain, {_window_text(no_rain_deadline)}."
        )

    return {
        "unit": "litres",
        "horizonDays": horizon,
        "forecastTimeline": forecast_timeline,
        "noRainTimeline": no_rain_timeline,
        "maxOrderWindowDays": MAX_ORDER_WINDOW_DAYS,
        "forecastDeadlineDays": forecast_deadline,
        "noRainDeadlineDays": no_rain_deadline,
        "forecastArrivalDay": forecast_arrival_day,
        "noRainArrivalDay": no_rain_arrival_day,
        "forecastStockAtArrivalLiters": round2(forecast_arrival_stock),
        "noRainStockAtArrivalLiters": round2(no_rain_arrival_stock),
        "targetStockLiters": round2(target_stock),
        "estimatedTopUpLiters": round2(max(0.0, target_stock - forecast_arrival_stock)),
        "noRainEstimatedTopUpLiters": round2(max(0.0, target_stock - no_rain_arrival_stock)),
        "forecastFirstBelowSafetyDay": _first_day(forecast_timeline, lambda d: _is_unsafe(d, safety)),
        "noRainFirstBelowSafetyDay": _first_day(no_rain_timeline, lambda d: _is_unsafe(d, safety)),
        "forecastFirstShortageDay": _first_day(forecast_timeline, lambda d: d["shortageLiters"] > 0),
        "noRainFirstShortageDay": _first_day(no_rain_timeline, lambda d: d["shortageLiters"] > 0),
        "forecastPotentialCaptureLiters": _sum(forecast_timeline, "potentialHarvestLiters"),
        "forecastOverflowLiters": _sum(forecast_timeline, "overflowLiters"),
        "belowSafetyNow": below_safety_now,
        "hasSupplyRiskBeforeDelivery": supply_risk_before_delivery,
        "urgency": urgency,
        "recommendation": recommendation,
        "notes": list(NOTES),
    }
