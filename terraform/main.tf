# Entra ID app registration for Snagarr in-app OIDC sign-in.
#
# Single-tenant confidential web app. Basic OIDC scopes (openid/profile/email)
# require no admin consent and no Microsoft Graph application permissions, so
# none are declared here. Emitting the group membership claim lets the app gate
# access on Entra security group membership.
#
# Access control groups (created outside this module; referenced as data sources):
#   sec-snagarr-admin   OID: 76e31f1d-1bcb-4584-b305-138bd858d7c9
#     -> maps to role=admin in Snagarr OIDC provider admin_groups
#
# Wire the OID in the Snagarr admin UI:
#   Settings > Single sign-on > Edit Microsoft provider
#   Admin Groups: 76e31f1d-1bcb-4584-b305-138bd858d7c9

resource "azuread_application" "snagarr" {
  display_name            = var.app_display_name
  sign_in_audience        = "AzureADMyOrg"
  group_membership_claims = ["SecurityGroup"]

  web {
    redirect_uris = var.redirect_uris

    implicit_grant {
      access_token_issuance_enabled = false
      id_token_issuance_enabled     = false
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azuread_service_principal" "snagarr" {
  client_id = azuread_application.snagarr.client_id
}

resource "azuread_application_password" "snagarr" {
  application_id    = azuread_application.snagarr.id
  display_name      = "snagarr-oidc"
  end_date_relative = var.secret_end_date_relative
}
