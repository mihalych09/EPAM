import json
import os
import re
from decimal import Decimal

import boto3  # pyright: ignore[reportMissingImports]
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

table = boto3.resource("dynamodb").Table(os.environ["MENU_TABLE"])

ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
CATEGORY_RE = re.compile(r"^[a-z0-9_-]{1,30}$")


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


def _error(status, message):
    return _response(status, {"error": message})


def _claims(event):
    ctx = (event.get("requestContext") or {}).get("authorizer") or {}
    return (ctx.get("jwt") or {}).get("claims") or {}


def _is_admin(claims):
    groups = re.findall(r"[\w-]+", str(claims.get("cognito:groups", "")))
    return "admin" in groups


def _parse_body(event):
    try:
        data = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _view(item):
    return {
        "id": item.get("id") or item["sk"].split("#", 1)[1],
        "name": item["name"],
        "price": item["price"],
        "category": item.get("category", ""),
        "available": item.get("available", True),
    }


def _validate(fields, partial):
    """Повертає (очищені поля, текст помилки)."""
    clean = {}
    if "name" in fields or not partial:
        name = fields.get("name")
        if not isinstance(name, str) or not 0 < len(name.strip()) <= 80:
            return None, "name must be a string of 1-80 characters"
        clean["name"] = name.strip()
    if "price" in fields or not partial:
        price = fields.get("price")
        if not isinstance(price, int) or isinstance(price, bool) or not 1 <= price <= 100000:
            return None, "price must be an integer from 1 to 100000"
        clean["price"] = price
    if "category" in fields or not partial:
        category = fields.get("category")
        if not isinstance(category, str) or not CATEGORY_RE.match(category):
            return None, "category must be a lowercase slug (a-z, 0-9, _, -)"
        clean["category"] = category
    if "available" in fields:
        if not isinstance(fields["available"], bool):
            return None, "available must be true or false"
        clean["available"] = fields["available"]
    return clean, None


def list_dishes(event):
    items = []
    kwargs = {"KeyConditionExpression": Key("pk").eq("MENU") & Key("sk").begins_with("DISH#")}
    while True:
        result = table.query(**kwargs)
        items.extend(result.get("Items", []))
        if "LastEvaluatedKey" not in result:
            break
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]
    dishes = sorted((_view(i) for i in items), key=lambda d: (d["category"], d["name"]))
    return _response(200, {"count": len(dishes), "dishes": dishes})


def create_dish(event):
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")
    dish_id = body.get("id")
    if not isinstance(dish_id, str) or not ID_RE.match(dish_id):
        return _error(400, "id must be a lowercase slug (a-z, 0-9, _, -)")
    clean, problem = _validate(body, partial=False)
    if problem:
        return _error(400, problem)
    clean.setdefault("available", True)

    try:
        table.put_item(
            Item={"pk": "MENU", "sk": f"DISH#{dish_id}", "id": dish_id, **clean},
            ConditionExpression="attribute_not_exists(pk)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _error(409, "Dish with this id already exists")
        raise
    return _response(201, {"id": dish_id, **clean})


def update_dish(event):
    dish_id = event["pathParameters"]["id"]
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")
    fields = {k: body[k] for k in ("name", "price", "category", "available") if k in body}
    if not fields:
        return _error(400, "Nothing to update")
    clean, problem = _validate(fields, partial=True)
    if problem:
        return _error(400, problem)

    sets, names, values = [], {}, {}
    for i, (field, value) in enumerate(clean.items()):
        sets.append(f"#f{i} = :v{i}")
        names[f"#f{i}"] = field
        values[f":v{i}"] = value

    try:
        result = table.update_item(
            Key={"pk": "MENU", "sk": f"DISH#{dish_id}"},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _error(404, "Dish not found")
        raise
    return _response(200, _view(result["Attributes"]))


def delete_dish(event):
    dish_id = event["pathParameters"]["id"]
    try:
        table.delete_item(
            Key={"pk": "MENU", "sk": f"DISH#{dish_id}"},
            ConditionExpression="attribute_exists(pk)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _error(404, "Dish not found")
        raise
    return _response(200, {"deleted": dish_id})


ROUTES = {
    "GET /admin/menu": list_dishes,
    "POST /admin/menu": create_dish,
    "PUT /admin/menu/{id}": update_dish,
    "DELETE /admin/menu/{id}": delete_dish,
}


def handler(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if route is None:
        return _error(404, "Not found")
    if not _is_admin(_claims(event)):
        return _error(403, "Admin access required")
    try:
        return route(event)
    except Exception as exc:  # деталі лише в логах
        print(f"Unhandled error: {exc!r}")
        return _error(500, "Internal error")
