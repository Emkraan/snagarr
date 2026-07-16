variable "tenant_id" {
  type        = string
  description = "Entra (Azure AD) tenant ID the app registration lives in."
}

variable "app_display_name" {
  type        = string
  description = "Display name of the Entra app registration."
  default     = "sso-snagarr"
}

variable "redirect_uris" {
  type        = list(string)
  description = "Exact OIDC redirect URIs. Must match the app's /auth/callback URL(s). HTTPS only, except http://localhost for dev."
  # Example only. Provide your real values in terraform.tfvars (gitignored).
  default = [
    "https://snagarr.example.com/auth/callback",
    "http://localhost:9705/auth/callback",
  ]
}

variable "secret_end_date_relative" {
  type        = string
  description = "Client secret lifetime (Go duration). ~24 months."
  default     = "17520h"
}
