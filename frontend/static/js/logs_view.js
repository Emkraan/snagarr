/*
 * Snagarr - Logs view wiring (Cobalt v2).
 *
 * The Logs panel is now server-rendered with the Cobalt macros
 * (components/logs_section.html). This module OVERRIDES the old per-section
 * loaders on window.snagarrUI so the server-rendered panel is used instead of
 * the legacy inline-styled markup:
 *
 *   - snagarrUI.connectToLogs      -> opens the SSE stream for the current app
 *   - snagarrUI.connectEventSource -> parses each line and appends a tone-classed
 *                                     entry into the server-rendered #logsContainer
 *
 * Everything else (element caching, the auto-scroll / clear / search / app-select
 * listeners, disconnectAllEventSources, clearLogs, searchLogs, clearLogSearch)
 * lives in new-main.js and keeps working unchanged because we preserve the same
 * element ids (#logsContainer, #logAppSelect, #autoScrollCheckbox,
 * #clearLogsButton, #logConnectionStatus, #logSearchInput, #logSearchButton,
 * #clearSearchButton, #logSearchResults) and the same entry classes
 * (.log-entry, .log-timestamp, .log-app, .log-level, .log-logger, .log-message,
 * .search-highlight). We do NOT rebuild the panel markup - we populate it.
 *
 * Behaviours preserved: per-app filtering (all / system / per-arr / swaparr),
 * level colour-coding via tone tokens, swaparrLogReceived custom-event dispatch,
 * auto-scroll, connection-status indicator, and reconnect-after-5s while the
 * user stays on the Logs section (GET /logs?app=<app> SSE).
 */
