# ---------- DynamoDB: бронювання та замовлення учасників ----------
resource "aws_dynamodb_table" "bookings" {
  name         = "restaurant-dev-bookings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  attribute {
    name = "gsi2pk"
    type = "S"
  }

  attribute {
    name = "gsi2sk"
    type = "S"
  }

  # Список бронювань за днем (для таблиці в адмін-панелі).
  # Індекс "розріджений": у ньому лише записи META, бо тільки вони мають gsi1pk.
  global_secondary_index {
    name            = "by_date"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by_status"
    hash_key        = "gsi2pk"
    range_key       = "gsi2sk"
    projection_type = "ALL"
  }
}

# ---------- IAM: мінімальні права ----------
data "aws_iam_policy_document" "bookings_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "bookings_lambda" {
  name               = "restaurant-dev-bookings-lambda"
  assume_role_policy = data.aws_iam_policy_document.bookings_assume.json
}

resource "aws_iam_role_policy_attachment" "bookings_logs" {
  role       = aws_iam_role.bookings_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "bookings_access" {
  statement {
    actions = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:TransactWriteItems"]
    resources = [
      aws_dynamodb_table.bookings.arn,
      "${aws_dynamodb_table.bookings.arn}/index/*",
    ]
  }

  # Читання цін з таблиці меню
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.admin_notification.arn]
  }
}

resource "aws_iam_role_policy" "bookings_access" {
  name   = "bookings-dynamodb-access"
  role   = aws_iam_role.bookings_lambda.id
  policy = data.aws_iam_policy_document.bookings_access.json
}

# ---------- Lambda ----------
data "archive_file" "bookings" {
  type        = "zip"
  source_file = "${path.module}/lambda/bookings.py"
  output_path = "${path.module}/lambda/bookings.zip"
}

resource "aws_lambda_function" "bookings" {
  function_name = "restaurant-dev-bookings"
  role          = aws_iam_role.bookings_lambda.arn
  runtime       = "python3.12"
  handler       = "bookings.handler"

  filename         = data.archive_file.bookings.output_path
  source_code_hash = data.archive_file.bookings.output_base64sha256

  timeout     = 10
  memory_size = 128

  environment {
    variables = {
      BOOKINGS_TABLE = aws_dynamodb_table.bookings.name
      MENU_TABLE     = aws_dynamodb_table.main.name
      ADMIN_NOTIFICATION_EMAIL = var.admin_email
    }
  }
}

resource "aws_sesv2_email_identity" "admin_notification" {
  email_identity = var.admin_email
}

# ---------- API Gateway: інтеграція та маршрути ----------
resource "aws_apigatewayv2_integration" "bookings" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.bookings.invoke_arn
  payload_format_version = "2.0"
}

locals {
  booking_routes = [
    "POST /bookings",
    "GET /bookings",
    "GET /admin/new-bookings",
    "POST /bookings/{id}/orders",
    "GET /bookings/{id}/summary",
    "POST /bookings/{id}/confirm",
    "PATCH /bookings/{id}/status",
    "POST /bookings/{id}/orders/remove",
    "GET /guests",
  ]
}

resource "aws_apigatewayv2_route" "bookings" {
  for_each  = toset(local.booking_routes)
  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.bookings.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_lambda_permission" "bookings_api" {
  statement_id  = "AllowAPIGatewayInvokeBookings"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bookings.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
