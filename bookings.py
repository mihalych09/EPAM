import json
import os
import re
import uuid
from datetime import date as date_cls
from datetime import datetime
from datetime import timezone
from decimal import Decimal

import boto3  # pyright: ignore[reportMissingImports]
from boto3.dynamodb.conditions import Attr, Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import BotoCoreError, ClientError

dynamodb = boto3.resource("dynamodb")
dynamodb_client = boto3.client("dynamodb")
bookings_table = dynamodb.Table(os.environ["BOOKINGS_TABLE"])
menu_table = dynamodb.Table(os.environ["MENU_TABLE"])
serializer = TypeSerializer()

MAX_ITEMS_PER_ORDER = 20
MAX_QTY = 20
HALL_COUNT = 5
TABLE_CAPACITIES = (2, 3, 4, 5, 5)
BOOKING_DURATION_MINUTES = 120

# Статуси: NEW -> CONFIRMED -> PREPARING -> COMPLETED (або CANCELLED)
TRANSITIONS = {
    "NEW": {"CONFIRMED", "CANCELLED"},
    "CONFIRMED": {"PREPARING", "CANCELLED"},
    "PREPARING": {"COMPLETED"},
    "COMPLETED": set(),
    "CANCELLED": set(),
}


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


def _parse_body(event):
    try:
        data = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _claims(event):
    ctx = (event.get("requestContext") or {}).get("authorizer") or {}
    return (ctx.get("jwt") or {}).get("claims") or {}


def _is_admin(claims):
    # API Gateway передає групи рядком на кшталт "[admin]" або "admin"
    groups = re.findall(r"[\w-]+", str(claims.get("cognito:groups", "")))
    return "admin" in groups


