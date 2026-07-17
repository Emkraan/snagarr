/*
 * Snagarr - Single sign-on settings (provider-agnostic).
 *
 * Owns the #ssoRoot container in the Settings panel. Talks to the dedicated
 * SSO endpoints (no coupling to the general-settings form):
 *   GET    /api/sso/providers            -> { providers:[masked], redirect_uri }
 *   POST   /api/sso/providers            -> upsert one provider (secret preserved
 *                                           when the masking sentinel is sent back)
 *   DELETE /api/sso/providers/<name>     -> remove one provider
 *   GET    /auth/status?verify=<name>    -> reachability + config checks
 *
 * The client secret is never handled in the clear: a stored secret comes back as
 * a sentinel, is left in the field, and echoing it back preserves the stored value.
 */
(function () {
  "use strict";

  var SENTINEL = "__SNAGARR_OIDC_SECRET_SET__";
  var state = { providers: [], redirect: "", editing: null, verify: null };

  var PTYPES = [
    { v: "microsoft", l: "Microsoft Entra ID", icon: "fab fa-microsoft" },
    { v: "google",    l: "Google",             icon: "fab fa-google" },
    { v: "github",    l: "GitHub",             icon: "fab fa-github" },
    { v: "okta",      l: "Okta",               icon: "fas fa-circle-notch" },
    { v: "keycloak",  l: "Keycloak",           icon: "fas fa-key" },
    { v: "authentik", l: "Authentik",          icon: "fas fa-shield-halved" },
    { v: "oidc",      l: "Generic OIDC",        icon: "fas fa-globe" },
    { v: "oauth2",    l: "Custom OAuth2",       icon: "fas fa-right-to-bracket" },
  ];
  function ptype(v) { return PTYPES.filter(function (p) { return p.v === v; })[0] || PTYPES[PTYPES.length - 1]; }

  // Real brand marks where they exist (colored), else the fa glyph in accent.
  function logoHtml(v) {
    if (v === "microsoft") return '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="3" width="8.4" height="8.4" fill="#F25022"/><rect x="12.6" y="3" width="8.4" height="8.4" fill="#7FBA00"/><rect x="3" y="12.6" width="8.4" height="8.4" fill="#00A4EF"/><rect x="12.6" y="12.6" width="8.4" height="8.4" fill="#FFB900"/></svg>';
    if (v === "google") return '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="#4285F4" d="M21.6 12.2c0-.6-.05-1.2-.16-1.8H12v3.4h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.1z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.6A10 10 0 0012 22z"/><path fill="#FBBC05" d="M6.4 13.9a6 6 0 010-3.8V7.5H3.1a10 10 0 000 9z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 003.1 7.5l3.3 2.6C7.2 7.7 9.4 5.9 12 5.9z"/></svg>';
    if (v === "github") return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#e6edf6"><path d="M12 1.5A10.5 10.5 0 001.7 12c0 4.6 3 8.5 7.2 9.9.5.1.7-.2.7-.5v-1.7c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.7-1.2-4.7-5.1 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 015 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.7 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4.2-1.4 7.2-5.3 7.2-9.9A10.5 10.5 0 0012 1.5z"/></svg>';
    var pt = ptype(v);
    return '<i class="' + pt.icon + '" style="font-size:18px;color:var(--accent-bright)"></i>';
  }

  function root() { return document.querySelector("#ssoRoot"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(m, t) { if (typeof window.toast === "function") window.toast(m, t); }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function load() {
    return api("GET", "/api/sso/providers").then(function (d) {
      state.providers = d.providers || [];
      state.redirect = d.redirect_uri || "";
      state.editing = null;
      render();
    }).catch(function (e) {
      var r = root(); if (r) r.innerHTML = '<div class="sso-empty">Could not load providers: ' + esc(e.message) + "</div>";
    });
  }

  // -- field builders --------------------------------------------------------
  function field(label, inner, hint) {
    return '<label class="field"><span class="field-label">' + esc(label) + "</span>" + inner +
      (hint ? '<span class="field-hint">' + hint + "</span>" : "") + "</label>";
  }
  function input(id, val, opts) {
    opts = opts || {};
    return '<input class="input' + (opts.mono ? " mono" : "") + '" id="' + id + '" type="' + (opts.type || "text") +
      '" value="' + esc(val || "") + '" placeholder="' + esc(opts.ph || "") + '"' +
      (opts.ro ? " readonly" : "") + ' autocomplete="off">';
  }
  function sw(id, on) {
    return '<label class="switch"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") +
      '><span class="track"><span class="knob"></span></span></label>';
  }

  // Type-specific field set (client_id/secret + groups are appended for all).
  function typeFields(p) {
    var t = p.provider_type;
    if (t === "microsoft") return field("Tenant ID", input("f_tenant", p.tenant, { mono: true, ph: "00000000-0000-0000-0000-000000000000" }), "Directory (tenant) ID from your Entra app registration.");
    if (t === "google" || t === "github") return "";
    if (t === "okta" || t === "keycloak" || t === "authentik")
      return field("Issuer URL", input("f_issuer", p.issuer, { mono: true, ph: "https://id.example.com" + (t === "keycloak" ? "/realms/main" : "") }), "The base issuer; the discovery document is derived from it.");
    if (t === "oidc")
      return field("Discovery URL", input("f_discovery_url", p.discovery_url, { mono: true, ph: "https://idp.example.com/.well-known/openid-configuration" }), "The issuer's <code>/.well-known/openid-configuration</code>.");
    if (t === "oauth2")
      return '<div class="sso-grid2">' +
        field("Authorization URL", input("f_authorize_url", p.authorize_url, { mono: true, ph: "https://.../authorize" })) +
        field("Token URL", input("f_token_url", p.token_url, { mono: true, ph: "https://.../token" })) +
        "</div>" +
        '<div class="sso-grid2">' +
        field("Userinfo URL", input("f_userinfo_url", p.userinfo_url, { mono: true, ph: "https://.../userinfo" })) +
        field("Username claim", input("f_username_claim", p.username_claim || "preferred_username", { mono: true })) +
        "</div>";
    return "";
  }

  // -- render ----------------------------------------------------------------
  function render() {
    var r = root(); if (!r) return;
    r.innerHTML = state.editing ? editHtml(state.editing) : listHtml();
  }

  function listHtml() {
    var cards = state.providers.map(function (p) {
      var pt = ptype(p.provider_type);
      var badges = [];
      if (p.is_default) badges.push('<span class="badge tone-accent"><span class="badge-dot"></span>Default</span>');
      badges.push(p.enabled ? '<span class="badge tone-success"><span class="badge-dot"></span>Enabled</span>'
        : '<span class="badge"><span class="badge-dot"></span>Disabled</span>');
      var sub = pt.l + (p.show_on_login ? " · shown on login" : " · hidden from login") +
        (p.configured ? "" : " · not configured");
      return '<div class="sso-card" data-name="' + esc(p.name) + '">' +
        '<div class="sso-plogo">' + logoHtml(p.provider_type) + "</div>" +
        '<div class="sso-meta"><div class="sso-name">' + esc(p.display_name || p.name) + " " + badges.join(" ") + "</div>" +
        '<div class="sso-sub">' + esc(sub) + "</div></div>" +
        '<div class="sso-actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="verify">Verify</button>' +
        '<button class="btn btn-default btn-sm" data-act="edit">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="delete" aria-label="Delete provider"><i class="fas fa-trash"></i></button>' +
        "</div></div>";
    }).join("");
    if (!state.providers.length) cards = '<div class="sso-empty">No identity providers yet. Add one to enable single sign-on.</div>';
    return cards + '<div class="sso-actions-row"><button class="btn btn-primary btn-sm" data-act="add"><i class="fas fa-plus"></i> Add provider</button></div>';
  }

  function editHtml(p) {
    var opts = PTYPES.map(function (t) { return '<option value="' + t.v + '"' + (t.v === p.provider_type ? " selected" : "") + ">" + esc(t.l) + "</option>"; }).join("");
    var secretSet = p.client_secret_set === true || p.client_secret === SENTINEL;
    return '<div class="sso-panel">' +
      '<div class="sso-grid2">' +
        field("Display name", input("f_display_name", p.display_name || ptype(p.provider_type).l, { ph: "Microsoft Entra ID" })) +
        field("Provider key", input("f_name", p.name || p.provider_type, { mono: true, ph: "microsoft" }), "Unique id used in the callback URL. Lowercase, no spaces.") +
      "</div>" +
      field("Provider type", '<select class="select" id="f_provider_type">' + opts + "</select>") +
      '<div id="f_typefields">' + typeFields(p) + "</div>" +
      '<div class="sso-grid2">' +
        field("Client ID", input("f_client_id", p.client_id, { mono: true, ph: "application (client) id" })) +
        field("Client secret", input("f_client_secret", secretSet ? SENTINEL : "", { type: "password", ph: secretSet ? "(unchanged)" : "client secret" }), secretSet ? "A secret is stored - leave unchanged to keep it." : "") +
      "</div>" +
      '<div class="sso-grid2">' +
        field("Allowed groups", input("f_allowed_groups", (p.allowed_groups || []).join(", "), { ph: "group-a, group-b" }), "Comma-separated. Empty = any authenticated user.") +
        field("Admin groups", input("f_admin_groups", (p.admin_groups || []).join(", "), { ph: "snagarr-admins" }), "Comma-separated group/role values granted admin.") +
      "</div>" +
      '<div class="sso-grid2" style="align-items:end">' +
        field("Enabled", sw("f_enabled", p.enabled !== false)) +
        field("Show on login page", sw("f_show_on_login", p.show_on_login !== false)) +
      "</div>" +
      field("Default provider", sw("f_is_default", !!p.is_default)) +
      field("Redirect URI - register this at your provider", '<div class="sso-copyrow">' + input("f_redirect", state.redirect, { mono: true, ro: true }) + '<button class="btn btn-default" data-act="copy"><i class="fas fa-copy"></i> Copy</button></div>') +
      '<div class="sso-actions-row"><button class="btn btn-primary" data-act="save"><i class="fas fa-save"></i> Save provider</button>' +
      '<button class="btn btn-ghost" data-act="cancel">Cancel</button></div>' +
      "</div>";
  }

  // -- collect + persist -----------------------------------------------------
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; }
  function chk(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  function csv(id) { return val(id).split(",").map(function (x) { return x.trim(); }).filter(Boolean); }

  function collect() {
    var t = val("f_provider_type");
    var p = {
      name: (val("f_name") || t).toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
      display_name: val("f_display_name") || ptype(t).l,
      provider_type: t,
      enabled: chk("f_enabled"),
      show_on_login: chk("f_show_on_login"),
      is_default: chk("f_is_default"),
      client_id: val("f_client_id"),
      client_secret: document.getElementById("f_client_secret") ? document.getElementById("f_client_secret").value : "",
      allowed_groups: csv("f_allowed_groups"),
      admin_groups: csv("f_admin_groups"),
    };
    if (t === "microsoft") p.tenant = val("f_tenant");
    if (t === "okta" || t === "keycloak" || t === "authentik") p.issuer = val("f_issuer");
    if (t === "oidc") p.discovery_url = val("f_discovery_url");
    if (t === "oauth2") {
      p.authorize_url = val("f_authorize_url"); p.token_url = val("f_token_url");
      p.userinfo_url = val("f_userinfo_url"); p.username_claim = val("f_username_claim") || "preferred_username";
    }
    return p;
  }

  function save() {
    var p = collect();
    if (!p.name) { toast("A provider key is required.", "error"); return; }
    if (!p.client_id) { toast("Client ID is required.", "error"); return; }
    api("POST", "/api/sso/providers", p)
      .then(function () { toast("Provider saved.", "success"); return load(); })
      .catch(function (e) { toast("Save failed: " + e.message, "error"); });
  }

  function del(name) {
    if (!window.confirm("Remove the '" + name + "' provider? Anyone signing in with it will lose access.")) return;
    api("DELETE", "/api/sso/providers/" + encodeURIComponent(name))
      .then(function () { toast("Provider removed.", "success"); return load(); })
      .catch(function (e) { toast("Delete failed: " + e.message, "error"); });
  }

  function verify(name) {
    api("GET", "/auth/status?verify=" + encodeURIComponent(name))
      .then(function (d) {
        var v = d.verify || {};
        if (v.ok) toast("'" + name + "' looks good - config complete and reachable.", "success");
        else toast("'" + name + "': " + (v.error || (!v.config_complete ? "client id/secret missing." : "discovery endpoint unreachable.")), "error");
      })
      .catch(function (e) { toast("Verify failed: " + e.message, "error"); });
  }

  // -- events ----------------------------------------------------------------
  document.addEventListener("click", function (e) {
    var r = root(); if (!r || !r.contains(e.target)) return;
    var btn = e.target.closest("[data-act]"); if (!btn) return;
    var act = btn.dataset.act;
    var card = btn.closest(".sso-card");
    var name = card ? card.dataset.name : null;
    e.preventDefault();
    if (act === "add") { state.editing = { provider_type: "microsoft", enabled: true, show_on_login: true }; render(); }
    else if (act === "edit") { state.editing = state.providers.filter(function (p) { return p.name === name; })[0] || null; render(); }
    else if (act === "delete") { del(name); }
    else if (act === "verify") { verify(name); }
    else if (act === "save") { save(); }
    else if (act === "cancel") { state.editing = null; render(); }
    else if (act === "copy") {
      var v = state.redirect;
      try { navigator.clipboard && navigator.clipboard.writeText(v); } catch (x) {}
      toast("Redirect URI copied.", "success");
    }
  });

  // Swap the type-specific fields when the provider type changes.
  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "f_provider_type") {
      var box = document.getElementById("f_typefields");
      if (box) box.innerHTML = typeFields({ provider_type: e.target.value });
      var dn = document.getElementById("f_display_name");
      var nm = document.getElementById("f_name");
      var pt = ptype(e.target.value);
      // Freshen the default display name + key only if the user hasn't customised them.
      if (dn && (!dn.value || PTYPES.some(function (t) { return t.l === dn.value; }))) dn.value = pt.l;
      if (nm && (!nm.value || PTYPES.some(function (t) { return t.v === nm.value; }))) nm.value = e.target.value;
    }
  });

  function boot() { if (root()) load(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
