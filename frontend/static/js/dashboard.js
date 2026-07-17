/*
 * Snagarr - Dashboard (home) wiring.
 *
 * The home dashboard is now server-rendered with the Cobalt v2 macros
 * (components/home_section.html). This module drives it:
 *   - overrides the legacy per-section loaders on window.snagarrUI
 *     (checkAppConnections / loadMediaStats / updateConnectionStatus /
 *     updateStatsDisplay / animateNumber / resetMediaStats / resetAppCycle) so
 *     they POPULATE the server-rendered nodes instead of rebuilding markup,
 *   - fetches GET /api/status/<app>, GET /api/stats and GET /api/hourly-caps to
 *     fill the per-arr status pill, hunted/upgraded counters and API cap badge,
 *   - hides a card when its app has 0 configured instances (and shows an empty
 *     state when none are configured),
 *   - owns the reset-all-stats button (POST /api/stats/reset_public) and the
 *     per-app cycle-reset buttons (POST /api/cycle/reset/<app>).
 *
 * Shared contract: badges are built with the same classes the Cobalt `badge`
 * macro emits, so the injected pills match the server-rendered ones exactly.
 */
(function () {
  "use strict";

  var APPS = [
    { key: "sonarr",   label: "Sonarr" },
    { key: "radarr",   label: "Radarr" },
    { key: "lidarr",   label: "Lidarr" },
    { key: "readarr",  label: "Readarr" },
    { key: "whisparr", label: "Whisparr V2" },
    { key: "eros",     label: "Whisparr V3" }
  ];
  var KEYS = APPS.map(function (a) { return a.key; });

  var POLL_MS = 30000;
  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // -- helpers -------------------------------------------------------------
  function el(id) { return document.getElementById(id); }

  function fetchJson(url, opts) {
    var f = (window.SnagarrUtils && typeof window.SnagarrUtils.fetchWithTimeout === "function")
      ? window.SnagarrUtils.fetchWithTimeout(url, opts)
      : fetch(url, opts);
    return f.then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    });
  }

  function notify(message, type) {
    if (typeof window.toast === "function") { window.toast(message, type === "error" ? "error" : "success"); return; }
    if (window.snagarrUI && typeof window.snagarrUI.showNotification === "function") {
      window.snagarrUI.showNotification(message, type);
    }
  }

  // Build a Cobalt badge with the exact classes the `badge` macro emits.
  function badgeHtml(text, tone, opts) {
    opts = opts || {};
    var cls = "badge" + (tone && tone !== "default" ? " tone-" + tone : "") + (opts.mono ? " mono" : "");
    var span = document.createElement("span");
    span.className = cls;
    if (opts.dot) {
      var dot = document.createElement("span");
      dot.className = "badge-dot";
      span.appendChild(dot);
    }
    span.appendChild(document.createTextNode(text));
    return span.outerHTML;
  }

  // Count-up animation preserving the legacy "animated number" feel.
  function animateNum(node, target) {
    if (!node) return;
    target = parseInt(target, 10) || 0;
    var start = parseInt(node.textContent.replace(/[^\d-]/g, ""), 10) || 0;
    node.dataset.countup = String(target);
    if (reduceMotion || start === target) { node.textContent = String(target); return; }
    var t0 = performance.now(), dur = 900;
    function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      var eased = k * (2 - k); // easeOutQuad
      node.textContent = String(Math.floor(start + (target - start) * eased));
      if (k < 1) requestAnimationFrame(step);
      else node.textContent = String(target);
    }
    requestAnimationFrame(step);
  }

  // -- status pill + card visibility ---------------------------------------
  function updateEmptyState() {
    var grid = el("dashboardGrid");
    var empty = el("dashboardEmpty");
    if (!grid || !empty) return;
    var anyVisible = KEYS.some(function (k) {
      var card = el(k + "Card");
      return card && card.style.display !== "none";
    });
    empty.hidden = anyVisible;
  }

  function populateStatus(app, data) {
    data = data || {};
    var card = el(app + "Card");
    var slot = el(app + "HomeStatus");

    var total = data.total_configured != null ? data.total_configured : (data.configured ? 1 : 0);
    var connected = data.connected_count != null
      ? data.connected_count
      : (data.connected ? total : 0);
    var configured = total > 0;

    if (!configured) {
      if (card) card.style.display = "none";
      updateEmptyState();
      return;
    }
    if (card) card.style.display = "";

    var tone = connected >= total ? "success" : (connected > 0 ? "warning" : "danger");
    if (slot) slot.innerHTML = badgeHtml("Connected " + connected + "/" + total, tone, { dot: true });
    updateEmptyState();
  }

  function loadStatus() {
    KEYS.forEach(function (app) {
      fetchJson("/api/status/" + app)
        .then(function (data) { populateStatus(app, data); })
        .catch(function () { populateStatus(app, { total_configured: 0 }); });
    });
  }

  // -- hunted / upgraded counters ------------------------------------------
  function populateStats(stats) {
    stats = stats || {};
    KEYS.forEach(function (app) {
      var s = stats[app];
      if (!s) return;
      animateNum(el("stat-" + app + "-hunted"), s.hunted || 0);
      animateNum(el("stat-" + app + "-upgraded"), s.upgraded || 0);
    });
  }

  function loadStats() {
    fetchJson("/api/stats")
      .then(function (data) { if (data && data.stats) populateStats(data.stats); })
      .catch(function () {});
  }

  // -- hourly API caps ------------------------------------------------------
  function populateCaps(caps, limits) {
    caps = caps || {};
    limits = limits || {};
    KEYS.forEach(function (app) {
      var slot = el(app + "Cap");
      if (!slot) return;
      var c = caps[app];
      var limit = limits[app] != null ? limits[app] : 20;
      var used = c && c.api_hits != null ? c.api_hits : 0;
      var pct = limit > 0 ? (used / limit) * 100 : 0;
      var tone = pct >= 100 ? "danger" : (pct >= 75 ? "warning" : "success");
      slot.innerHTML = badgeHtml("API " + used + "/" + limit, tone, { dot: true, mono: true });
    });
  }

  function loadCaps() {
    fetchJson("/api/hourly-caps")
      .then(function (data) {
        if (data && data.success && data.caps && data.limits) populateCaps(data.caps, data.limits);
      })
      .catch(function () {});
  }

  // -- reset controls -------------------------------------------------------
  function resetAllStats() {
    // Optimistic UI: zero every numeral immediately.
    KEYS.forEach(function (app) {
      animateNum(el("stat-" + app + "-hunted"), 0);
      animateNum(el("stat-" + app + "-upgraded"), 0);
    });
    fetchJson("/api/stats/reset_public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    })
      .then(function () { notify("Statistics reset successfully", "success"); })
      .catch(function () { notify("Statistics reset (server unavailable)", "error"); });
  }

  function resetCycle(app, btn) {
    if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
    fetchJson("/api/cycle/reset/" + app, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    })
      .then(function (data) {
        if (data && data.success) notify(app.charAt(0).toUpperCase() + app.slice(1) + " cycle reset triggered", "success");
        else notify((data && data.error) || "Failed to reset cycle", "error");
      })
      .catch(function (err) { notify("Error: " + err.message, "error"); })
      .finally(function () {
        setTimeout(function () {
          if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }, 1200);
      });
  }

  function refreshAll() { loadStatus(); loadStats(); loadCaps(); }

  // -- install: override legacy loaders on window.snagarrUI -----------------
  function install() {
    var ui = window.snagarrUI;
    if (ui && !ui._dashboardWrapped) {
      // switchSection('home') calls these; repoint them at the server-rendered nodes.
      ui.checkAppConnections   = function () { loadStatus(); };
      ui.loadMediaStats        = function () { loadStats(); loadCaps(); };
      ui.updateConnectionStatus = function (app, data) { populateStatus(app, data); };
      ui.updateStatsDisplay    = function (stats) { populateStats(stats); };
      ui.animateNumber         = function (node, _start, end) { animateNum(node, end); };
      ui.resetMediaStats       = function () { resetAllStats(); };
      ui.resetAppCycle         = function (app, btn) { resetCycle(app, btn); };
      ui._dashboardWrapped = true;
    }
  }

  // Delegated, one-time listeners (survive any re-render of the section).
  document.addEventListener("click", function (e) {
    var reset = e.target.closest && e.target.closest("#dashboardResetStats");
    if (reset) { e.preventDefault(); resetAllStats(); return; }
    var cyc = e.target.closest && e.target.closest("[data-cycle-app]");
    if (cyc) { e.preventDefault(); resetCycle(cyc.getAttribute("data-cycle-app"), cyc); }
  });

  // Keep caps + stats fresh while the dashboard is on screen.
  setInterval(function () {
    var home = el("homeSection");
    if (home && home.classList.contains("active")) { loadStats(); loadCaps(); }
  }, POLL_MS);

  function boot() { install(); refreshAll(); }

  install(); // window.snagarrUI is assigned at new-main.js load, before DOMContentLoaded.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