def _is_int(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def _valid_date(value):
    if not isinstance(value, str):
        return False
    try:
        return date_cls.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def _valid_time(value):
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%H:%M")
        return True
    except ValueError:
        return False


def _get_booking_items(booking_id):
    result = bookings_table.query(KeyConditionExpression=Key("pk").eq(f"BOOKING#{booking_id}"))
    meta = None
    orders = []
    for item in result.get("Items", []):
        if item["sk"] == "META":
            meta = item
        elif item["sk"].startswith("ORDER#"):
            orders.append(item)
    return meta, orders


def _booking_view(meta):
    table = meta.get("table")
    tables = meta.get("tables") or ([table] if _is_int(table, 1, 100) else [])
    return {
        "id": meta["pk"].split("#", 1)[1],
        "date": meta["date"],
        "time": meta["time"],
        "hall": meta.get("hall", 1 if tables else None),
        "tables": tables,
        "table": table,
        "guests": meta["guests"],
        "organizer": meta["organizer"],
        "phone": meta.get("phone", ""),
        "notes": meta.get("notes", ""),
        "prepaid": meta.get("prepaid", 0),
        "serve_time": meta.get("serve_time", ""),
        "status": meta["status"],
    }


def _totals(orders):
    total_amount = sum(o["subtotal"] for o in orders)
    total_items = sum(i["qty"] for o in orders for i in o["items"])
    return total_items, total_amount


def _build_summary(meta, orders):
    participants = [
        {"participant": o["participant"], "items": o["items"], "subtotal": o["subtotal"]}
        for o in sorted(orders, key=lambda o: o["participant"])
    ]
    total_items, total_amount = _totals(orders)
    prepaid = meta.get("prepaid", 0)

    warnings = []
    if len(participants) != meta["guests"] and not meta.get("group_preorder", False):
        warnings.append(
            f"Учасників у списку: {len(participants)}, гостей у бронюванні: {meta['guests']}"
        )

    return {
        "booking": _booking_view(meta),
        "participants": participants,
        "total_items": total_items,
        "total_amount": total_amount,
        "prepaid": prepaid,
        "amount_due": max(total_amount - prepaid, 0),
        "warnings": warnings,
    }


def _refresh_totals(booking_id):
    """Зберігає підсумки в META, щоб список замовлень не робив запит на кожне бронювання."""
    _, orders = _get_booking_items(booking_id)
    total_items, total_amount = _totals(orders)
    bookings_table.update_item(
        Key={"pk": f"BOOKING#{booking_id}", "sk": "META"},
        UpdateExpression="SET total_items = :i, total_amount = :a, participants_count = :p",
        ExpressionAttributeValues={":i": total_items, ":a": total_amount, ":p": len(orders)},
    )


def _prepare_order(items):
    if not isinstance(items, list) or len(items) > MAX_ITEMS_PER_ORDER:
        return None, None, f"items must be a list of up to {MAX_ITEMS_PER_ORDER} entries"

    lines = []
    subtotal = 0
    for entry in items:
        dish_id = entry.get("dish_id") if isinstance(entry, dict) else None
        qty = entry.get("qty") if isinstance(entry, dict) else None
        if not isinstance(dish_id, str) or not dish_id:
            return None, None, "Each item needs a dish_id"
        if not _is_int(qty, 1, MAX_QTY):
            return None, None, f"qty must be an integer from 1 to {MAX_QTY}"

        dish = menu_table.get_item(Key={"pk": "MENU", "sk": f"DISH#{dish_id}"}).get("Item")
        if dish is None:
            return None, None, f"Unknown dish: {dish_id}"
        if dish.get("available", True) is False:
            return None, None, f"Dish is unavailable: {dish_id}"

        price = dish["price"]
        line_total = price * qty
        subtotal += line_total
        lines.append(
            {
                "dish_id": dish_id,
                "name": dish["name"],
                "price": price,
                "qty": qty,
                "line_total": line_total,
            }
        )
    return lines, subtotal, None


def _serialized_item(item):
    return {key: serializer.serialize(value) for key, value in item.items()}


def _set_status(booking_id, current, new):
    try:
        bookings_table.update_item(
            Key={"pk": f"BOOKING#{booking_id}", "sk": "META"},
            UpdateExpression="SET #s = :new REMOVE gsi2pk, gsi2sk",
            ConditionExpression="#s = :current",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":new": new, ":current": current},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _set_booking_status(booking_id, current, new, seating=None):
    names = {"#s": "status"}
    values = {":new": new, ":current": current}
    updates = ["#s = :new"]

    if seating:
        names["#t"] = "table"
        values[":hall"] = seating["hall"]
        values[":tables"] = seating["tables"]
        values[":table"] = seating["tables"][0]
        updates.extend(["hall = :hall", "tables = :tables", "#t = :table"])

    try:
        bookings_table.update_item(
            Key={"pk": f"BOOKING#{booking_id}", "sk": "META"},
            UpdateExpression="SET " + ", ".join(updates) + " REMOVE gsi2pk, gsi2sk",
            ConditionExpression="#s = :current",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _items_for_date(day):
    items = []
    kwargs = {
        "IndexName": "by_date",
        "KeyConditionExpression": Key("gsi1pk").eq(f"DATE#{day}"),
    }
    while True:
        result = bookings_table.query(**kwargs)
        items.extend(result.get("Items", []))
        if "LastEvaluatedKey" not in result:
            break
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]
    return items


def _validate_seating(hall, tables, guests):
    if not _is_int(hall, 1, HALL_COUNT):
        return "hall must be an integer from 1 to 5"
    if (
        not isinstance(tables, list)
        or not tables
        or any(not _is_int(table, 1, len(TABLE_CAPACITIES)) for table in tables)
        or len(set(tables)) != len(tables)
    ):
        return "tables must contain unique table numbers from 1 to 5"

    ordered = sorted(tables)
    if ordered != list(range(ordered[0], ordered[-1] + 1)):
        return "combined tables must be adjacent"
    if guests <= 5 and len(ordered) != 1:
        return "groups of up to 5 guests must use one table"
    if guests > 5 and len(ordered) == 1:
        return "groups over 5 guests need adjacent tables"
    if sum(TABLE_CAPACITIES[table - 1] for table in ordered) < guests:
        return "selected tables do not have enough seats"
    return None


def _tables_are_available(booking_id, day, time, hall, tables):
    requested_minutes = int(time[:2]) * 60 + int(time[3:])
    for meta in _items_for_date(day):
        if meta["pk"] == f"BOOKING#{booking_id}" or meta.get("status") not in {"CONFIRMED", "PREPARING"}:
            continue
        existing_hall = meta.get("hall", 1)
        if existing_hall != hall:
            continue
        existing_tables = meta.get("tables") or ([meta["table"]] if meta.get("table") is not None else [])
        if not set(tables).intersection(existing_tables):
            continue
        existing_minutes = int(meta["time"][:2]) * 60 + int(meta["time"][3:])
        if abs(requested_minutes - existing_minutes) < BOOKING_DURATION_MINUTES:
            return False
    return True


def create_booking(event):
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")

    booking_date = body.get("date")
    booking_time = body.get("time")
    claims = _claims(event)
    if body.get("organizer"):
        organizer = body.get("organizer")
    else:
        organizer = claims.get("name") or claims.get("email")
    table = body.get("table")
    guests = body.get("guests")
    phone = body.get("phone", "")
    notes = body.get("notes", "")
    prepaid = body.get("prepaid", 0)
    serve_time = body.get("serve_time", "")

    if not _valid_date(booking_date):
        return _error(400, "date must be in YYYY-MM-DD format")
    if not _valid_time(booking_time):
        return _error(400, "time must be in HH:MM format")
    if not isinstance(organizer, str) or not 0 < len(organizer.strip()) <= 50:
        return _error(400, "organizer must be a string of 1-50 characters")
    if table is not None and not _is_int(table, 1, 100):
        return _error(400, "table must be an integer from 1 to 100")
    if not _is_int(guests, 1, 30):
        return _error(400, "guests must be an integer from 1 to 30")
    if not isinstance(phone, str) or len(phone) > 30:
        return _error(400, "phone must be a string up to 30 characters")
    if not isinstance(notes, str) or len(notes) > 300:
        return _error(400, "notes must be a string up to 300 characters")
    if not _is_int(prepaid, 0, 1_000_000):
        return _error(400, "prepaid must be an integer from 0 to 1000000")
    if serve_time != "" and not _valid_time(serve_time):
        return _error(400, "serve_time must be in HH:MM format")

    lines, subtotal, order_error = _prepare_order(body.get("items", []))
    if order_error:
        return _error(400, order_error)

    booking_id = uuid.uuid4().hex[:8]
    created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    booking = {
        "pk": f"BOOKING#{booking_id}",
        "sk": "META",
        "gsi1pk": f"DATE#{booking_date}",
        "gsi1sk": f"{booking_time}#{booking_id}",
        "date": booking_date,
        "time": booking_time,
        "guests": guests,
        "organizer": organizer.strip(),
        "organizer_id": claims.get("sub", ""),
        "phone": phone.strip(),
        "notes": notes.strip(),
        "prepaid": prepaid,
        "serve_time": serve_time,
        "status": "NEW",
        "created_at": created_at,
        "gsi2pk": "STATUS#NEW",
        "gsi2sk": f"{created_at}#{booking_id}",
        "total_items": sum(line["qty"] for line in lines),
        "total_amount": subtotal,
        "participants_count": 1 if lines else 0,
        **({"group_preorder": True} if lines else {}),
        **({"table": table} if table is not None else {}),
    }
    transaction = [
        {
            "Put": {
                "TableName": bookings_table.name,
                "Item": _serialized_item(booking),
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        }
    ]
    if lines:
        order = {
            "pk": f"BOOKING#{booking_id}",
            "sk": f"ORDER#{organizer.strip()}",
            "participant": organizer.strip(),
            "items": lines,
            "subtotal": subtotal,
        }
        transaction.append(
            {
                "Put": {
                    "TableName": bookings_table.name,
                    "Item": _serialized_item(order),
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        )
    try:
        dynamodb_client.transact_write_items(TransactItems=transaction)
    except ClientError as exc:
        print(
            "Booking transaction failed: "
            f"{exc.response.get('Error', {}).get('Code')}; "
            f"cancellation reasons: {exc.response.get('CancellationReasons', [])!r}"
        )
        raise
    _send_booking_notification(booking)
    return _response(201, {"id": booking_id, "status": "NEW"})


def _send_booking_notification(booking):
    recipient = os.environ.get("ADMIN_NOTIFICATION_EMAIL")
    if not recipient:
        return

    subject = f"Нове бронювання VERDE #{booking['pk'].split('#', 1)[1]}"
    body = (
        "Надійшов новий запит на бронювання.\n\n"
        f"Гість: {booking['organizer']}\n"
        f"Дата: {booking['date']} о {booking['time']}\n"
        f"Кількість гостей: {booking['guests']}\n"
        f"Номер бронювання: {booking['pk'].split('#', 1)[1]}\n"
        f"Статус: {booking['status']}\n"
    )
    try:
        boto3.client("sesv2").send_email(
            FromEmailAddress=recipient,
            Destination={"ToAddresses": [recipient]},
            Content={
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
                }
            },
        )
    except (BotoCoreError, ClientError) as exc:
        print(f"Booking notification email failed: {exc!r}")


def list_bookings(event):
    params = event.get("queryStringParameters") or {}
    day = params.get("date")
    status_filter = params.get("status")

    if not _valid_date(day):
        return _error(400, "date query parameter is required (YYYY-MM-DD)")
    if status_filter is not None and status_filter not in TRANSITIONS:
        return _error(400, "Unknown status")

    items = _items_for_date(day)

    bookings = []
    for meta in items:
        if status_filter and meta["status"] != status_filter:
            continue
        view = _booking_view(meta)
        total_amount = meta.get("total_amount", 0)
        view["total_items"] = meta.get("total_items", 0)
        view["total_amount"] = total_amount
        view["participants_count"] = meta.get("participants_count", 0)
        view["amount_due"] = max(total_amount - view["prepaid"], 0)
        bookings.append(view)

    stats = {
        "bookings": len(bookings),
        "guests": sum(b["guests"] for b in bookings),
        "needs_attention": sum(1 for b in bookings if b["status"] == "NEW"),
    }
    return _response(200, {"date": day, "stats": stats, "bookings": bookings})


def list_new_bookings(event):
    result = bookings_table.query(
        IndexName="by_status",
        KeyConditionExpression=Key("gsi2pk").eq("STATUS#NEW"),
        ScanIndexForward=False,
        Limit=50,
    )
    bookings = []
    for meta in result.get("Items", []):
        view = _booking_view(meta)
        total_amount = meta.get("total_amount", 0)
        view["created_at"] = meta.get("created_at", "")
        view["total_items"] = meta.get("total_items", 0)
        view["total_amount"] = total_amount
        view["amount_due"] = max(total_amount - view["prepaid"], 0)
        bookings.append(view)
    return _response(200, {"bookings": bookings})


def put_order(event):
    booking_id = event["pathParameters"]["id"]
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")

    participant = body.get("participant")
    items = body.get("items")

    if not isinstance(participant, str) or not 0 < len(participant.strip()) <= 50:
        return _error(400, "participant must be a string of 1-50 characters")
    meta, orders = _get_booking_items(booking_id)
    if meta is None:
        return _error(404, "Booking not found")
    claims = _claims(event)
    if meta.get("organizer_id") != claims.get("sub") and not _is_admin(claims):
        return _error(403, "You cannot edit this booking")
    if meta["status"] not in {"NEW", "CONFIRMED"}:
        return _error(409, "Order can no longer be edited")

    lines, subtotal, order_error = _prepare_order(items)
    if order_error:
        return _error(400, order_error)

    name = participant.strip()
    if meta["status"] == "CONFIRMED":
        existing = next((order for order in orders if order["participant"] == name), None)
        previous_quantities = {}
        if existing:
            for item in existing["items"]:
                previous_quantities[item["dish_id"]] = (
                    previous_quantities.get(item["dish_id"], 0) + item["qty"]
                )
        new_quantities = {}
        for item in lines:
            new_quantities[item["dish_id"]] = new_quantities.get(item["dish_id"], 0) + item["qty"]
        if not lines or any(
            new_quantities.get(dish_id, 0) < quantity
            for dish_id, quantity in previous_quantities.items()
        ):
            return _error(409, "Confirmed orders can only have dishes added")

    bookings_table.put_item(
        Item={
            "pk": f"BOOKING#{booking_id}",
            "sk": f"ORDER#{name}",
            "participant": name,
            "items": lines,
            "subtotal": subtotal,
        }
    )
    _refresh_totals(booking_id)
    return _response(200, {"participant": name, "items": lines, "subtotal": subtotal})


def get_summary(event):
    booking_id = event["pathParameters"]["id"]
    meta, orders = _get_booking_items(booking_id)
    if meta is None:
        return _error(404, "Booking not found")
    claims = _claims(event)
    if meta.get("organizer_id") != claims.get("sub") and not _is_admin(claims):
        return _error(403, "You cannot view this booking")
    return _response(200, _build_summary(meta, orders))


def confirm_booking(event):
    """Підтвердження організатором: потрібна хоча б одна страва."""
    booking_id = event["pathParameters"]["id"]
    meta, orders = _get_booking_items(booking_id)
    if meta is None:
        return _error(404, "Booking not found")
    claims = _claims(event)
    if meta.get("organizer_id") != claims.get("sub") and not _is_admin(claims):
        return _error(403, "Only the organizer can confirm the booking")
    if meta["status"] != "NEW":
        return _error(409, "Booking is already confirmed")

    summary = _build_summary(meta, orders)
    if summary["total_items"] == 0:
        return _error(400, "Cannot confirm: no dishes in the order")

    if not _set_status(booking_id, "NEW", "CONFIRMED"):
        return _error(409, "Booking is already confirmed")

    summary["booking"]["status"] = "CONFIRMED"
    return _response(200, summary)


def update_status(event):
    """Зміна статусу адміністратором (пізніше захистимо групою admin у Cognito)."""
    booking_id = event["pathParameters"]["id"]
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")

    new_status = body.get("status")
    if new_status not in TRANSITIONS:
        return _error(400, "Unknown status")

    meta, _ = _get_booking_items(booking_id)
    if meta is None:
        return _error(404, "Booking not found")

    current = meta["status"]
    if new_status not in TRANSITIONS[current]:
        return _error(409, f"Cannot change status from {current} to {new_status}")

    seating = None
    if new_status == "CONFIRMED":
        hall = body.get("hall")
        tables = body.get("tables")
        seating_error = _validate_seating(hall, tables, meta["guests"])
        if seating_error:
            return _error(400, seating_error)
        if not _tables_are_available(booking_id, meta["date"], meta["time"], hall, tables):
            return _error(409, "Selected tables are no longer available; choose another free place")
        seating = {"hall": hall, "tables": sorted(tables)}

    if not _set_booking_status(booking_id, current, new_status, seating):
        return _error(409, "Status was changed by someone else, reload and try again")
    result = {"id": booking_id, "status": new_status}
    if seating:
        result.update(seating)
    return _response(200, result)


def remove_order(event):
    """Видалення учасника із замовлення (лише адмін, поки бронювання NEW)."""
    booking_id = event["pathParameters"]["id"]
    body = _parse_body(event)
    if body is None:
        return _error(400, "Invalid JSON")
    participant = body.get("participant")
    if not isinstance(participant, str) or not participant.strip():
        return _error(400, "participant is required")

    meta, _ = _get_booking_items(booking_id)
    if meta is None:
        return _error(404, "Booking not found")
    if meta["status"] != "NEW":
        return _error(409, "Order can no longer be edited")

    name = participant.strip()
    bookings_table.delete_item(Key={"pk": f"BOOKING#{booking_id}", "sk": f"ORDER#{name}"})
    _refresh_totals(booking_id)
    return _response(200, {"removed": name})


def list_guests(event):
    """Гості, зведені з усіх бронювань (Scan достатній для невеликого ресторану)."""
    metas = []
    kwargs = {"FilterExpression": Attr("sk").eq("META")}
    while True:
        result = bookings_table.scan(**kwargs)
        metas.extend(result.get("Items", []))
        if "LastEvaluatedKey" not in result:
            break
        kwargs["ExclusiveStartKey"] = result["LastEvaluatedKey"]

    guests = {}
    for meta in metas:
        if meta["status"] == "CANCELLED":
            continue
        phone = meta.get("phone", "")
        key = phone or meta["organizer"].lower()
        guest = guests.setdefault(
            key,
            {"name": meta["organizer"], "phone": phone, "visits": 0, "total_spent": 0, "last_date": ""},
        )
        guest["visits"] += 1
        guest["total_spent"] += meta.get("total_amount", 0)
        if meta["date"] >= guest["last_date"]:
            guest["last_date"] = meta["date"]
            guest["name"] = meta["organizer"]

    ordered = sorted(guests.values(), key=lambda g: g["last_date"], reverse=True)
    return _response(200, {"count": len(ordered), "guests": ordered})


ROUTES = {
    "POST /bookings": create_booking,
    "GET /bookings": list_bookings,
    "GET /admin/new-bookings": list_new_bookings,
    "POST /bookings/{id}/orders": put_order,
    "GET /bookings/{id}/summary": get_summary,
    "POST /bookings/{id}/confirm": confirm_booking,
    "PATCH /bookings/{id}/status": update_status,
    "POST /bookings/{id}/orders/remove": remove_order,
    "GET /guests": list_guests,
}


ADMIN_ROUTES = {
    "GET /bookings",
    "GET /admin/new-bookings",
    "PATCH /bookings/{id}/status",
    "POST /bookings/{id}/orders/remove",
    "GET /guests",
}


def handler(event, context):
    route_key = event.get("routeKey")
    route = ROUTES.get(route_key)
    if route is None:
        return _error(404, "Not found")
    if route_key in ADMIN_ROUTES and not _is_admin(_claims(event)):
        return _error(403, "Admin access required")
    try:
        return route(event)
    except Exception as exc:  # деталі лише в логах, клієнту - загальне повідомлення
        print(f"Unhandled error: {exc!r}")
        return _error(500, "Internal error")
