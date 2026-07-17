/*
 * Snagarr - Cobalt v2 behaviors (dependency-free).
 *
 * Delegated listeners on the data-* attributes the Jinja macros emit. This is
 * a shared contract: the class names and data-* hooks here MUST match the CSS
 * (cobalt.css) and the macros (_ui.html) exactly. No framework, no build step.
 */
(() => {
  "use strict";
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // -- Toast (global) ------------------------------------------------
  window.toast = (message, type = "success") => {
    const root = $("#toast-root"); if (!root) return;
    const el = document.createElement("div");
    el.className = `toast type-${type}`;
    el.innerHTML = `<span class="toast-msg"></span>`;
    el.querySelector(".toast-msg").textContent = message;
    root.appendChild(el);
    const life = type === "error" ? 6000 : 3500;
    const kill = () => { el.classList.add("leaving"); setTimeout(() => el.remove(), 200); };
    setTimeout(kill, life);
    el.addEventListener("click", kill);
  };
  // drain server flashes: <script type="application/json" data-flash>[["success","Saved"]]</script>
  const flashNode = $("[data-flash]");
  if (flashNode) { try { JSON.parse(flashNode.textContent).forEach(([t, m]) => window.toast(m, t)); } catch {} }

  // -- Body scroll lock (shared by modal + drawer) -------------------
  let lockCount = 0;
  const lock   = () => { if (lockCount++ === 0) { const g = innerWidth - document.documentElement.clientWidth; document.body.style.overflow = "hidden"; document.body.style.paddingRight = g + "px"; } };
  const unlock = () => { if (--lockCount <= 0) { lockCount = 0; document.body.style.overflow = ""; document.body.style.paddingRight = ""; } };

  // -- Tabs ----------------------------------------------------------
  $$("[data-tabs]").forEach(bar => {
    bar.addEventListener("click", e => {
      const btn = e.target.closest("[data-tab]"); if (!btn) return;
      const id = btn.dataset.tab;
      $$("[data-tab]", bar).forEach(b => { const on = b === btn; b.classList.toggle("active", on); b.setAttribute("aria-selected", on); });
      $$("[data-panel]").forEach(p => { p.hidden = p.dataset.panel !== id; if (!p.hidden) { p.classList.remove("tab-panel"); void p.offsetWidth; p.classList.add("tab-panel"); } });
      btn.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
    });
  });

  // -- Modal ---------------------------------------------------------
  const openModal  = id => { const m = $(`[data-modal="${id}"]`); if (!m) return; m.hidden = false; lock(); m.__esc = e => e.key === "Escape" && closeModal(id); document.addEventListener("keydown", m.__esc); };
  const closeModal = id => { const m = $(`[data-modal="${id}"]`); if (!m || m.hidden) return; m.hidden = true; unlock(); document.removeEventListener("keydown", m.__esc); };
  window.openModal = openModal; window.closeModal = closeModal;
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-modal-open]"); if (t) return openModal(t.dataset.modalOpen);
    const c = e.target.closest("[data-modal-close]"); if (c) { const box = c.closest("[data-modal]"); if (box) return closeModal(box.dataset.modal); }
    const bd = e.target.closest("[data-modal]"); if (bd && e.target === bd) closeModal(bd.dataset.modal);
  });

  // -- Dropdowns (account popover, filter chips) - outside-click close
  document.addEventListener("click", e => {
    const trig = e.target.closest("[data-dropdown]");
    $$("[data-dropdown].open").forEach(d => { if (d !== trig) d.classList.remove("open"); });
    if (trig) trig.classList.toggle("open");
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") $$("[data-dropdown].open").forEach(d => d.classList.remove("open")); });

  // -- Switch toggle -------------------------------------------------
  // Native checkbox switches (.switch > input) toggle themselves. This handles
  // button/ARIA-style switches marked [data-switch]: flip aria-checked + .active.
  document.addEventListener("click", e => {
    const sw = e.target.closest("[data-switch]"); if (!sw || sw.querySelector('input[type="checkbox"]')) return;
    const on = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.classList.toggle("active", on);
    sw.dispatchEvent(new CustomEvent("switch:change", { bubbles: true, detail: { checked: on } }));
  });

  // -- Banner dismiss ------------------------------------------------
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-banner-close]"); if (!b) return;
    const banner = b.closest(".banner"); if (banner) banner.remove();
  });

  // -- Mobile drawer (clone the full sidebar) ------------------------
  const drawer = $("[data-drawer]"), backdrop = $("[data-drawer-backdrop]"), sidebar = $("[data-sidebar]");
  const openDrawer = () => {
    if (!drawer || !sidebar) return;
    if (!drawer.dataset.built) {
      drawer.appendChild(sidebar.cloneNode(true));
      const x = document.createElement("button");
      x.className = "icon-btn drawer-close"; x.setAttribute("aria-label", "Close menu");
      x.innerHTML = sidebar.dataset.closeIcon || "&#10005;"; x.addEventListener("click", closeDrawer);
      drawer.appendChild(x); drawer.dataset.built = "1";
    }
    drawer.hidden = false; if (backdrop) backdrop.hidden = false; lock();
    $("[data-drawer-open]")?.setAttribute("aria-expanded", "true");
  };
  const closeDrawer = () => { if (!drawer || drawer.hidden) return; drawer.hidden = true; if (backdrop) backdrop.hidden = true; unlock(); $("[data-drawer-open]")?.setAttribute("aria-expanded", "false"); };
  $("[data-drawer-open]")?.addEventListener("click", openDrawer);
  backdrop?.addEventListener("click", closeDrawer);
  drawer?.addEventListener("click", e => { if (e.target.closest("[data-nav]")) closeDrawer(); });
  document.addEventListener("keydown", e => e.key === "Escape" && closeDrawer());
  addEventListener("resize", () => { if (innerWidth >= 900) closeDrawer(); });

  // -- KPI tile keyboard activation ----------------------------------
  document.addEventListener("keydown", e => {
    const tile = e.target.closest('.kpi-tile[role="button"]');
    if (tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); tile.click(); }
  });

  // -- CopyButton ----------------------------------------------------
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 1200); if (window.toast) window.toast("Copied", "success"); } catch {}
  });

  // -- RelativeTime -- [data-time="<iso>"] ---------------------------
  const rel = v => {
    const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 19).replace("T", " ");
    const diff = Date.now() - d, a = Math.abs(diff), m = 6e4, h = 36e5, day = 864e5;
    let l = a < 45e3 ? "just now" : a < h ? Math.round(a/m)+"m" : a < day ? Math.round(a/h)+"h" : a < day*30 ? Math.round(a/day)+"d" : d.toLocaleDateString();
    return l === "just now" ? l : l + (diff >= 0 ? " ago" : " from now");
  };
  $$("[data-time]").forEach(el => { el.textContent = rel(el.dataset.time); el.title = new Date(el.dataset.time).toLocaleString(); });

  // -- FilterBar -- URL-synced list state ----------------------------
  const fb = $("[data-filterbar]");
  if (fb) {
    const patch = obj => {
      const p = new URLSearchParams(location.search);
      for (const [k, v] of Object.entries(obj)) {
        p.delete(k);
        if (Array.isArray(v)) v.forEach(x => p.append(k, x));
        else if (v != null && v !== "") p.set(k, v);
      }
      if (!("page" in obj)) p.delete("page");            // reset page on any filter change
      history.replaceState(null, "", "?" + p.toString());
      location.reload();                                  // SSR: re-fetch the scoped list
    };
    let t; fb.querySelector('[data-filter="q"]')?.addEventListener("input", e => {
      clearTimeout(t); t = setTimeout(() => patch({ q: e.target.value }), +e.target.dataset.debounce || 250);
    });
    fb.querySelector('[data-filter="scope"]')?.addEventListener("click", e => {
      const b = e.target.closest("[data-value]"); if (b) patch({ scope: b.dataset.value });
    });
    document.addEventListener("keydown", e => {
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); fb.querySelector('[data-filter="q"]')?.focus(); }
    });
  }

  // -- Sidebar footer live version -- fetch /version.txt -------------
  // Fills [data-version-root] from the plain-text VERSION file. SSR may prefill
  // it; if so we leave the rendered value and only backfill when empty.
  const vr = $("[data-version-root]");
  if (vr) {
    const firstSpan = vr.querySelector("span");
    const empty = !firstSpan || !firstSpan.textContent.trim();
    if (empty) {
      fetch("/version.txt", { cache: "no-store" }).then(r => r.ok ? r.text() : Promise.reject()).then(txt => {
        const raw = String(txt).trim(); if (!raw) return;
        const [verPart, buildPart] = raw.split(/\s+/, 2);
        const ver = "v" + verPart.replace(/^v/, "");
        const build = buildPart ? ` &middot; <span class="ver-build">${buildPart.slice(0, 7)}</span>` : "";
        vr.innerHTML = `<span>${ver}${build}</span><span class="ver-author">Author: Emkraan Administrator</span>`;
      }).catch(() => {});
    }
  }

  // -- System Health count-up + gauge sweep (reduced-motion aware) ----
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$("[data-countup]").forEach(el => {
    const target = +el.dataset.countup;
    if (reduce) { el.textContent = target; return; }
    const t0 = performance.now(), dur = 700;
    const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(target * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  $$("[data-gauge]").forEach(g => { g.style.setProperty("--health-target", g.dataset.gauge); if (!reduce) g.style.animation = "ringSweep 1.05s var(--ease-out) forwards"; else g.style.setProperty("--health-sweep", g.dataset.gauge); });
})();
