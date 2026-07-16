# Snagarr OIDC provisioning (OpenTofu / Terraform)

Provisions the Entra ID (Azure AD) app registration that backs Snagarr's in-app
OIDC sign-in. Everything here is on the Entra ID Free tier, so the estimated cost
is **$0/month** (app registrations, service principals, client secrets, and
security-group claims are all free; no P1/P2 or Redis is required).

## What it creates

- `azuread_application` "sso-snagarr": single-tenant confidential web app with
  your `/auth/callback` redirect URIs and the `SecurityGroup` membership claim.
- `azuread_service_principal`: the enterprise app (required to issue tokens).
- `azuread_application_password`: a client secret (~24 month lifetime).

Basic OIDC (`openid profile email`) needs no admin consent and no Microsoft Graph
application permissions, so none are declared.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # fill in tenant_id + redirect_uris
tofu init
tofu plan
tofu apply
```

The provider authenticates with whatever Azure credentials are in your
environment (a service principal with rights to manage app registrations, or
`az login`).

## Handling the outputs

The client id, tenant id, and (sensitive) client secret are outputs. Do **not**
print the secret to a shared console or commit it. Move it straight into your
secret manager, then have the app read it from a mounted file via the
`OIDC_CLIENT_ID_FILE` / `OIDC_CLIENT_SECRET_FILE` / `OIDC_TENANT_ID_FILE`
environment pointers (see the app's Authentication docs).

## Notes

- `terraform.tfvars` and all `*.tfstate*` are gitignored. State contains the
  secret in plaintext, so use an encrypted/remote backend.
- The redirect URIs must match the app's public callback URL exactly, or Entra
  returns `AADSTS50011`.
- Rotate the secret before `end_date`; update the secret manager and redeploy.
