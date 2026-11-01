data "archive_file" "menu" {
  type        = "zip"
  source_file = "${path.module}/lambda/menu.py"
  output_path = "${path.module}/lambda/menu.zip"
}

resource "aws_lambda_function" "menu" {
  function_name = "restaurant-dev-menu"
  role          = aws_iam_role.menu_lambda.arn
  runtime       = "python3.12"
  handler       = "menu.handler"

  filename         = data.archive_file.menu.output_path
  source_code_hash = data.archive_file.menu.output_base64sha256

  timeout     = 10
  memory_size = 128

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.main.name
    }
  }
}