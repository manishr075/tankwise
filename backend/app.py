"""AWS Lambda handler for the Tankwise HTTP API (API Gateway HTTP API v2)."""
from __future__ import annotations

import base64
import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from water_balance import simulate_water_balance, validate_inputs

TABLE_NAME = os.environ.get("TABLE_NAME", "")
MAX_BODY_BYTES = 20_000
HISTORY_LIMIT = 8
HEALTHCHECK_KEY = "__tankwise_healthcheck__"
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _response(status_code: int, payload: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Cache-Control": "no-store",
        },
        "body": "" if payload is None else json.dumps(payload, default=_json_default, separators=(",", ":")),
    }


def _allowed_origins() -> list[str]:
    """Origins from the AllowedOrigin stack parameter (ALLOWED_ORIGIN env var), comma-separated.

    Unset or '*' keeps the open hackathon default. Read on every call so tests can change it.
    """
    raw = os.environ.get("ALLOWED_ORIGIN", "*")
    origins = [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]
    return origins or ["*"]


def _cors_origin(request_origin: str) -> str:
    """Value for Access-Control-Allow-Origin.

    Echoes the request's Origin only when it is explicitly configured; otherwise returns the
    first configured origin, so a browser on any other site is refused by CORS.
    """
    origins = _allowed_origins()
    if "*" in origins:
        return "*"
    if request_origin and request_origin.rstrip("/") in origins:
        return request_origin.rstrip("/")
    return origins[0]


def _request_origin(event: dict[str, Any]) -> str:
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == "origin" and isinstance(value, str):
            return value.strip()
    return ""


def _with_cors(response: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    headers = response.setdefault("headers", {})
    headers["Access-Control-Allow-Origin"] = _cors_origin(_request_origin(event))
    if _allowed_origins() != ["*"]:
        headers["Vary"] = "Origin"
    return response


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _to_decimal(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _to_decimal(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_decimal(item) for item in value]
    return value


def _get_table():
    if not TABLE_NAME:
        raise RuntimeError("TABLE_NAME environment variable is not configured.")
    import boto3
    return boto3.resource("dynamodb").Table(TABLE_NAME)


def _parse_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body") or "{}"
    if isinstance(body, dict):
        return body
    if event.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            raise ValueError("Request body must be valid JSON.") from None
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("Request body is too large.")
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        raise ValueError("Request body must be valid JSON.") from None
    if not isinstance(parsed, dict):
        raise ValueError("Request body must be a JSON object.")
    return parsed


def _clean_building_id(value: Any) -> str:
    return str(value or "").strip()[:80] or "default"


def _optional_coordinate(value: Any, name: str, limit: float) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number.") from None
    if not -limit <= number <= limit:
        raise ValueError(f"{name} must be between {-limit:g} and {limit:g}.")
    return number


def _normalized_input(raw: dict[str, Any]) -> dict[str, Any]:
    """Validated, whitelisted copy of the model input (unknown keys dropped)."""
    parsed = validate_inputs(raw)
    clean: dict[str, Any] = {
        "buildingName": str(raw.get("buildingName") or "").strip()[:80],
        "currentStockLiters": parsed["stock"],
        "tankCapacityLiters": parsed["capacity"],
        "dailyConsumptionLiters": parsed["consumption"],
        "roofAreaM2": parsed["roof"],
        "collectionEfficiency": parsed["efficiency"],
        "leadTimeDays": parsed["lead"],
        "safetyStockLiters": parsed["safety"],
        "forecastMm": parsed["rainfall"],
    }
    latitude = _optional_coordinate(raw.get("latitude"), "Latitude", 90)
    longitude = _optional_coordinate(raw.get("longitude"), "Longitude", 180)
    if latitude is not None:
        clean["latitude"] = latitude
    if longitude is not None:
        clean["longitude"] = longitude
    return clean


def _forecast_dates(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:14] if isinstance(item, str) and _DATE.match(item)]


def _health() -> dict[str, Any]:
    if not TABLE_NAME:
        return _response(200, {"status": "ok", "storage": "not-configured"})
    try:
        _get_table().query(
            KeyConditionExpression="building_id = :b",
            ExpressionAttributeValues={":b": HEALTHCHECK_KEY},
            Limit=1,
        )
    except Exception as exc:  # noqa: BLE001 - report degraded, never leak details
        print(f"Tankwise health check failed: {type(exc).__name__}")
        return _response(503, {"status": "degraded", "storage": "unavailable", "error": "DynamoDB health check failed."})
    return _response(200, {
        "status": "ok",
        "storage": "dynamodb",
        "region": os.environ.get("AWS_REGION", ""),
    })


def _save_record(payload: dict[str, Any]) -> dict[str, Any]:
    raw_input = payload.get("input") or payload.get("inputs")
    if not isinstance(raw_input, dict):
        raise ValueError("input must be supplied as a JSON object.")
    clean_input = _normalized_input(raw_input)
    output = simulate_water_balance(clean_input)  # never trust a client-supplied result
    building_id = _clean_building_id(payload.get("building_id") or clean_input["buildingName"])
    created_at = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    record_id = str(uuid.uuid4())
    record = {
        "building_id": building_id,
        "sort_key": f"{created_at}#{record_id}",
        "created_at": created_at,
        "record_id": record_id,
        "input": clean_input,
        "output": output,
        "forecast_source": str(payload.get("forecast_source") or "unknown")[:120],
        "forecast_dates": _forecast_dates(payload.get("forecast_dates")),
        "calculated_by": "aws-lambda",
    }
    _get_table().put_item(
        Item=_to_decimal(record),
        ConditionExpression="attribute_not_exists(sort_key)",
    )
    return _response(201, {"saved": True, "storage": "dynamodb", "item": record})


def _history(params: dict[str, Any]) -> dict[str, Any]:
    building_id = _clean_building_id(params.get("building_id"))
    response = _get_table().query(
        KeyConditionExpression="building_id = :b",
        ExpressionAttributeValues={":b": building_id},
        ScanIndexForward=False,
        Limit=HISTORY_LIMIT,
    )
    return _response(200, {"building_id": building_id, "items": response.get("Items", [])})


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    method = (
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()
    path = (event.get("rawPath") or event.get("path") or "/").rstrip("/") or "/"
    return _with_cors(_route(event, method, path), event)


def _route(event: dict[str, Any], method: str, path: str) -> dict[str, Any]:
    if method == "OPTIONS":
        return _response(204, None)
    try:
        if method == "GET" and path == "/health":
            return _health()
        if method == "POST" and path == "/simulate":
            result = simulate_water_balance(_parse_body(event))
            return _response(200, {"result": result, "calculatedBy": "aws-lambda"})
        if method == "POST" and path == "/records":
            return _save_record(_parse_body(event))
        if method == "GET" and path == "/history":
            return _history(event.get("queryStringParameters") or {})
        return _response(404, {"error": "Route not found."})
    except ValueError as exc:
        return _response(400, {"error": str(exc)})
    except Exception as exc:  # noqa: BLE001 - keep internals out of public responses
        print(f"Tankwise request failed on {method} {path}: {type(exc).__name__}")
        return _response(500, {"error": "The request could not be completed. Please try again."})
