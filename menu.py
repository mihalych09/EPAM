import json
import os
from decimal import Decimal

import boto3  # pyright: ignore[reportMissingImports]
from boto3.dynamodb.conditions import Key

table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])


def _json_default(value):
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Unsupported type: {type(value)}")


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(body, default=_json_default, ensure_ascii=False),
    }


def handler(event, context):
    params = event.get("queryStringParameters") or {}
    category = params.get("category")

    try:
        query_args = {
            "KeyConditionExpression": Key("pk").eq("MENU") & Key("sk").begins_with("DISH#")
        }
        items = []
        while True:
            resp = table.query(**query_args)
            items.extend(resp["Items"])
            if "LastEvaluatedKey" not in resp:
                break
            query_args["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except Exception as exc:
        print(f"DynamoDB error: {exc}")
        return _response(500, {"error": "Failed to load menu"})

    dishes = [
        {
            "id": item["sk"].removeprefix("DISH#"),
            "name": item["name"],
            "price": item["price"],
            "category": item["category"],
        }
        for item in items
        if item.get("available", True) is not False
        and (not category or item["category"] == category)
    ]

    return _response(200, {"count": len(dishes), "dishes": dishes})