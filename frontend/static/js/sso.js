/*
 * Snagarr - Single sign-on settings (provider-agnostic), Portainer-style.
 *
 * Owns #ssoRoot in Settings. Lists configured providers; "Add provider" / "Edit"
 * open a rich MODAL with a visual provider picker (real vendor logos), dynamic
 * per-type config, a copyable redirect URI, and verify/save. Talks to:
 *   GET/POST /api/sso/providers , DELETE /api/sso/providers/<name> , GET /auth/status?verify=<name>
 * The client secret is never handled in the clear (masking sentinel round-trip).
 */
(function () {
  "use strict";

  var SENTINEL = "__SNAGARR_OIDC_SECRET_SET__";
  var state = { providers: [], redirect: "", modal: null, editing: null, type: "microsoft" };

  var PTYPES = [
    { v: "microsoft", l: "Microsoft Entra" },
    { v: "google",    l: "Google" },
    { v: "github",    l: "GitHub" },
    { v: "okta",      l: "Okta" },
    { v: "keycloak",  l: "Keycloak" },
    { v: "authentik", l: "Authentik" },
    { v: "oidc",      l: "Generic OIDC" },
    { v: "oauth2",    l: "Custom OAuth2" }
  ];
  var LABEL = {}; PTYPES.forEach(function (p) { LABEL[p.v] = p.l; });

  function root() { return document.querySelector("#ssoRoot"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(m, t) { if (typeof window.toast === "function") window.toast(m, t); }
  function iconGlyph(v) { return { okta: "fas fa-circle-notch", keycloak: "fas fa-key", authentik: "fas fa-shield-halved", oidc: "fas fa-globe", oauth2: "fas fa-right-to-bracket" }[v] || "fas fa-key"; }

  function logoHtml(v) {
    if (v === "microsoft") return '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="8.4" height="8.4" fill="#F25022"/><rect x="12.6" y="3" width="8.4" height="8.4" fill="#7FBA00"/><rect x="3" y="12.6" width="8.4" height="8.4" fill="#00A4EF"/><rect x="12.6" y="12.6" width="8.4" height="8.4" fill="#FFB900"/></svg>';
    if (v === "google") return '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#4285F4" d="M21.6 12.2c0-.6-.05-1.2-.16-1.8H12v3.4h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.1z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.6A10 10 0 0012 22z"/><path fill="#FBBC05" d="M6.4 13.9a6 6 0 010-3.8V7.5H3.1a10 10 0 000 9z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 003.1 7.5l3.3 2.6C7.2 7.7 9.4 5.9 12 5.9z"/></svg>';
    if (v === "github") return '<svg viewBox="0 0 24 24" width="22" height="22" fill="#e6edf6"><path d="M12 1.5A10.5 10.5 0 001.7 12c0 4.6 3 8.5 7.2 9.9.5.1.7-.2.7-.5v-1.7c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.3-.3-4.7-1.2-4.7-5.1 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 015 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.7 5.1.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4.2-1.4 7.2-5.3 7.2-9.9A10.5 10.5 0 0012 1.5z"/></svg>';
    return '<i class="' + iconGlyph(v) + '"></i>';
  }

  function api(method, url, body) {
    return fetch(url, { method: method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
  }
  function load() {
    return api("GET", "/api/sso/providers").then(function (d) {
      state.providers = d.providers || []; state.redirect = d.redirect_uri || ""; renderList();
    }).catch(function (e) { var r = root(); if (r) r.innerHTML = '<div class="sso-empty">Could not load providers: ' + esc(e.message) + "</div>"; });
  }

  // ---- list view ----------------------------------------------------------
  function renderList() {
    var r = root(); if (!r) return;
    var cards = state.providers.map(function (p) {
      var badges = [];
      if (p.is_default) badges.push('<span class="badge tone-accent"><span class="badge-dot"></span>Default</span>');
      badges.push(p.enabled ? '<span class="badge tone-success"><span class="badge-dot"></span>Enabled</span>' : '<span class="badge"><span class="badge-dot"></span>Disabled</span>');
      var sub = (LABEL[p.provider_type] || p.provider_type) + (p.show_on_login ? " · shown on login" : " · hidden") + (p.configured ? "" : " · not configured");
      return '<div class="sso-card" data-name="' + esc(p.name) + '"><div class="sso-plogo">' + logoHtml(p.provider_type) + "</div>" +
        '<div class="sso-meta"><div class="sso-name">' + esc(p.display_name || p.name) + " " + badges.join(" ") + "</div><div class=\"sso-sub\">" + esc(sub) + "</div></div>" +
        '<div class="sso-actions"><button class="btn btn-ghost btn-sm" data-act="verify">Verify</button>' +
        '<button class="btn btn-default btn-sm" data-act="edit">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="delete" aria-label="Delete"><i class="fas fa-trash"></i></button></div></div>';
    }).join("");
    if (!state.providers.length) cards = '<div class="sso-empty">No identity providers yet. Add one to enable single sign-on.</div>';
    r.innerHTML = cards + '<div class="sso-actions-row"><button class="btn btn-primary btn-sm" data-act="add"><i class="fas fa-plus"></i> Add provider</button></div>';
  }

  // ---- modal --------------------------------------------------------------
  function field(label, inner, hint) {
    return '<label class="field"><span class="field-label">' + esc(label) + "</span>" + inner + (hint ? '<span class="field-hint">' + hint + "</span>" : "") + "</label>";
  }
  function input(id, val, o) { o = o || {}; return '<input class="input' + (o.mono ? " mono" : "") + '" id="' + id + '" type="' + (o.type || "text") + '" value="' + esc(val || "") + '" placeholder="' + esc(o.ph || "") + '"' + (o.ro ? " readonly" : "") + ' autocomplete="off">'; }
  function sw(id, on, text) { return '<label class="swx"><span class="switch"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + '><span class="track"><span class="knob"></span></span></span>' + esc(text) + "</label>"; }

  function typeFields(p) {
    var t = p.provider_type;
    if (t === "microsoft") return field("Tenant ID", input("m_tenant", p.tenant, { mono: true, ph: "00000000-0000-0000-0000-000000000000" }), "Directory (tenant) ID from your Entra app registration.");
    if (t === "okta" || t === "keycloak" || t === "authentik")
      return field("Issuer URL", input("m_issuer", p.issuer, { mono: true, ph: "https://id.example.com" + (t === "keycloak" ? "/realms/main" : "") }), "The discovery document is derived from this issuer.");
    if (t === "oidc")
      return field("Discovery URL", input("m_discovery_url", p.discovery_url, { mono: true, ph: "https://idp.example.com/.well-known/openid-configuration" }), "The issuer's <code>/.well-known/openid-configuration</code>.");
    if (t === "oauth2")
      return '<div class="sso-mgrid">' + field("Authorization URL", input("m_authorize_url", p.authorize_url, { mono: true, ph: "https://…/authorize" })) + field("Token URL", input("m_token_url", p.token_url, { mono: true, ph: "https://…/token" })) + "</div>" +
        '<div class="sso-mgrid">' + field("Userinfo URL", input("m_userinfo_url", p.userinfo_url, { mono: true, ph: "https://…/userinfo" })) + field("Username claim", input("m_username_claim", p.username_claim || "preferred_username", { mono: true })) + "</div>";
    if (t === "github") return '<p class="field-hint">GitHub is OAuth2 (not OIDC). Groups derive from your org/teams via the <code>read:org</code> scope.</p>';
    return "";  // google
  }

  function openEditor(p) {
    p = p || { provider_type: "microsoft", enabled: true, show_on_login: true };
    state.editing = p.name || null;
    state.type = p.provider_type || "microsoft";
    var secretSet = p.client_secret_set === true || p.client_secret === SENTINEL;
    var pick = PTYPES.map(function (t) {
      return '<div class="sso-pick-card' + (t.v === state.type ? " on" : "") + '" data-pick="' + t.v + '"><span class="pl">' + logoHtml(t.v) + '</span><span class="pn">' + esc(t.l) + "</span></div>";
    }).join("");
    var back = document.createElement("div");
    back.className = "sso-modal-backdrop";
    back.innerHTML =
      '<div class="sso-modal" role="dialog" aria-modal="true">' +
        '<div class="sso-modal-head"><h3>' + (state.editing ? "Edit identity provider" : "Add identity provider") + '</h3>' +
          '<button class="x" data-msso="close" aria-label="Close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
        '<div class="sso-modal-body">' +
          '<div><div class="sso-sublabel">Provider</div><div class="sso-pick" id="m_pick">' + pick + "</div></div>" +
          '<div id="m_typefields">' + typeFields({ provider_type: state.type, tenant: p.tenant, issuer: p.issuer, discovery_url: p.discovery_url, authorize_url: p.authorize_url, token_url: p.token_url, userinfo_url: p.userinfo_url, username_claim: p.username_claim }) + "</div>" +
          '<div class="sso-mgrid">' + field("Display name", input("m_display_name", p.display_name || LABEL[state.type], { ph: "Microsoft Entra ID" })) +
            field("Provider key", input("m_name", p.name || state.type, { mono: true }), "Unique id in the callback URL. Lowercase.") + "</div>" +
          '<div class="sso-mgrid">' + field("Client ID", input("m_client_id", p.client_id, { mono: true, ph: "application (client) id" })) +
            field("Client secret", input("m_client_secret", secretSet ? SENTINEL : "", { type: "password", ph: secretSet ? "(unchanged)" : "client secret" }), secretSet ? "A secret is stored — leave unchanged to keep it." : "") + "</div>" +
          '<div class="sso-mgrid">' + field("Allowed groups", input("m_allowed_groups", (p.allowed_groups || []).join(", "), { ph: "group-a, group-b" }), "Comma-separated. Empty = any authenticated user.") +
            field("Admin groups", input("m_admin_groups", (p.admin_groups || []).join(", "), { ph: "snagarr-admins" }), "Granted admin access.") + "</div>" +
          '<div class="sso-switch-row">' + sw("m_enabled", p.enabled !== false, "Enabled") + sw("m_show_on_login", p.show_on_login !== false, "Show on login") + sw("m_is_default", !!p.is_default, "Default provider") + "</div>" +
          field("Redirect URI — add this at your provider", '<div class="copyrow">' + input("m_redirect", state.redirect, { mono: true, ro: true }) + '<button class="btn btn-default" data-msso="copy"><i class="fas fa-copy"></i> Copy</button></div>') +
        "</div>" +
        '<div class="sso-modal-foot"><button class="btn btn-default" data-msso="verify"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L20 7"/></svg> Verify</button>' +
          '<span class="spacer"></span><button class="btn btn-ghost" data-msso="close">Cancel</button>' +
          '<button class="btn btn-primary" data-msso="save"><i class="fas fa-save"></i> Save provider</button></div>' +
      "</div>";
    document.body.appendChild(back);
    state.modal = back;
    back.addEventListener("mousedown", function (e) { if (e.target === back) close(); });
    back.__esc = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", back.__esc);
  }
  function close() {
    if (!state.modal) return;
    document.removeEventListener("keydown", state.modal.__esc);
    state.modal.remove(); state.modal = null; state.editing = null;
  }
  function setType(v) {
    state.type = v;
    state.modal.querySelectorAll(".sso-pick-card").forEach(function (c) { c.classList.toggle("on", c.dataset.pick === v); });
    document.getElementById("m_typefields").innerHTML = typeFields({ provider_type: v });
    var dn = document.getElementById("m_display_name"), nm = document.getElementById("m_name");
    if (dn && (!dn.value || Object.values(LABEL).indexOf(dn.value) > -1)) dn.value = LABEL[v];
    if (nm && (!nm.value || PTYPES.some(function (t) { return t.v === nm.value; }))) nm.value = v;
  }

  function mval(id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; }
  function mchk(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  function mcsv(id) { return mval(id).split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
  function collect() {
    var t = state.type;
    var p = { name: (mval("m_name") || t).toLowerCase().replace(/[^a-z0-9_-]/g, "-"), display_name: mval("m_display_name") || LABEL[t], provider_type: t,
      enabled: mchk("m_enabled"), show_on_login: mchk("m_show_on_login"), is_default: mchk("m_is_default"),
      client_id: mval("m_client_id"), client_secret: (document.getElementById("m_client_secret") || {}).value || "",
      allowed_groups: mcsv("m_allowed_groups"), admin_groups: mcsv("m_admin_groups") };
    if (t === "microsoft") p.tenant = mval("m_tenant");
    if (t === "okta" || t === "keycloak" || t === "authentik") p.issuer = mval("m_issuer");
    if (t === "oidc") p.discovery_url = mval("m_discovery_url");
    if (t === "oauth2") { p.authorize_url = mval("m_authorize_url"); p.token_url = mval("m_token_url"); p.userinfo_url = mval("m_userinfo_url"); p.username_claim = mval("m_username_claim") || "preferred_username"; }
    return p;
  }
  function saveProvider(then) {
    var p = collect();
    if (!p.name) { toast("A provider key is required.", "error"); return; }
    if (!p.client_id) { toast("Client ID is required.", "error"); return; }
    return api("POST", "/api/sso/providers", p).then(function () { return load().then(function () { if (then) then(p); }); })
      .catch(function (e) { toast("Save failed: " + e.message, "error"); });
  }
  function verify(name) {
    return api("GET", "/auth/status?verify=" + encodeURIComponent(name)).then(function (d) {
      var v = d.verify || {};
      if (v.ok) toast("'" + name + "' looks good — config complete and reachable.", "success");
      else toast("'" + name + "': " + (v.error || (!v.config_complete ? "client id/secret missing." : "discovery unreachable.")), "error");
    }).catch(function (e) { toast("Verify failed: " + e.message, "error"); });
  }
  function del(name) {
    if (!window.confirm("Remove the '" + name + "' provider?")) return;
    api("DELETE", "/api/sso/providers/" + encodeURIComponent(name)).then(function () { toast("Provider removed.", "success"); return load(); }).catch(function (e) { toast("Delete failed: " + e.message, "error"); });
  }

  // ---- events -------------------------------------------------------------
  document.addEventListener("click", function (e) {
    // modal actions
    if (state.modal && state.modal.contains(e.target)) {
      var pick = e.target.closest(".sso-pick-card"); if (pick) { setType(pick.dataset.pick); return; }
      var m = e.target.closest("[data-msso]"); if (!m) return; e.preventDefault();
      var act = m.dataset.msso;
      if (act === "close") close();
      else if (act === "copy") { try { navigator.clipboard && navigator.clipboard.writeText(state.redirect); } catch (x) {} toast("Redirect URI copied.", "success"); }
      else if (act === "save") { saveProvider(function () { toast("Provider saved.", "success"); close(); }); }
      else if (act === "verify") { saveProvider(function (p) { verify(p.name); }); }
      return;
    }
    // list actions
    var r = root(); if (!r || !r.contains(e.target)) return;
    var btn = e.target.closest("[data-act]"); if (!btn) return; e.preventDefault();
    var card = btn.closest(".sso-card"); var name = card ? card.dataset.name : null;
    var a = btn.dataset.act;
    if (a === "add") openEditor(null);
    else if (a === "edit") openEditor(state.providers.filter(function (p) { return p.name === name; })[0] || null);
    else if (a === "delete") del(name);
    else if (a === "verify") verify(name);
  });

  function boot() { if (root()) load(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
