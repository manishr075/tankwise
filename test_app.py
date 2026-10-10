import json
import os
import unittest
from unittest.mock import patch

import app

INPUT = {
    "buildingName": "Test hostel",
    "currentStockLiters": 8000,
    "tankCapacityLiters": 10000,
    "dailyConsumptionLiters": 1800,
    "roofAreaM2": 120,
    "collectionEfficiency": 0.8,
    "leadTimeDays": 2,
    "safetyStockLiters": 1800,
    "latitude": 12.97,
    "longitude": 77.59,
    "forecastMm": [0, 0, 20, 10, 0, 0, 0],
}


class FakeTable:
    def __init__(self, fail=False):
        self.items = []
        self.fail = fail

    def put_item(self, Item, ConditionExpression=None):
        if self.fail:
            raise RuntimeError("secret internal detail arn:aws:dynamodb:xyz")
        self.items.append(Item)

    def query(self, KeyConditionExpression, ExpressionAttributeValues, ScanIndexForward=True, Limit=None):
        if self.fail:
            raise RuntimeError("boom")
        key = ExpressionAttributeValues[":b"]
        rows = sorted((i for i in self.items if i["building_id"] == key), key=lambda i: i["sort_key"],
                      reverse=not ScanIndexForward)
        return {"Items": rows[:Limit]}


def invoke(method, path, body=None, query=None, raw_body=None):
    event = {"requestContext": {"http": {"method": method}}, "rawPath": path, "queryStringParameters": query}
    if body is not None:
        event["body"] = json.dumps(body)
    if raw_body is not None:
        event["body"] = raw_body
    response = app.handler(event, None)
    return response["statusCode"], (json.loads(response["body"]) if response["body"] else None)


class ApiHandlerTests(unittest.TestCase):
    def test_simulate_api_returns_result(self):
        status, body = invoke("POST", "/simulate", INPUT)
        self.assertEqual(status, 200)
        self.assertEqual(body["calculatedBy"], "aws-lambda")
        self.assertEqual(body["result"]["forecastDeadlineDays"], 3)

    def test_invalid_simulation_returns_400(self):
        status, body = invoke("POST", "/simulate", {**INPUT, "currentStockLiters": 20000})
        self.assertEqual(status, 400)
        self.assertIn("cannot exceed", body["error"])

    def test_bad_json_and_large_body_return_400(self):
        self.assertEqual(invoke("POST", "/simulate", raw_body="{not json")[0], 400)
        self.assertEqual(invoke("POST", "/simulate", raw_body='{"a":"' + "x" * 30000 + '"}')[0], 400)

    def test_options_preflight(self):
        status, body = invoke("OPTIONS", "/records")
        self.assertEqual(status, 204)
        self.assertIsNone(body)

    def test_health_is_explicit_about_unconfigured_dynamodb(self):
        with patch.object(app, "TABLE_NAME", ""):
            status, body = invoke("GET", "/health")
        self.assertEqual((status, body["storage"]), (200, "not-configured"))

    def test_health_verifies_configured_table_access(self):
        with patch.object(app, "TABLE_NAME", "t"), patch.object(app, "_get_table", return_value=FakeTable()):
            status, body = invoke("GET", "/health")
        self.assertEqual((status, body["storage"]), (200, "dynamodb"))

    def test_health_reports_degraded_when_dynamodb_fails(self):
        with patch.object(app, "TABLE_NAME", "t"), patch.object(app, "_get_table", return_value=FakeTable(fail=True)):
            status, body = invoke("GET", "/health")
        self.assertEqual((status, body["storage"]), (503, "unavailable"))

    def test_save_recomputes_and_whitelists_input(self):
        table = FakeTable()
        with patch.object(app, "_get_table", return_value=table):
            status, body = invoke("POST", "/records", {
                "building_id": "Test hostel",
                "input": {**INPUT, "currentStockLiters": "8000", "evil": "x" * 50},
                "result": {"forecastDeadlineDays": 99},
                "output": {"forecastDeadlineDays": 99},
                "forecast_source": "unit-test",
                "forecast_dates": ["2026-10-10", "bad"],
            })
        self.assertEqual(status, 201)
        item = table.items[0]
        self.assertEqual(item["building_id"], "Test hostel")
        self.assertEqual(body["item"]["output"]["forecastDeadlineDays"], 3)
        self.assertNotIn("result", item)
        self.assertNotIn("evil", item["input"])
        self.assertEqual(item["forecast_source"], "unit-test")
        self.assertEqual(item["forecast_dates"], ["2026-10-10"])
        self.assertEqual(item["calculated_by"], "aws-lambda")

    def test_save_rejects_invalid_input(self):
        with patch.object(app, "_get_table", return_value=FakeTable()):
            status, body = invoke("POST", "/records", {"input": {**INPUT, "collectionEfficiency": 2}})
        self.assertEqual(status, 400)

    def test_rapid_saves_do_not_collide_and_history_is_newest_first(self):
        table = FakeTable()
        fixed = app.datetime(2026, 10, 10, tzinfo=app.timezone.utc)
        with patch.object(app, "_get_table", return_value=table), patch.object(app, "datetime") as dt:
            dt.now.return_value = fixed
            for _ in range(3):
                invoke("POST", "/records", {"building_id": "B", "input": INPUT})
        self.assertEqual(len({i["sort_key"] for i in table.items}), 3)
        with patch.object(app, "_get_table", return_value=table):
            for n in range(10):
                table.items.append({**table.items[0], "sort_key": f"2026-10-11T00:00:0{n}Z#x", "created_at": f"n{n}"})
            status, body = invoke("GET", "/history", query={"building_id": "B"})
        self.assertEqual(status, 200)
        keys = [i["sort_key"] for i in body["items"]]
        self.assertEqual(keys, sorted(keys, reverse=True))
        self.assertEqual(len(keys), 8)

    def test_server_errors_do_not_leak_details(self):
        with patch.object(app, "_get_table", return_value=FakeTable(fail=True)):
            status, body = invoke("POST", "/records", {"input": INPUT})
        self.assertEqual(status, 500)
        self.assertNotIn("arn", json.dumps(body))
        self.assertNotIn("Traceback", json.dumps(body))

    def test_not_found_route_is_404(self):
        status, body = invoke("GET", "/not-a-route")
        self.assertEqual((status, body["error"]), (404, "Route not found."))


