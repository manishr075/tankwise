"""Local HTTP wrapper around backend/app.py for offline UI testing. NOT AWS.

Runs the real Lambda handler with an in-memory table and relabels every
response as "local-mock" so the frontend can never present it as DynamoDB.

    python scripts/local_api.py            # http://127.0.0.1:8787
    VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev   (in frontend/)
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ.setdefault("ALLOWED_ORIGIN", "*")
import app  # noqa: E402


class MemoryTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item, ConditionExpression=None):  # noqa: N803
        if any(i["building_id"] == Item["building_id"] and i["sort_key"] == Item["sort_key"] for i in self.items):
            raise RuntimeError("ConditionalCheckFailed")
        self.items.append(json.loads(json.dumps(Item, default=app._json_default)))

    def query(self, ExpressionAttributeValues, ScanIndexForward=True, Limit=None, **_):  # noqa: N803
        key = ExpressionAttributeValues[":b"]
        rows = sorted((i for i in self.items if i["building_id"] == key), key=lambda i: i["sort_key"], reverse=not ScanIndexForward)
        return {"Items": rows[:Limit] if Limit else rows}


TABLE = MemoryTable()
app.TABLE_NAME = "local-mock-table"
app._get_table = lambda: TABLE


def relabel(value):
    if isinstance(value, dict):
        out = {k: relabel(v) for k, v in value.items()}
        if out.get("storage") == "dynamodb":
            out["storage"] = "local-mock"
        for key in ("calculated_by", "calculatedBy"):
            if out.get(key) == "aws-lambda":
                out[key] = "local-mock"
        return out
    if isinstance(value, list):
        return [relabel(v) for v in value]
    return value


class Handler(BaseHTTPRequestHandler):
    def _dispatch(self):
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        event = {
            "rawPath": parts.path,
            "requestContext": {"http": {"method": self.command}},
            "queryStringParameters": dict(parse_qsl(parts.query)) or None,
            "body": self.rfile.read(length).decode("utf-8") if length else None,
        }
        result = app.handler(event)
        body = result.get("body") or ""
        if body:
            data = relabel(json.loads(body))
            if isinstance(data, dict) and isinstance(data.get("item"), dict):
                data["item"]["storage"] = "local-mock"
            if isinstance(data, dict) and isinstance(data.get("items"), list):
                for item in data["items"]:
                    item["storage"] = "local-mock"
            body = json.dumps(data)
        self.send_response(result["statusCode"])
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if body:
            self.wfile.write(body.encode("utf-8"))

    do_GET = do_POST = do_OPTIONS = _dispatch


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    print(f"Tankwise LOCAL MOCK API (not AWS) on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
