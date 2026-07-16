output "client_id" {
  description = "Application (client) ID."
  value       = azuread_application.snagarr.client_id
}

output "tenant_id" {
  description = "Tenant ID (passthrough)."
  value       = var.tenant_id
}

output "client_secret" {
  description = "Client secret. Store in a secret manager; never commit."
  value       = azuread_application_password.snagarr.value
  sensitive   = true
}
