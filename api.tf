resource "aws_apigatewayv2_api" "main" {
  name          = "restaurant-dev-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [
      "http://localhost:5173",
      "https://${aws_cloudfront_distribution.frontend.domain_name}",
    ]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_integration" "menu" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.menu.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_menu" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /menu"
  target    = "integrations/${aws_apigatewayv2_integration.menu.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 10 # запитів на секунду
    throttling_burst_limit = 20
  }
}

resource "aws_lambda_permission" "apigw_menu" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.menu.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

output "menu_url" {
  value = "${aws_apigatewayv2_api.main.api_endpoint}/menu"
}
