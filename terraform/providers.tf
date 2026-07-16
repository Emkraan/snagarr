terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }
  # Configure a remote/encrypted backend for state: it holds the client secret in
  # plaintext. Do not commit tfstate (it is gitignored). Example:
  # backend "azurerm" { ... }
}

provider "azuread" {
  tenant_id = var.tenant_id
}
