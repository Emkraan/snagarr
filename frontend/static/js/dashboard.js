/*
 * Snagarr - Dashboard (home) wiring - Cobalt Elevated v3.1.
 *
 * Renders the premium dashboard from REAL data only (no fabricated trends):
 *   GET /api/status/<app>   -> per-app connected/total instances
 *   GET /api/stats          -> per-app hunted (searches) / upgraded counts
 *   GET /api/hourly-caps     -> per-app API hits + hourly limit
 * From those it fills: two header rings (apps online, API budget), four gradient
 * KPI cards (searches, upgrades, apps connected, API this hour), a real per-app
 * "searches by app" bar chart, and a connection-health list with conic rings.
 * Also owns Reset stats + per-app cycle reset. Overrides the legacy snagarrUI
 * loaders so switchSection('home') refreshes these nodes.
 */
(function () {
  "use strict";

  var APPS = [
    { key: "sonarr",   label: "Sonarr",      c: "#3B9EFF" },
    { key: "radarr",   label: "Radarr",      c: "#F5B301" },
    { key: "lidarr",   label: "Lidarr",      c: "#34C759" },
    { key: "readarr",  label: "Readarr",     c: "#EB5860" },
    { key: "whisparr", label: "Whisparr V2", c: "#8B7CF6" },
    { key: "eros",     label: "Whisparr V3", c: "#F65E8E" }
  ];
  var BY = {}; APPS.forEach(function (a) { BY[a.key] = a; });
  var KEYS = APPS.map(function (a) { return a.key; });
  var POLL_MS = 30000;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var state = { status: {}, stats: {}, caps: {}, limits: {} };

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function fetchJson(url, opts) {
    var f = (window.SnagarrUtils && typeof window.SnagarrUtils.fetchWithTimeout === "function")
      ? window.SnagarrUtils.fetchWithTimeout(url, opts) : fetch(url, opts);
    return f.then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.json(); });
  }
  function notify(m, t) {
    if (typeof window.toast === "function") { window.toast(m, t === "error" ? "error" : "success"); return; }
    if (window.snagarrUI && typeof window.snagarrUI.showNotification === "function") window.snagarrUI.showNotification(m, t);
  }

  function animateNum(node, target) {
    if (!node) return;
    target = parseInt(target, 10) || 0;
    var start = parseInt(String(node.textContent).replace(/[^\d-]/g, ""), 10) || 0;
    if (reduce || start === target) { node.textContent = target.toLocaleString(); return; }
    var t0 = performance.now(), dur = 900;
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur), e = k * (2 - k);
      node.textContent = Math.floor(start + (target - start) * e).toLocaleString();
      if (k < 1) requestAnimationFrame(step); else node.textContent = target.toLocaleString();
    })(performance.now());
  }
  function setRing(dial, valEl, pct, text) {
    if (dial) dial.style.setProperty("--v", Math.max(0, Math.min(100, Math.round(pct))));
    if (valEl) valEl.textContent = text;
  }
  function badge(text, tone, opts) {
    opts = opts || {};
    return '<span class="badge' + (tone && tone !== "default" ? " tone-" + tone : "") + (opts.mono ? " mono" : "") + '">' +
      (opts.dot ? '<span class="badge-dot"></span>' : "") + esc(text) + "</span>";
  }

  // -- aggregate + render ---------------------------------------------------
  function configured(app) {
    var s = state.status[app] || {};
    var total = s.total_configured != null ? s.total_configured : (s.configured ? 1 : 0);
    var conn = s.connected_count != null ? s.connected_count : (s.connected ? total : 0);
    return { total: total, conn: conn, on: total > 0 };
  }

  function render() {
    var confApps = KEYS.filter(function (k) { return configured(k).on; });
    var grid = el("dashboardMain"), empty = el("dashboardEmpty");
    if (grid) grid.hidden = confApps.length === 0;
    if (empty) empty.hidden = confApps.length !== 0;
    if (confApps.length === 0) return;

    var totSearch = 0, totUpg = 0, apiUsed = 0, apiLimit = 0, instTotal = 0, instConn = 0, appsConn = 0;
    confApps.forEach(function (k) {
      var st = state.stats[k] || {}, c = configured(k);
      totSearch += (st.hunted || 0); totUpg += (st.upgraded || 0);
      instTotal += c.total; instConn += c.conn; if (c.conn > 0) appsConn++;
      var cap = state.caps[k] || {}; var lim = state.limits[k] != null ? state.limits[k] : 20;
      apiUsed += (cap.api_hits || 0); apiLimit += lim;
    });

    // KPI cards
    animateNum(el("kpiSearches"), totSearch);
    animateNum(el("kpiUpgrades"), totUpg);
    animateNum(el("kpiApps"), appsConn);
    animateNum(el("kpiApi"), apiUsed);
    var subS = el("kpiSearchesSub"); if (subS) subS.textContent = "across " + confApps.length + (confApps.length === 1 ? " app" : " apps");
    var subA = el("kpiAppsSub"); if (subA) subA.textContent = "of " + confApps.length + " configured";
    var apiPct = apiLimit > 0 ? (apiUsed / apiLimit) * 100 : 0;
    var apiBar = el("kpiApiBar"); if (apiBar) apiBar.style.width = Math.min(100, apiPct) + "%";

    // Header rings
    setRing(el("ringApps"), el("ringAppsVal"), confApps.length ? (appsConn / confApps.length) * 100 : 0, appsConn + "/" + confApps.length);
    var ra = el("ringApi"); if (ra) ra.style.setProperty("--rc", apiPct >= 90 ? "#EB5860" : apiPct >= 70 ? "#F5B301" : "#3B9EFF");
    setRing(el("ringApi"), el("ringApiVal"), apiPct, Math.round(apiPct) + "%");

    // Bar chart: searches by app (real)
    var maxSearch = Math.max(1, Math.max.apply(null, confApps.map(function (k) { return (state.stats[k] || {}).hunted || 0; })));
    var bars = el("searchBars"), barsEmpty = el("searchBarsEmpty");
    if (bars) {
      bars.innerHTML = confApps.map(function (k) {
        var v = (state.stats[k] || {}).hunted || 0, a = BY[k];
        return '<div class="barrow"><span class="blabel"><span class="bd" style="background:' + a.c + '"></span>' + esc(a.label) + '</span>' +
          '<span class="bartrack"><i style="width:' + (v / maxSearch * 100) + '%;background:' + a.c + '"></i></span>' +
          '<span class="bval">' + v.toLocaleString() + "</span></div>";
      }).join("");
    }
    if (barsEmpty) barsEmpty.hidden = totSearch > 0;
    var stb = el("searchTotalBadge"); if (stb) stb.textContent = totSearch.toLocaleString() + " total";

    // Connection health list
    var summ = el("connSummary"); if (summ) summ.innerHTML = badge(appsConn + "/" + confApps.length + " online", appsConn >= confApps.length ? "success" : appsConn > 0 ? "warning" : "danger", { dot: true });
    var list = el("connList");
    if (list) {
      list.innerHTML = confApps.map(function (k) {
        var c = configured(k), a = BY[k];
        var cap = state.caps[k] || {}, lim = state.limits[k] != null ? state.limits[k] : 20, used = cap.api_hits || 0;
        var pct = c.total ? (c.conn / c.total) * 100 : 0;
        var rc = c.conn >= c.total ? "#34C759" : c.conn > 0 ? "#F5B301" : "#EB5860";
        var tone = c.conn >= c.total ? "success" : c.conn > 0 ? "warning" : "danger";
        return '<div class="conn-row">' +
          '<span class="conn-ring" style="--v:' + pct + ';--rc:' + rc + '"><span class="ci" style="--rc:' + a.c + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/></svg></span></span>' +
          '<div class="conn-meta"><div class="cn">' + esc(a.label) + " " + badge("Connected " + c.conn + "/" + c.total, tone, { dot: true }) + "</div>" +
          '<div class="cs">' + c.total + (c.total === 1 ? " instance" : " instances") + " · API " + used + "/" + lim + "</div></div>" +
          '<button class="icon-btn" title="Reset cycle" data-cycle-app="' + k + '"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>' +
          "</div>";
      }).join("");
    }
  }

  // -- loaders --------------------------------------------------------------
  function loadStatus() {
    return Promise.all(KEYS.map(function (k) {
      return fetchJson("/api/status/" + k).then(function (d) { state.status[k] = d || {}; })
        .catch(function () { state.status[k] = { total_configured: 0 }; });
    }));
  }
  function loadStats() {
    return fetchJson("/api/stats").then(function (d) { state.stats = (d && d.stats) || {}; }).catch(function () {});
  }
  function loadCaps() {
    return fetchJson("/api/hourly-caps").then(function (d) {
      if (d && d.caps) state.caps = d.caps; if (d && d.limits) state.limits = d.limits;
    }).catch(function () {});
  }
  function refreshAll() { return Promise.all([loadStatus(), loadStats(), loadCaps()]).then(render); }

  // -- reset controls -------------------------------------------------------
  function resetAllStats() {
    ["kpiSearches", "kpiUpgrades"].forEach(function (id) { animateNum(el(id), 0); });
    fetchJson("/api/stats/reset_public", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function () { notify("Statistics reset", "success"); return refreshAll(); })
      .catch(function () { notify("Statistics reset (server unavailable)", "error"); });
  }
  function resetCycle(app, btn) {
    if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
    fetchJson("/api/cycle/reset/" + app, { method: "POST", headers: { "Content-Type": "application/json" } })
      .then(function (d) { notify(d && d.success ? (BY[app] ? BY[app].label : app) + " cycle reset triggered" : (d && d.error) || "Failed to reset cycle", d && d.success ? "success" : "error"); })
      .catch(function (e) { notify("Error: " + e.message, "error"); })
      .finally(function () { setTimeout(function () { if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; } }, 1200); });
  }

  // -- install: keep legacy snagarrUI hooks pointed at the new render -------
  function install() {
    var ui = window.snagarrUI;
    if (ui && !ui._dashboardWrapped) {
      ui.checkAppConnections = function () { refreshAll(); };
      ui.loadMediaStats = function () { refreshAll(); };
      ui.updateConnectionStatus = function () { refreshAll(); };
      ui.updateStatsDisplay = function () { refreshAll(); };
      ui.animateNumber = function (node, _s, end) { animateNum(node, end); };
      ui.resetMediaStats = function () { resetAllStats(); };
      ui.resetAppCycle = function (app, btn) { resetCycle(app, btn); };
      ui._dashboardWrapped = true;
    }
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#dashboardResetStats")) { e.preventDefault(); resetAllStats(); return; }
    var cyc = e.target.closest && e.target.closest("[data-cycle-app]");
    if (cyc) { e.preventDefault(); resetCycle(cyc.getAttribute("data-cycle-app"), cyc); }
  });
  setInterval(function () { var h = el("homeSection"); if (h && h.classList.contains("active")) refreshAll(); }, POLL_MS);

  function boot() { install(); refreshAll(); }
  install();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