(function () {
  "use strict";

  // Log line format: optional "[APP] ", timestamp, " - logger - LEVEL - message".
  // e.g.  [SONARR] 2024-01-01 12:00:00 - snagarr.sonarr - INFO - Message
  //       2024-01-01 12:00:00 - snagarr - DEBUG - System message
  var LOG_RE = /^(?:\[(\w+)\]\s)?([\d\-]+\s[\d:]+)\s-\s([\w\.]+)\s-\s(\w+)\s-\s(.*)$/;

  var ARR_APPS = ["sonarr", "radarr", "lidarr", "readarr", "whisparr", "eros", "swaparr"];

  // App-specific phrases that may appear in otherwise-untagged "system" lines.
  var SYSTEM_PATTERNS = {
    sonarr:   ["episode", "series", "tv show", "sonarr"],
    radarr:   ["movie", "film", "radarr"],
    lidarr:   ["album", "artist", "track", "music", "lidarr"],
    readarr:  ["book", "author", "readarr"],
    whisparr: ["scene", "adult", "whisparr"],
    eros:     ["eros", "whisparr v3", "whisparrv3"],
    swaparr:  ["added strike", "max strikes reached", "would have removed",
               "strikes, removing download", "processing stalled downloads", "swaparr"]
  };

  function setStatus(ui, text, cls) {
    updateStreamDot(cls);
    var el = ui.elements && ui.elements.logConnectionStatus;
    if (!el) return;
    el.textContent = text;
    el.className = cls || "";
  }

  // ── Level-distribution strip (header hero) ──────────────────────────────
  // Counts are derived from the REAL loaded buffer: we scan the tone-classed
  // .log-entry nodes already appended to #logsContainer. A MutationObserver
  // keeps the strip in sync on append AND on Clear / app-switch (childList
  // shrinks), so an empty buffer hides the strip instead of showing zeros.
  var stripTimer = null;
  var stripObserver = null;

  function getLogContainer() {
    return (window.snagarrUI && window.snagarrUI.elements && window.snagarrUI.elements.logsContainer) ||
      document.getElementById("logsContainer");
  }

  // Mirror the SSE connection state onto the pulse dot: accent + live pulse
  // while streaming, danger on error, muted otherwise. No pulse when not live.
  function updateStreamDot(cls) {
    var dot = document.getElementById("logStreamDot");
    if (!dot) return;
    var tone = "tone-muted", live = false;
    if (cls === "status-connected") { tone = "tone-accent"; live = true; }
    else if (cls === "status-error") { tone = "tone-danger"; }
    dot.className = "status-dot " + tone + (live ? " dot-live" : "");
  }

  function setChip(id, val) {
    var v = document.getElementById(id);
    if (!v) return;
    v.textContent = String(val);
    var chip = v.closest ? v.closest(".lls-chip") : null;
    if (chip) chip.classList.toggle("is-zero", val === 0);
  }

  function renderStrip() {
    stripTimer = null;
    var strip = document.getElementById("logLevelStrip");
    if (!strip) return;
    var c = getLogContainer();
    var error = 0, warn = 0, info = 0, debug = 0;
    if (c) {
      error = c.querySelectorAll(".log-error").length;
      warn = c.querySelectorAll(".log-warning, .log-warn").length;
      info = c.querySelectorAll(".log-info").length;
      debug = c.querySelectorAll(".log-debug").length;
    }
    // Hide entirely when the buffer holds none of the four tracked levels, so
    // an empty (or cleared) stream never shows a row of zeros as if broken.
    if (error + warn + info + debug <= 0) { strip.hidden = true; return; }
    strip.hidden = false;
    setChip("llsError", error);
    setChip("llsWarn", warn);
    setChip("llsInfo", info);
    setChip("llsDebug", debug);
  }

  // Throttle: coalesce bursts of incoming lines into one recompute.
  function scheduleStrip() {
    if (stripTimer != null) return;
    stripTimer = setTimeout(renderStrip, 220);
  }

  function setupStrip() {
    var c = getLogContainer();
    if (!c) return;
    if (!stripObserver) {
      try {
        stripObserver = new MutationObserver(scheduleStrip);
        stripObserver.observe(c, { childList: true });
      } catch (e) { /* MutationObserver unavailable: fall back to onmessage-driven updates */ }
    }
    renderStrip();
  }

  function classifyApp(logString, match) {
    var appType = "system";
    if (match && match[1]) {
      appType = match[1].toLowerCase();
    } else if (match && match[3]) {
      var parts = match[3].split(".");
      if (parts.length > 1) {
        var candidate = parts[1].toLowerCase();
        if (ARR_APPS.indexOf(candidate) !== -1) appType = candidate;
      }
    }
    if (appType === "system") {
      var lower = logString.toLowerCase();
      for (var app in SYSTEM_PATTERNS) {
        if (!Object.prototype.hasOwnProperty.call(SYSTEM_PATTERNS, app)) continue;
        var phrases = SYSTEM_PATTERNS[app];
        for (var i = 0; i < phrases.length; i++) {
          if (lower.indexOf(phrases[i]) !== -1) { appType = app; break; }
        }
        if (appType !== "system") break;
      }
    }
    return appType;
  }

  // Build one entry node with textContent (no innerHTML) so log payloads can
  // never inject markup; the classes match what searchLogs/highlight expect.
  function buildEntry(logString, match) {
    var entry = document.createElement("div");
    entry.className = "log-entry";

    if (match) {
      var appName = match[1];
      var timestamp = match[2];
      var loggerName = match[3];
      var level = match[4];
      var message = match[5];
      var lvl = level.toLowerCase();

      var ts = document.createElement("span");
      ts.className = "log-timestamp";
      ts.title = timestamp;
      var timePart = timestamp.split(" ")[1] || timestamp;
      ts.textContent = timePart;
      entry.appendChild(ts);

      if (appName) {
        var appSpan = document.createElement("span");
        appSpan.className = "log-app";
        appSpan.title = "Source: " + appName;
        appSpan.textContent = "[" + appName + "]";
        entry.appendChild(appSpan);
      }

      var lvlSpan = document.createElement("span");
      lvlSpan.className = "log-level log-level-" + lvl;
      lvlSpan.title = "Level: " + level;
      lvlSpan.textContent = level;
      entry.appendChild(lvlSpan);

      var logger = document.createElement("span");
      logger.className = "log-logger";
      logger.title = "Logger: " + loggerName;
      logger.textContent = "(" + loggerName.replace("huntarr.", "") + ")";
      entry.appendChild(logger);

      var msg = document.createElement("span");
      msg.className = "log-message";
      msg.textContent = message;
      entry.appendChild(msg);

      entry.classList.add("log-" + lvl);
    } else {
      var fallback = document.createElement("span");
      fallback.className = "log-message";
      fallback.textContent = logString;
      entry.appendChild(fallback);

      if (logString.indexOf("ERROR") !== -1) entry.classList.add("log-error");
      else if (logString.indexOf("WARN") !== -1 || logString.indexOf("WARNING") !== -1) entry.classList.add("log-warning");
      else if (logString.indexOf("DEBUG") !== -1) entry.classList.add("log-debug");
      else entry.classList.add("log-info");
    }
    return entry;
  }

  function connectToLogs() {
    // Tear down any existing stream, then (re)open for the selected app.
    this.disconnectAllEventSources();
    this.connectEventSource(this.currentLogApp);
    setStatus(this, "Connecting...", "");
  }

  function connectEventSource(appType) {
    var self = this;

    if (this.eventSources.logs) {
      try { this.eventSources.logs.close(); } catch (e) {}
    }

    try {
      var source = new EventSource("/logs?app=" + appType);

      source.onopen = function () {
        setStatus(self, "Connected", "status-connected");
      };

      source.onmessage = function (event) {
        var container = self.elements && self.elements.logsContainer;
        if (!container) return;

        try {
          var logString = event.data;
          var match = logString.match(LOG_RE);
          var logAppType = classifyApp(logString, match);

          var shouldDisplay = self.currentLogApp === "all" || self.currentLogApp === logAppType;
          if (!shouldDisplay) return;

          container.appendChild(buildEntry(logString, match));
          scheduleStrip();

          if (logAppType === "swaparr" && self.currentLogApp === "swaparr") {
            document.dispatchEvent(new CustomEvent("swaparrLogReceived", {
              detail: { logData: (match && match[5]) ? match[5] : logString }
            }));
          }

          if (self.autoScroll) {
            container.scrollTop = container.scrollHeight;
          }
        } catch (err) {
          console.error("[snagarrUI] Error processing log message:", err, "Data:", event.data);
        }
      };

      source.onerror = function (err) {
        console.error("[snagarrUI] EventSource error for app " + self.currentLogApp + ":", err);
        setStatus(self, "Error/Disconnected", "status-error");
        if (self.eventSources.logs) {
          try { self.eventSources.logs.close(); } catch (e) {}
        }
        // Reconnect after a delay, but only while still on the Logs section.
        if (self.currentSection === "logs") {
          setTimeout(function () {
            if (self.currentSection === "logs") self.connectToLogs();
          }, 5000);
        }
      };

      this.eventSources.logs = source;
    } catch (e) {
      console.error("[snagarrUI] Failed to create EventSource for app " + appType + ":", e);
      setStatus(this, "Failed to connect", "status-error");
    }
  }

  function install() {
    if (!window.snagarrUI) return false;
    window.snagarrUI.connectToLogs = connectToLogs;
    window.snagarrUI.connectEventSource = connectEventSource;
    return true;
  }

  // new-main.js assigns window.snagarrUI synchronously at load, so install now;
  // fall back to DOMContentLoaded just in case script order changes.
  if (!install()) {
    document.addEventListener("DOMContentLoaded", install);
  }

  // Wire the header level-strip once the server-rendered DOM is available.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupStrip);
  } else {
    setupStrip();
  }
})();
