# Entra ID app registration for Snagarr in-app OIDC sign-in.
#
# Single-tenant confidential web app. Basic OIDC scopes (openid/profile/email)
# require no admin consent and no Microsoft Graph application permissions, so
# none are declared here. Emitting the group membership claim lets the app gate
# access on Entra security group membership.

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
