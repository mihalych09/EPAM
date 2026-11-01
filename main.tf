terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

resource "aws_dynamodb_table" "main" {
  name         = "restaurant-dev"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }
}

locals {
  dishes = {
    borscht    = { name = "Борщ з пампушками", price = 180, category = "soup" }
    applejuice = { name = "Яблучний сік", price = 50, category = "drink" }
    pureshka   = { name = "Пюрешка з котлеткою", price = 120, category = "main" }
    coffee     = { name = "Кава", price = 60, category = "drink" }
  }
}
resource "aws_dynamodb_table_item" "dish" {
  for_each = local.dishes

  table_name = aws_dynamodb_table.main.name
  hash_key   = aws_dynamodb_table.main.hash_key
  range_key  = aws_dynamodb_table.main.range_key
  item = jsonencode({
    pk       = { S = "MENU" }
    sk       = { S = "DISH#${each.key}" }
    name     = { S = each.value.name }
    price    = { N = tostring(each.value.price) }
    category = { S = each.value.category }
  })
}
