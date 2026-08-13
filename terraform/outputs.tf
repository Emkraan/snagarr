output "client_id" {
  description = "Application (client) ID."
  value       = azuread_application.snagarr.client_id
}

output "admin_group_oid" {
  description = "OID of the sec-snagarr-admin Entra group. Add to Snagarr provider admin_groups."
  value       = "76e31f1d-1bcb-4584-b305-138bd858d7c9"
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
