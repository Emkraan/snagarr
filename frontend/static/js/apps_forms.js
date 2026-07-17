/*
 * Snagarr - Apps form generators, restyled onto the Cobalt v2 component system.
 *
 * The Apps section shell (components/apps_section.html) is server-rendered with
 * the Cobalt macros. Each app's config form is still generated in JS (instances
 * are dynamic), but this module reassigns the SettingsForms.generate<App>Form
 * builders and setupInstanceManagement so the emitted markup uses the SAME
 * classes the _ui.html macros produce (.card / .field / .input / .select /
 * .switch / .btn) instead of the legacy markup.
 *
 * Contract preserved for apps.js + settings_forms.getFormSettings:
 *   - every control keeps its original id and (for instances) name attribute,
 *   - the structural hooks .instance-item / .instances-container /
 *     .instance-actions / .add-<app>-instance-btn / .remove-instance-btn /
 *     .test-connection-btn are kept,
 *   - endpoints are unchanged: GET/POST /api/settings/<app>,
 *     POST /api/<app>/test-connection, GET/POST /api/swaparr/status|reset.
 */
(function () {
  "use strict";

  var MAX_INSTANCES = 9;

  // -- inline Lucide SVGs (verbatim from _icons.html) ----------------------
  var IC = {
    plug: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0V8z"/><path d="M12 16v6"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    layers: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    server: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2" ry="2"/><rect x="2" y="13" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg>',
    activity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  };
  var SPINNER = '<svg class="btn-spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity=".2"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

  // -- string helpers mirroring the _ui.html macro output ------------------
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // <input class="input" ...>  (matches ui.input)
  function inputHtml(o) {
    var a = "";
    if (o.id) a += ' id="' + esc(o.id) + '"';
    if (o.min !== undefined) a += ' min="' + esc(o.min) + '"';
    if (o.max !== undefined) a += ' max="' + esc(o.max) + '"';
    if (o.attrs) a += " " + o.attrs;
    return '<input class="input" type="' + esc(o.type || "text") + '"' +
      ' name="' + esc(o.name || "") + '"' +
      ' value="' + esc(o.value) + '"' +
      ' placeholder="' + esc(o.placeholder || "") + '"' + a + ">";
  }

  // <select class="select" ...>  (matches ui.select)
  function selectHtml(o) {
    var html = '<select class="select" name="' + esc(o.name || "") + '"' +
      (o.id ? ' id="' + esc(o.id) + '"' : "") + (o.attrs ? " " + o.attrs : "") + ">";
    (o.options || []).forEach(function (opt) {
      html += '<option value="' + esc(opt.value) + '"' +
        (String(opt.value) === String(o.selected) ? " selected" : "") + ">" +
        esc(opt.label) + "</option>";
    });
    return html + "</select>";
  }

  // <label class="switch">...  (matches ui.switch)
  function switchHtml(o) {
    return '<label class="switch">' +
      '<input type="checkbox" name="' + esc(o.name || "") + '"' +
      (o.id ? ' id="' + esc(o.id) + '"' : "") +
      (o.checked ? " checked" : "") + (o.attrs ? " " + o.attrs : "") + ">" +
      '<span class="track"><span class="knob"></span></span>' +
      (o.label ? '<span class="switch-label">' + esc(o.label) + "</span>" : "") +
      "</label>";
  }

  // <button class="btn btn-...">  (matches ui.button)
  function btnHtml(label, variant, o) {
    o = o || {};
    var cls = "btn btn-" + (variant || "default") + (o.sm ? " btn-sm" : "") + (o.klass ? " " + o.klass : "");
    return '<button type="' + (o.type || "button") + '" class="' + cls + '"' +
      (o.attrs ? " " + o.attrs : "") + ">" +
      (o.icon || "") + esc(label) + "</button>";
  }

  // <div class="card">...  (matches ui.card)
  function cardHtml(inner, klass) {
    return '<div class="card' + (klass ? " " + klass : "") + '">' + inner + "</div>";
  }

  // <div class="section-label">...  (matches ui.section_label)
  function sectionLabel(text, icon, count) {
    return '<div class="section-label">' +
      (icon ? '<span class="sl-ico">' + icon + "</span>" : "") + esc(text) +
      (count != null ? '<span class="sl-count">' + esc(count) + "</span>" : "") + "</div>";
  }

  // <label class="field">...  (matches ui.field). `extra` = raw html appended.
  function field(label, hint, inner, extra) {
    return '<label class="field">' +
      (label ? '<span class="field-label">' + esc(label) + "</span>" : "") +
      inner +
      (hint ? '<span class="field-hint">' + esc(hint) + "</span>" : "") +
      (extra || "") + "</label>";
  }

  // convenience field builders --------------------------------------------
  function textField(o) {
    return field(o.label, o.hint, inputHtml(o), o.extra);
  }
  function selectField(o) {
    return field(o.label, o.hint, selectHtml(o), o.extra);
  }
  function toggleField(o) {
    return field(o.label, o.hint, switchHtml(o), o.extra);
  }

  var BANNED_WARN = '<span class="field-hint danger">Setting this too high will risk your accounts being banned! You have been warned!</span>';

  // -- per-app instance metadata ------------------------------------------
  var APP_META = {
    sonarr:   { label: "Sonarr",      port: "8989" },
    radarr:   { label: "Radarr",      port: "7878" },
    lidarr:   { label: "Lidarr",      port: "8686" },
    readarr:  { label: "Readarr",     port: "8787" },
    whisparr: { label: "Whisparr V2", port: "6969" },
    eros:     { label: "Whisparr V3", port: "6969" }
  };

  function normalizeInstances(settings) {
    if (!settings.instances || !Array.isArray(settings.instances) || settings.instances.length === 0) {
      settings.instances = [{
        name: "Default",
        api_url: settings.api_url || "",
        api_key: settings.api_key || "",
        enabled: true
      }];
    }
    return settings.instances;
  }

  // One instance box (used for both initial render and dynamically-added).
  function instanceItemHtml(app, index, instance) {
    instance = instance || {};
    var meta = APP_META[app] || { label: cap(app), port: "8989" };
    var name = instance.name || "";
    var actions = "";
    if (index > 0) {
      actions += btnHtml("Remove", "ghost", { sm: true, klass: "remove-instance-btn", icon: IC.x });
    }
    actions += btnHtml("Test Connection", "default", {
      sm: true, klass: "test-connection-btn", icon: IC.plug,
      attrs: 'data-instance="' + index + '"'
    });

    var content =
      textField({ id: app + "-name-" + index, name: "name", label: "Name",
        value: name, placeholder: "Friendly name for this " + meta.label + " instance",
        hint: "Friendly name for this " + meta.label + " instance" }) +
      textField({ id: app + "-url-" + index, name: "api_url", label: "URL",
        value: instance.api_url || "",
        placeholder: "Base URL for " + meta.label + " (e.g., http://localhost:" + meta.port + ")",
        hint: "Base URL for " + meta.label + " (e.g., http://localhost:" + meta.port + ")" }) +
      textField({ id: app + "-key-" + index, name: "api_key", label: "API Key",
        value: instance.api_key || "", placeholder: "API key for " + meta.label,
        hint: "Found in your app under Settings, General, API Key" }) +
      toggleField({ id: app + "-enabled-" + index, name: "enabled", label: "Enabled",
        checked: instance.enabled !== false,
        hint: "Toggle this instance on or off without removing it" });

    return '<div class="instance-item" data-instance-id="' + index + '">' +
      '<div class="instance-header">' +
        '<span class="instance-title">Instance ' + (index + 1) + ": " + esc(name || "Unnamed") + "</span>" +
        '<div class="instance-actions">' + actions + "</div>" +
      "</div>" +
      '<div class="instance-content">' + content + "</div>" +
    "</div>";
  }

  // Instances card (section label + list + add button).
  function instancesCard(app, instances) {
    var meta = APP_META[app] || { label: cap(app) };
    var items = "";
    instances.forEach(function (inst, i) { items += instanceItemHtml(app, i, inst); });
    var addBtn = btnHtml("Add " + meta.label + " Instance (" + instances.length + "/" + MAX_INSTANCES + ")",
      "default", { sm: true, klass: "add-instance-btn add-" + app + "-instance-btn", icon: IC.plus });
    return cardHtml(
      sectionLabel(meta.label + " Instances", IC.layers) +
      '<div class="instances-container">' + items + "</div>" +
      '<div class="button-container">' + addBtn + "</div>"
    );
  }

  // Common numeric hunt/upgrade + sleep + hourly cap card body pieces.
  function cardOpen(title, icon) { return sectionLabel(title, icon) + '<div class="settings-fields">'; }

  // ---------------------------------------------------------------------
  // Generators
  // ---------------------------------------------------------------------
  function generateSonarrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "sonarr");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      selectField({ id: "sonarr-hunt-missing-mode", name: "hunt_missing_mode", label: "Missing Search Mode",
        selected: settings.hunt_missing_mode || "episodes",
        options: [{ value: "episodes", label: "Episodes" }, { value: "seasons_packs", label: "Season Packs" }, { value: "shows", label: "Shows" }],
        hint: "How to search for missing Sonarr content (Season Packs recommended for torrent users)" }) +
      selectField({ id: "sonarr-upgrade-mode", name: "upgrade_mode", label: "Upgrade Mode",
        selected: settings.upgrade_mode || "episodes",
        options: [{ value: "episodes", label: "Episodes" }, { value: "seasons_packs", label: "Season Packs" }],
        hint: "How to search for Sonarr upgrades" }) +
      textField({ id: "sonarr-hunt-missing-items", name: "hunt_missing_items", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_items !== undefined ? settings.hunt_missing_items : 1,
        hint: "Number of missing items to search per cycle (0 to disable)" }) +
      textField({ id: "sonarr-hunt-upgrade-items", name: "hunt_upgrade_items", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_items !== undefined ? settings.hunt_upgrade_items : 0,
        hint: "Number of episodes to upgrade per cycle (0 to disable)" }) +
      textField({ id: "sonarr_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "sonarr_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "sonarr_monitored_only", name: "monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "sonarr_skip_future_episodes", name: "skip_future_episodes", label: "Skip Future Episodes",
        checked: settings.skip_future_episodes !== false, hint: "Skip searching for episodes with future air dates" }) +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("sonarr", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "sonarr", instances.length);
  }

  function generateRadarrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "radarr");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      textField({ id: "radarr_hunt_missing_movies", name: "hunt_missing_movies", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_movies !== undefined ? settings.hunt_missing_movies : 1,
        hint: "Number of missing movies to search per cycle (0 to disable)" }) +
      textField({ id: "radarr_hunt_upgrade_movies", name: "hunt_upgrade_movies", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_movies !== undefined ? settings.hunt_upgrade_movies : 0,
        hint: "Number of movies to search for quality upgrades per cycle (0 to disable)" }) +
      textField({ id: "radarr_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "radarr_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var releaseTypeField = selectField({ id: "radarr_release_type", label: "Release Type for Future Status",
      selected: settings.release_type || "physical",
      options: [{ value: "digital", label: "Digital Release" }, { value: "physical", label: "Physical Release" }, { value: "cinema", label: "Cinema Release" }],
      hint: "Which release date type determines if a movie is a future release" });

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "radarr_monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "radarr_skip_future_releases", label: "Skip Future Releases",
        checked: settings.skip_future_releases !== false, hint: "Skip searching for movies with future release dates" }) +
      '<div id="future_release_type_container"' + (settings.skip_future_releases !== false ? "" : ' style="display:none;"') + ">" +
        releaseTypeField + "</div>" +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("radarr", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "radarr", instances.length);

    var skip = container.querySelector("#radarr_skip_future_releases");
    var rtc = container.querySelector("#future_release_type_container");
    if (skip && rtc) {
      skip.addEventListener("change", function () { rtc.style.display = this.checked ? "" : "none"; });
    }
  }

  function generateLidarrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "lidarr");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      selectField({ id: "lidarr_hunt_missing_mode", name: "hunt_missing_mode", label: "Missing Search Mode",
        selected: settings.hunt_missing_mode || "album",
        options: [{ value: "artist", label: "Artist" }, { value: "album", label: "Album" }],
        hint: "Search by artist (all missing albums) or individual albums" }) +
      textField({ id: "lidarr_hunt_missing_items", name: "hunt_missing_items", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_items !== undefined ? settings.hunt_missing_items : 1,
        hint: "Number of artists with missing albums to search per cycle (0 to disable)" }) +
      textField({ id: "lidarr_hunt_upgrade_items", name: "hunt_upgrade_items", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_items !== undefined ? settings.hunt_upgrade_items : 0,
        hint: "Number of albums to search for quality upgrades per cycle (0 to disable)" }) +
      textField({ id: "lidarr_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "lidarr_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "lidarr_monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "lidarr_skip_future_releases", label: "Skip Future Releases",
        checked: settings.skip_future_releases !== false, hint: "Skip searching for albums with future release dates" }) +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("lidarr", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "lidarr", instances.length);
  }

  function generateReadarrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "readarr");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      textField({ id: "readarr_hunt_missing_books", name: "hunt_missing_books", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_books !== undefined ? settings.hunt_missing_books : 1,
        hint: "Number of missing books to search per cycle (0 to disable)" }) +
      textField({ id: "readarr_hunt_upgrade_books", name: "hunt_upgrade_books", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_books !== undefined ? settings.hunt_upgrade_books : 0,
        hint: "Number of books to search for quality upgrades per cycle (0 to disable)" }) +
      textField({ id: "readarr_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "readarr_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "readarr_monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "readarr_skip_future_releases", label: "Skip Future Releases",
        checked: settings.skip_future_releases !== false, hint: "Skip searching for books with future release dates" }) +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("readarr", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "readarr", instances.length);
  }

  function generateWhisparrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "whisparr");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      textField({ id: "whisparr_hunt_missing_items", name: "hunt_missing_items", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_items !== undefined ? settings.hunt_missing_items : 1,
        hint: "Number of missing items to search per cycle (0 to disable)" }) +
      textField({ id: "whisparr_hunt_upgrade_items", name: "hunt_upgrade_items", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_items !== undefined ? settings.hunt_upgrade_items : 0,
        hint: "Number of items to search for quality upgrades per cycle (0 to disable)" }) +
      textField({ id: "whisparr_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "whisparr_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "whisparr_monitored_only", name: "monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "whisparr_skip_future_releases", name: "skip_future_releases", label: "Skip Future Releases",
        checked: settings.skip_future_releases !== false, hint: "Skip searching for scenes with future release dates" }) +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("whisparr", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "whisparr", instances.length);
  }

  function generateErosForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "eros");
    var instances = normalizeInstances(settings);

    var search = cardHtml(
      cardOpen("Search Settings", IC.search) +
      selectField({ id: "eros_search_mode", name: "search_mode", label: "Search Mode",
        selected: settings.search_mode || "movie",
        options: [{ value: "movie", label: "Movie" }, { value: "scene", label: "Scene" }],
        hint: "How to search for missing and upgradable Whisparr V3 content" }) +
      textField({ id: "eros_hunt_missing_items", name: "hunt_missing_items", type: "number", min: 0, label: "Missing Search",
        value: settings.hunt_missing_items !== undefined ? settings.hunt_missing_items : 1,
        hint: "Number of missing items to search per cycle (0 to disable)" }) +
      textField({ id: "eros_hunt_upgrade_items", name: "hunt_upgrade_items", type: "number", min: 0, label: "Upgrade Search",
        value: settings.hunt_upgrade_items !== undefined ? settings.hunt_upgrade_items : 0,
        hint: "Number of items to search for quality upgrades per cycle (0 to disable)" }) +
      textField({ id: "eros_sleep_duration", name: "sleep_duration", type: "number", min: 60, label: "Sleep Duration",
        value: settings.sleep_duration !== undefined ? settings.sleep_duration : 900,
        hint: "Time in seconds between processing cycles" }) +
      textField({ id: "eros_hourly_cap", name: "hourly_cap", type: "number", min: 1, max: 500, label: "API Cap - Hourly",
        value: settings.hourly_cap !== undefined ? settings.hourly_cap : 20,
        hint: "Maximum API requests per hour (helps prevent rate limiting)", extra: BANNED_WARN }) +
      "</div>"
    );

    var extra = cardHtml(
      cardOpen("Additional Options", IC.server) +
      toggleField({ id: "eros_monitored_only", name: "monitored_only", label: "Monitored Only",
        checked: settings.monitored_only !== false, hint: "Only search for monitored items" }) +
      toggleField({ id: "eros_skip_future_releases", name: "skip_future_releases", label: "Skip Future Releases",
        checked: settings.skip_future_releases !== false, hint: "Skip searching for scenes with future release dates" }) +
      "</div>"
    );

    container.innerHTML = '<div class="apps-stack">' + instancesCard("eros", instances) + search + extra + "</div>";
    setupInstanceManagement(container, "eros", instances.length);
  }

  function generateSwaparrForm(container, settings) {
    settings = settings || {};
    container.setAttribute("data-app-type", "swaparr");

    var intro = cardHtml(
      sectionLabel("Swaparr (Beta) - Only For Torrent Users", IC.refresh) +
      '<p class="field-hint" style="margin-top:12px;">Swaparr addresses stalled downloads and was adapted to support Snagarr. ' +
      'Visit Swaparr\'s <a href="https://github.com/ThijmenGThN/swaparr" target="_blank" rel="noopener">GitHub</a> for more information and to support the developer.</p>'
    );

    var cfg = cardHtml(
      cardOpen("Swaparr Settings", IC.server) +
      toggleField({ id: "swaparr_enabled", label: "Enable Swaparr",
        checked: settings.enabled === true, hint: "Enable automatic handling of stalled downloads" }) +
      textField({ id: "swaparr_max_strikes", type: "number", min: 1, max: 10, label: "Maximum Strikes",
        value: settings.max_strikes || 3, hint: "Number of strikes before removing a stalled download" }) +
      textField({ id: "swaparr_max_download_time", label: "Max Download Time",
        value: settings.max_download_time || "2h", hint: "Maximum time a download can be stalled (e.g., 30m, 2h, 1d)" }) +
      textField({ id: "swaparr_ignore_above_size", label: "Ignore Above Size",
        value: settings.ignore_above_size || "25GB", hint: "Ignore files larger than this size (e.g., 1GB, 25GB, 1TB)" }) +
      toggleField({ id: "swaparr_remove_from_client", label: "Remove From Client",
        checked: settings.remove_from_client !== false, hint: "Remove the download from the torrent/usenet client when removed" }) +
      toggleField({ id: "swaparr_dry_run", label: "Dry Run Mode",
        checked: settings.dry_run === true, hint: "Log actions but do not actually remove downloads. Useful for testing the first time." }) +
      "</div>"
    );

    var status = cardHtml(
      '<div class="section-label"><span class="sl-ico">' + IC.activity + "</span>Swaparr Status" +
      '<span style="margin-left:auto;">' +
        btnHtml("Reset", "danger", { sm: true, icon: IC.trash, attrs: 'id="reset_swaparr_strikes"' }) +
      "</span></div>" +
      '<div id="swaparr_status_container"><div id="swaparr_status" class="status-display" style="margin-top:14px;">' +
        "<p>Loading Swaparr status...</p></div></div>"
    );

    container.innerHTML = '<div class="apps-stack">' + intro + cfg + status + "</div>";

    var statusContainer = container.querySelector("#swaparr_status");
    var resetBtn = container.querySelector("#reset_swaparr_strikes");

    function renderStatus(data) {
      var html = "";
      if (data && data.statistics && Object.keys(data.statistics).length > 0) {
        html += "<ul>";
        Object.keys(data.statistics).forEach(function (app) {
          var stats = data.statistics[app];
          html += "<li><strong>" + esc(app.toUpperCase()) + "</strong>: ";
          if (stats.error) html += "Error: " + esc(stats.error) + "</li>";
          else html += esc(stats.currently_striked) + " currently striked, " + esc(stats.removed) +
            " removed (" + esc(stats.total_tracked) + " total tracked)</li>";
        });
        html += "</ul>";
      } else {
        html += "<p>No statistics available yet.</p>";
      }
      if (statusContainer) statusContainer.innerHTML = html;
    }

    fetch("/api/swaparr/status")
      .then(function (r) { return r.json(); })
      .then(renderStatus)
      .catch(function (err) {
        if (statusContainer) statusContainer.innerHTML = "<p>Error fetching status: " + esc(err.message) + "</p>";
      });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!confirm("Are you sure you want to reset all Swaparr strikes? This will clear the strike history for all apps.")) return;
        if (statusContainer) statusContainer.innerHTML = "<p>Resetting strikes...</p>";
        fetch("/api/swaparr/reset", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) {
              if (statusContainer) statusContainer.innerHTML = "<p>Success: " + esc(data.message) + "</p>";
              setTimeout(function () {
                fetch("/api/swaparr/status").then(function (r) { return r.json(); }).then(renderStatus);
              }, 1000);
            } else if (statusContainer) {
              statusContainer.innerHTML = "<p>Error: " + esc(data.message) + "</p>";
            }
          })
          .catch(function (err) {
            if (statusContainer) statusContainer.innerHTML = "<p>Error resetting strikes: " + esc(err.message) + "</p>";
          });
      });
    }
  }

  // ---------------------------------------------------------------------
  // Instance management: test connection + add / remove
  // ---------------------------------------------------------------------
  function notify(message, type) {
    if (typeof window.toast === "function") { window.toast(message, type === "error" ? "error" : "success"); return; }
    if (window.snagarrUI && typeof window.snagarrUI.showNotification === "function") {
      window.snagarrUI.showNotification(message, type); return;
    }
    alert(message);
  }

  function attachTest(button, app) {
    button.addEventListener("click", function (e) {
      e.preventDefault();
      var panel = button.closest(".instance-item");
      if (!panel) { notify("Error: Could not find instance panel", "error"); return; }
      var urlInput = panel.querySelector('input[name="api_url"]');
      var keyInput = panel.querySelector('input[name="api_key"]');
      if (!urlInput || !keyInput) { notify("Error: Could not find URL or API key inputs", "error"); return; }
      var url = urlInput.value.trim();
      var apiKey = keyInput.value.trim();
      if (!url) { notify("Please enter a valid URL", "error"); urlInput.focus(); return; }
      if (!apiKey) { notify("Please enter a valid API key", "error"); keyInput.focus(); return; }

      // Suppress the apps.js unsaved-changes guard while testing.
      window._suppressUnsavedChangesDialog = true;
      if (window.snagarrUI) window.snagarrUI.suppressUnsavedChangesCheck = true;

      var original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = SPINNER + " Testing...";

      fetch("/api/" + app + "/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_url: url, api_key: apiKey })
      })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP error " + r.status + ": " + r.statusText);
          return r.json();
        })
        .then(function (data) {
          button.disabled = false;
          button.innerHTML = original;
          if (data.success) {
            var msg = "Successfully connected to " + cap(app);
            if (data.version) msg += " (version " + data.version + ")";
            notify(msg, "success");
          } else {
            notify("Connection failed: " + (data.message || "Unknown error"), "error");
          }
        })
        .catch(function (err) {
          button.disabled = false;
          button.innerHTML = original;
          notify("Connection test failed: " + err.message, "error");
        })
        .finally(function () {
          setTimeout(function () {
            window._suppressUnsavedChangesDialog = false;
            if (window.snagarrUI) window.snagarrUI.suppressUnsavedChangesCheck = false;
          }, 500);
        });
    });
  }

  function attachRemove(button, container) {
    button.addEventListener("click", function () {
      var panel = button.closest(".instance-item");
      if (panel && panel.parentNode) {
        panel.parentNode.removeChild(panel);
        container.dispatchEvent(new Event("change"));
      }
    });
  }

  function setupInstanceManagement(container, app, initialCount) {
    var form = container.closest(".settings-form");
    if (form && !form.hasAttribute("data-app-type")) form.setAttribute("data-app-type", app);

    container.querySelectorAll(".test-connection-btn").forEach(function (b) { attachTest(b, app); });
    container.querySelectorAll(".remove-instance-btn").forEach(function (b) { attachRemove(b, container); });

    var addBtn = container.querySelector(".add-" + app + "-instance-btn");
    if (!addBtn) return;
    var meta = APP_META[app] || { label: cap(app) };

    function updateAddButtonText() {
      var ic = container.querySelector(".instances-container");
      if (!ic) return;
      var count = ic.querySelectorAll(".instance-item").length;
      addBtn.innerHTML = IC.plus + "Add " + meta.label + " Instance (" + count + "/" + MAX_INSTANCES + ")";
      if (count >= MAX_INSTANCES) { addBtn.disabled = true; addBtn.title = "Maximum number of instances reached"; }
      else { addBtn.disabled = false; addBtn.title = ""; }
    }
    updateAddButtonText();

    addBtn.addEventListener("click", function () {
      var ic = container.querySelector(".instances-container");
      if (!ic) return;
      var count = ic.querySelectorAll(".instance-item").length;
      if (count >= MAX_INSTANCES) { notify("Maximum of " + MAX_INSTANCES + " instances allowed", "error"); return; }

      var wrap = document.createElement("div");
      wrap.innerHTML = instanceItemHtml(app, count, { name: "Instance " + (count + 1), enabled: true });
      var node = wrap.firstChild;
      ic.appendChild(node);

      var rm = node.querySelector(".remove-instance-btn");
      if (rm) attachRemove(rm, container);
      var test = node.querySelector(".test-connection-btn");
      if (test) attachTest(test, app);

      updateAddButtonText();
      container.dispatchEvent(new Event("change"));
    });
  }

  // ---------------------------------------------------------------------
  // Install: reassign the generators on the shared SettingsForms object.
  // ---------------------------------------------------------------------
  function install() {
    var S = window.SettingsForms;
    if (!S) return;
    S.generateSonarrForm = generateSonarrForm;
    S.generateRadarrForm = generateRadarrForm;
    S.generateLidarrForm = generateLidarrForm;
    S.generateReadarrForm = generateReadarrForm;
    S.generateWhisparrForm = generateWhisparrForm;
    S.generateErosForm = generateErosForm;
    S.generateSwaparrForm = generateSwaparrForm;
    S.setupInstanceManagement = setupInstanceManagement;
  }

  install();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  }
})();
