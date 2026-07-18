#!/usr/bin/env python3
"""
OpenAPI 3.0 spec for the Snagarr versioned config API (/api/v1).

Built as a function so the version string and the known-app-type enum stay in
sync with the running app. Served at GET /api/v1/openapi.json and rendered by
the interactive docs page at /api/docs. Mirrors src/primary/routes/api_v1.py.
"""

import os

from src.primary import settings_manager, api_keys


def _version():
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        with open(os.path.join(root, "VERSION")) as f:
            return f.read().strip()
    except Exception:
        return "0.0.0"


def build_spec():
    app_types = list(settings_manager.KNOWN_APP_TYPES)
    scopes = list(api_keys.SCOPES.keys())

    # Reusable response envelope refs.
    ok = {"$ref": "#/components/schemas/Envelope"}
    app_path = {
        "name": "app_name", "in": "path", "required": True,
        "description": "Target app configuration.",
        "schema": {"type": "string", "enum": app_types},
    }

    def resp(desc, ref=ok):
        return {"description": desc, "content": {"application/json": {"schema": ref}}}

    errors = {
        "401": resp("Authentication required.", {"$ref": "#/components/schemas/Error"}),
        "403": resp("Invalid key or insufficient scope.", {"$ref": "#/components/schemas/Error"}),
        "404": resp("Unknown app.", {"$ref": "#/components/schemas/Error"}),
    }

    def op(summary, tag, scope, responses, extra=None):
        o = {
            "summary": summary,
            "tags": [tag],
            "responses": {"200": resp("Success."), **responses},
        }
        if scope:
            o["security"] = [{"bearerAuth": []}, {"cookieAuth": []}]
            o["description"] = f"**Required scope:** `{scope}`. Authenticate with a Bearer API key or a logged-in session (session = admin)."
        else:
            o["description"] = "Public - no authentication required."
        if extra:
            o.update(extra)
        return o

    config_body = {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"type": "object", "additionalProperties": True},
                        "example": {"hunt_missing_items": 10, "sleep_duration": 900}}},
        }
    }

    spec = {
        "openapi": "3.0.3",
        "info": {
            "title": "Snagarr API",
            "version": _version(),
            "description": (
                "Stable, versioned programmatic configuration API for **Snagarr** - the "
                "missing & upgrade hunter for Sonarr, Radarr, Lidarr, Readarr and Whisparr.\n\n"
                "Every response uses a fixed envelope: `{ \"ok\": bool, \"data\": ..., "
                "\"error\": { \"code\", \"message\" } | null }`.\n\n"
                "### Authentication\n"
                "Send a scoped Bearer API key (`Authorization: Bearer snag_...`) or call from a "
                "logged-in browser session (treated as `admin`). Mint keys on this page or via "
                "`POST /keys`. Scopes are ordered **read < write < admin**.\n\n"
                "> Secret fields (client secrets, passwords) are masked in GET responses and "
                "preserved-unless-changed on write."
            ),
        },
        "servers": [{"url": "/api/v1", "description": "This Snagarr instance"}],
        "tags": [
            {"name": "Meta", "description": "Version, health and capabilities."},
            {"name": "Config", "description": "Read and write per-app configuration."},
            {"name": "Status", "description": "Which apps are configured."},
            {"name": "Swaparr", "description": "Stalled-download reaper settings."},
            {"name": "Stateful", "description": "Processed-media state window and reset."},
            {"name": "Cycles", "description": "Trigger a per-app hunt-cycle reset."},
            {"name": "API Keys", "description": "Mint and revoke Bearer keys (admin)."},
        ],
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "snag",
                               "description": "A scoped Snagarr API key."},
                "cookieAuth": {"type": "apiKey", "in": "cookie", "name": "session",
                               "description": "A logged-in operator session (admin scope)."},
            },
            "schemas": {
                "Envelope": {
                    "type": "object",
                    "properties": {
                        "ok": {"type": "boolean", "example": True},
                        "data": {"nullable": True, "description": "Endpoint payload."},
                        "error": {"nullable": True, "$ref": "#/components/schemas/ErrorBody"},
                    },
                    "required": ["ok", "data", "error"],
                },
                "ErrorBody": {
                    "type": "object", "nullable": True,
                    "properties": {"code": {"type": "string", "example": "forbidden"},
                                   "message": {"type": "string", "example": "Insufficient scope."}},
                },
                "Error": {
                    "type": "object",
                    "properties": {"ok": {"type": "boolean", "example": False}, "data": {"nullable": True},
                                   "error": {"$ref": "#/components/schemas/ErrorBody"}},
                },
                "KeyCreate": {
                    "type": "object", "required": ["label"],
                    "properties": {
                        "label": {"type": "string", "example": "ci-pipeline"},
                        "scope": {"type": "string", "enum": scopes, "default": "read"},
                    },
                },
            },
        },
        "paths": {
            "/health": {"get": op("Liveness + version", "Meta", None, {})},
            "/meta": {"get": op("Version, app types, API version", "Meta", "read", {"401": errors["401"]})},
            "/config": {"get": op("Read all configuration (masked)", "Config", "read", {"401": errors["401"]})},
            "/config/{app_name}": {
                "parameters": [app_path],
                "get": op("Read one app's config", "Config", "read", {"401": errors["401"], "404": errors["404"]}),
                "put": op("Replace one app's config", "Config", "write",
                          {"401": errors["401"], "404": errors["404"], "422": resp("Body must be a JSON object.", {"$ref": "#/components/schemas/Error"})}, config_body),
                "patch": op("Merge into one app's config", "Config", "write",
                            {"401": errors["401"], "404": errors["404"], "422": resp("Body must be a JSON object.", {"$ref": "#/components/schemas/Error"})}, config_body),
            },
            "/config/{app_name}/defaults": {
                "parameters": [app_path],
                "get": op("Read an app's default config", "Config", "read", {"401": errors["401"], "404": errors["404"]}),
            },
            "/config/{app_name}/reset": {
                "parameters": [app_path],
                "post": op("Reset an app's config to defaults", "Config", "write", {"401": errors["401"], "404": errors["404"]}),
            },
            "/status": {"get": op("Which apps are configured", "Status", "read", {"401": errors["401"]})},
            "/swaparr": {
                "get": op("Read Swaparr settings", "Swaparr", "read", {"401": errors["401"]}),
                "patch": op("Merge into Swaparr settings", "Swaparr", "write", {"401": errors["401"], "422": resp("Body must be a JSON object.", {"$ref": "#/components/schemas/Error"})}, config_body),
            },
            "/stateful": {"get": op("Read the stateful window (created / expires / interval)", "Stateful", "read", {"401": errors["401"]})},
            "/stateful/reset": {"post": op("Reset processed-media state now", "Stateful", "admin", {"401": errors["401"], "403": errors["403"]})},
            "/cycles/{app_name}/reset": {
                "parameters": [app_path],
                "post": op("Request a hunt-cycle reset for one app", "Cycles", "write", {"401": errors["401"], "404": errors["404"]}),
            },
            "/keys": {
                "get": op("List API keys (metadata only)", "API Keys", "admin", {"401": errors["401"], "403": errors["403"]}),
                "post": op("Mint a new API key (returned once)", "API Keys", "admin",
                           {"201": resp("Key created - the plaintext is shown once."), "401": errors["401"], "403": errors["403"],
                            "422": resp("Invalid scope.", {"$ref": "#/components/schemas/Error"})},
                           {"requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/KeyCreate"}}}}}),
            },
            "/keys/{key_id}": {
                "parameters": [{"name": "key_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                "delete": op("Revoke an API key", "API Keys", "admin", {"401": errors["401"], "403": errors["403"]}),
            },
        },
    }
    return spec
