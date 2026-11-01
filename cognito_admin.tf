# ---------- Адмін із фіксованими даними ----------
# Значення беруться з infra/terraform.tfvars (файл НЕ комітити, додайте його в .gitignore)

variable "admin_email" {
  type = string
}

variable "admin_password" {
  type      = string
  sensitive = true

  # Має відповідати політиці пароля пулу: 10+ символів, великі й малі літери, цифра
  validation {
    condition = (
      length(var.admin_password) >= 10 &&
      can(regex("[a-z]", var.admin_password)) &&
      can(regex("[A-Z]", var.admin_password)) &&
      can(regex("[0-9]", var.admin_password))
    )
    error_message = "Пароль адміна має містити мінімум 10 символів, великі й малі літери та цифру."
  }
}

resource "aws_cognito_user" "admin" {
  user_pool_id   = aws_cognito_user_pool.main.id
  username       = var.admin_email
  password       = var.admin_password # постійний пароль, змінювати його при першому вході не треба
  message_action = "SUPPRESS"         # не надсилати листа-запрошення

  attributes = {
    email          = var.admin_email
    email_verified = "true"
  }
}

resource "aws_cognito_user_in_group" "admin" {
  user_pool_id = aws_cognito_user_pool.main.id
  group_name   = aws_cognito_user_group.admin.name
  username     = aws_cognito_user.admin.username
}
