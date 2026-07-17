/*
 * Snagarr - General settings wiring.
 *
 * The General settings panel is server-rendered with the Cobalt macros
 * (components/settings_section.html). This module replaces
 * SettingsForms.generateGeneralForm so loadAllSettings() POPULATES the
 * server-rendered inputs instead of rebuilding markup (which would wipe the
 * Cobalt form).
 *
 * Single sign-on has its own provider-agnostic panel driven by sso.js and the
 * /api/sso/* endpoints; it is intentionally NOT handled here.
 */
(function () {
  "use strict";

  function el(id) { return document.getElementById(id); }
  function setChecked(id, on) { var e = el(id); if (e) e.checked = !!on; }
  function setValue(id, val) { var e = el(id); if (e && val !== undefined && val !== null) e.value = val; }
  function firstDefined(a, b) { return (a === undefined || a === null) ? b : a; }

  function updateDaysDisplay() {
    var input = el("stateful_management_hours");
    var span = el("stateful_management_days");
    if (!input || !span) return;
    var hours = parseInt(input.value, 10);
    if (isNaN(hours)) return;
    span.textContent = (hours / 24).toFixed(1) + " days";
  }

  // -- populate the server-rendered General form ---------------------------
  function populateGeneral(container, settings) {
    settings = settings || {};

    setChecked("check_for_updates", settings.check_for_updates !== false);
    setChecked("debug_mode", settings.debug_mode === true);
    setChecked("display_community_resources", settings.display_community_resources !== false);
    setChecked("ssl_verify", settings.ssl_verify === true);

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
  }

  function install() {
    if (window.SettingsForms) {
      // Populate the server-rendered form; do NOT rebuild its markup.
      window.SettingsForms.generateGeneralForm = function (container, settings) {
        if (container) container.setAttribute("data-app-type", "general");
        populateGeneral(container, settings);
      };
    }
  }

  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "stateful_management_hours") updateDaysDisplay();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
