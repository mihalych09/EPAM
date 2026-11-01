# ---------- Керування меню (лише адміністратор) ----------
data "aws_iam_policy_document" "menu_admin_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "menu_admin_lambda" {
  name               = "restaurant-dev-menu-admin-lambda"
  assume_role_policy = data.aws_iam_policy_document.menu_admin_assume.json
}

resource "aws_iam_role_policy_attachment" "menu_admin_logs" {
  role       = aws_iam_role.menu_admin_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "menu_admin_access" {
  statement {
    actions   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.main.arn]
  }
}

resource "aws_iam_role_policy" "menu_admin_access" {
  name   = "menu-admin-dynamodb-access"
  role   = aws_iam_role.menu_admin_lambda.id
  policy = data.aws_iam_policy_document.menu_admin_access.json
}

data "archive_file" "menu_admin" {
  type        = "zip"
  source_file = "${path.module}/lambda/menu_admin.py"
  output_path = "${path.module}/lambda/menu_admin.zip"
}

resource "aws_lambda_function" "menu_admin" {
  function_name = "restaurant-dev-menu-admin"
  role          = aws_iam_role.menu_admin_lambda.arn
  runtime       = "python3.12"
  handler       = "menu_admin.handler"

  filename         = data.archive_file.menu_admin.output_path
  source_code_hash = data.archive_file.menu_admin.output_base64sha256

  timeout     = 10
  memory_size = 128

  environment {
    variables = {
      MENU_TABLE = aws_dynamodb_table.main.name
    }
  }
}

resource "aws_apigatewayv2_integration" "menu_admin" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.menu_admin.invoke_arn
  payload_format_version = "2.0"
}

locals {
  menu_admin_routes = [
    "GET /admin/menu",
    "POST /admin/menu",
    "PUT /admin/menu/{id}",
    "DELETE /admin/menu/{id}",
  ]
}

resource "aws_apigatewayv2_route" "menu_admin" {
  for_each  = toset(local.menu_admin_routes)
  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.menu_admin.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_lambda_permission" "menu_admin_api" {
  statement_id  = "AllowAPIGatewayInvokeMenuAdmin"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.menu_admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