try:
    import boto3
    from moto import mock_aws
except ImportError:  # pragma: no cover
    mock_aws = None


@unittest.skipIf(mock_aws is None, "moto/boto3 not installed (pip install -r requirements-dev.txt)")
class DynamoDbIntegrationTests(unittest.TestCase):
    """Real boto3 calls against moto's in-memory DynamoDB, same key schema as template.yaml."""

    def setUp(self):
        self.env = patch.dict(os.environ, {"AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
                                           "AWS_DEFAULT_REGION": "ap-south-1", "AWS_REGION": "ap-south-1"})
        self.env.start()
        self.mock = mock_aws()
        self.mock.start()
        boto3.client("dynamodb").create_table(
            TableName="plans", BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "building_id", "AttributeType": "S"},
                                  {"AttributeName": "sort_key", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "building_id", "KeyType": "HASH"},
                       {"AttributeName": "sort_key", "KeyType": "RANGE"}],
        )
        self.table_patch = patch.object(app, "TABLE_NAME", "plans")
        self.table_patch.start()

    def tearDown(self):
        self.table_patch.stop()
        self.mock.stop()
        self.env.stop()

    def test_health_save_and_history_roundtrip(self):
        self.assertEqual(invoke("GET", "/health")[1]["storage"], "dynamodb")
        ids = [invoke("POST", "/records", {"building_id": "Hostel A", "input": INPUT, "forecast_source": "test"})[1]["item"]["record_id"]
               for _ in range(3)]
        invoke("POST", "/records", {"building_id": "Hostel B", "input": INPUT})
        status, body = invoke("GET", "/history", query={"building_id": "Hostel A"})
        self.assertEqual(status, 200)
        self.assertEqual([i["record_id"] for i in body["items"]], list(reversed(ids)))
        first = body["items"][0]
        self.assertEqual(first["output"]["estimatedTopUpLiters"], 3520)
        self.assertEqual(first["input"]["collectionEfficiency"], 0.8)
        self.assertEqual(first["input"]["forecastMm"], [0, 0, 20, 10, 0, 0, 0])


if __name__ == "__main__":
    unittest.main()
