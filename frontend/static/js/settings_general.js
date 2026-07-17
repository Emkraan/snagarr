/*
 * Snagarr - General + Single Sign-On settings wiring.
 *
 * The General settings panel is now server-rendered with the Cobalt v2 macros
 * (components/settings_section.html). This module drives it:
 *   - replaces SettingsForms.generateGeneralForm so loadAllSettings() POPULATES
 *     the server-rendered inputs instead of rebuilding markup (which would wipe
 *     the Cobalt form),
 *   - wraps snagarrUI.getFormSettings so the general payload serialises the OIDC
 *     fields correctly (comma-separated group lists -> arrays, secret sentinel
 *     passed through untouched),
 *   - fetches /auth/status on each render to fill the read-only redirect URI and
 *     paint the status pill, and backs the Verify button with /auth/status?probe=1.
 *
 * Shared contract: the client secret is never handled in the clear. When a
 * secret is stored the backend returns a masking sentinel; the field is
 * prefilled with it and, if left unchanged, echoed back so the stored secret is
 * preserved (never overwritten with the mask).
 */
(function () {
  "use strict";

  var SECRET_SENTINEL = "__SNAGARR_OIDC_SECRET_SET__";

  // -- helpers -------------------------------------------------------------
  function el(id) { return document.getElementById(id); }

  function setChecked(id, on) { var e = el(id); if (e) e.checked = !!on; }

  function setValue(id, val) {
    var e = el(id);
    if (e && val !== undefined && val !== null) e.value = val;
  }

  function csvToArray(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (v === undefined || v === null) return [];
    return String(v).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function arrayToCsv(v) {
    if (Array.isArray(v)) return v.join(", ");
    return v ? String(v) : "";
  }

  function firstDefined(a, b) { return (a === undefined || a === null) ? b : a; }

  function notify(message, type) {
    if (typeof window.toast === "function") { window.toast(message, type === "error" ? "error" : "success"); return; }
    if (window.snagarrUI && typeof window.snagarrUI.showNotification === "function") {
      window.snagarrUI.showNotification(message, type);
    }
  }

  // Build a Cobalt badge with the same classes the `badge` macro emits.
  function pillHtml(text, tone) {
    var cls = "badge" + (tone && tone !== "default" ? " tone-" + tone : "");
    var span = document.createElement("span");
    span.className = cls;
    var dot = document.createElement("span");
    dot.className = "badge-dot";
    span.appendChild(dot);
    span.appendChild(document.createTextNode(text));
    return span.outerHTML;
  }

  // -- status pill + redirect URI ------------------------------------------
  function paintStatus(data) {
    data = data || {};
    var text, tone;
    if (data.source === "env") { text = "Overridden by env"; tone = "info"; }
    else if (data.configured || data.source === "settings") { text = "Configured (settings)"; tone = "success"; }
    else { text = "Not configured"; tone = "default"; }

    var slot = el("oidc_status_slot");
    if (slot) slot.innerHTML = pillHtml(text, tone);

    var uri = data.redirect_uri || "";
    var uriEl = el("oidc_redirect_uri_display");
    if (uriEl) uriEl.value = uri;
    var copyBtn = el("oidc_copy_redirect");
    if (copyBtn) copyBtn.setAttribute("data-copy", uri);
  }

  function refreshAuthStatus() {
    fetch("/auth/status", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
      .then(paintStatus)
      .catch(function () {
        var slot = el("oidc_status_slot");
        if (slot) slot.innerHTML = pillHtml("Status unavailable", "warning");
      });
  }

  function verifyOidc() {
    var btn = el("oidc_verify_btn");
    if (btn) btn.disabled = true;
    fetch("/auth/status?probe=1", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status " + r.status)); })
      .then(function (data) {
        paintStatus(data);
        if (data.metadata_reachable) notify("OIDC metadata reachable. Configuration looks valid.", "success");
        else notify(data.error || "Could not reach the tenant metadata endpoint.", "error");
      })
      .catch(function (err) { notify("Verification failed: " + err.message, "error"); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  // -- populate the server-rendered General + SSO form ---------------------
  function populateGeneral(container, settings) {
    settings = settings || {};

    setChecked("check_for_updates", settings.check_for_updates !== false);
    setChecked("debug_mode", settings.debug_mode === true);
    setChecked("display_community_resources", settings.display_community_resources !== false);
    setChecked("ssl_verify", settings.ssl_verify === true);
    setChecked("oidc_enabled", settings.oidc_enabled === true);

    setValue("log_refresh_interval_seconds", firstDefined(settings.log_refresh_interval_seconds, 30));
    setValue("api_timeout", firstDefined(settings.api_timeout, 120));
    setValue("command_wait_delay", firstDefined(settings.command_wait_delay, 1));
    setValue("command_wait_attempts", firstDefined(settings.command_wait_attempts, 600));
    setValue("minimum_download_queue_size", firstDefined(settings.minimum_download_queue_size, -1));
    if (settings.stateful_management_hours !== undefined && settings.stateful_management_hours !== null) {
      setValue("stateful_management_hours", settings.stateful_management_hours);
      updateDaysDisplay();
    }

    var authMode = settings.auth_mode ||
      (settings.proxy_auth_bypass ? "no_login" : (settings.local_access_bypass ? "local_bypass" : "login"));
    var authSel = el("auth_mode");
    if (authSel) authSel.value = authMode;

    setValue("oidc_tenant_id", settings.oidc_tenant_id || "");
    setValue("oidc_client_id", settings.oidc_client_id || "");
    setValue("oidc_allowed_groups", arrayToCsv(settings.oidc_allowed_groups));
    setValue("oidc_admin_groups", arrayToCsv(settings.oidc_admin_groups));

    var secretSet = settings.oidc_client_secret_set === true || settings.oidc_client_secret === SECRET_SENTINEL;
    var secretEl = el("oidc_client_secret");
    if (secretEl) secretEl.value = secretSet ? SECRET_SENTINEL : "";
    var hintEl = el("oidc_secret_hint");
    if (hintEl) hintEl.hidden = !secretSet;

    refreshAuthStatus();
  }

  function updateDaysDisplay() {
    var input = el("stateful_management_hours");
    var span = el("stateful_management_days");
    if (!input || !span) return;
    var hours = parseInt(input.value, 10);
    if (isNaN(hours)) return;
    span.textContent = (hours / 24).toFixed(1) + " days";
  }

  // -- install: replace form generator + wrap the collector ----------------
  function install() {
    if (window.SettingsForms) {
      // Populate the server-rendered form; do NOT rebuild its markup.
      window.SettingsForms.generateGeneralForm = function (container, settings) {
        if (container) container.setAttribute("data-app-type", "general");
        populateGeneral(container, settings);
      };
    }

    if (window.snagarrUI && typeof window.snagarrUI.getFormSettings === "function" &&
        !window.snagarrUI._oidcGeneralWrapped) {
      var original = window.snagarrUI.getFormSettings.bind(window.snagarrUI);
      window.snagarrUI.getFormSettings = function (app) {
        var s = original(app);
        if (app === "general" && s) {
          s.oidc_enabled = !!s.oidc_enabled;
          s.oidc_allowed_groups = csvToArray(s.oidc_allowed_groups);
          s.oidc_admin_groups = csvToArray(s.oidc_admin_groups);
          // Read-only display field must never be persisted.
          delete s.oidc_redirect_uri_display;
          // Leave oidc_client_secret exactly as typed: the masking sentinel (or
          // empty) tells the backend to keep the stored secret; anything else
          // is a new value.
        }
        return s;
      };
      window.snagarrUI._oidcGeneralWrapped = true;
    }
  }

  // Delegated, one-time listeners (survive form re-populates).
  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#oidc_verify_btn")) { e.preventDefault(); verifyOidc(); }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "stateful_management_hours") updateDaysDisplay();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
