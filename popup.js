// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.
// The live preview uses the SAME font map + rgba/outline logic as content.js.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = {
  enabled: true,
  targetLang: "zh-CN",
  engine: "auto",              // "auto" | "tlang" | "gtx" (source of truth since 3.4)
  backend: "tlang",            // legacy pre-3.4 key; mirrored on engine change so
                               // old devices on the same sync profile stay sane
  order: "orig-top",           // "orig-top" | "trans-top"
  rowGap: 4,
  position: "bottom",          // "top" | "center" | "bottom"
  posMode: "preset",           // "preset" | "custom"
  posXpct: 50,
  posYpct: 90,
  // original line
  showOriginal: true,
  origFont: "system",
  origSize: 22,
  origColor: "#ffffff",
  origBg: "#080808",
  origBgOpacity: 0.6,
  origStroke: "#000000",
  origStrokeOpacity: 0,
  // translation line
  showTranslation: true,
  transFont: "system",
  transSize: 24,
  transColor: "#ffe98a",
  transBg: "#080808",
  transBgOpacity: 0.6,
  transStroke: "#000000",
  transStrokeOpacity: 0
};

// Font key -> font-family stack (shared with content.js render).
const FONT_STACKS = {
  system:  'system-ui, -apple-system, "Segoe UI", sans-serif',
  roboto:  'Roboto, "YouTube Noto", sans-serif',
  noto:    '"Noto Sans", "YouTube Noto", sans-serif',
  arial:   'Arial, Helvetica, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  times:   '"Times New Roman", Times, serif',
  mono:    '"Courier New", ui-monospace, monospace',
  cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
};
function fontStack(key) { return FONT_STACKS[key] || FONT_STACKS.system; }

// ---- color helpers (tolerant of #rgb / #rrggbb) --------------------------
function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}
function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  let a = Number(alpha);
  if (!isFinite(a)) a = 1;
  a = Math.max(0, Math.min(1, a));
  return `rgba(${r},${g},${b},${a})`;
}
function outlineShadow(strokeHex, strokeOpacity) {
  const a = Number(strokeOpacity);
  if (!isFinite(a) || a <= 0) return "0 1px 2px rgba(0,0,0,0.9)";
  const c = rgba(strokeHex, a);
  const o = 1.2;
  return [
    `-${o}px -${o}px 0 ${c}`, `0 -${o}px 0 ${c}`, `${o}px -${o}px 0 ${c}`,
    `${o}px 0 0 ${c}`, `${o}px ${o}px 0 ${c}`, `0 ${o}px 0 ${c}`,
    `-${o}px ${o}px 0 ${c}`, `-${o}px 0 0 ${c}`
  ].join(", ");
}

const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };

// v3.4 engine migration — READ-side only (mirrors content.js normalizeEngine).
// "engine" wins when stored; otherwise an explicitly stored gtx survives and
// everything else lands on "auto". Never written back on its own.
function normalizeEngine(got) {
  const e = got && got.engine;
  if (e === "auto" || e === "tlang" || e === "gtx") return e;
  return got && got.backend === "gtx" ? "gtx" : "auto";
}
let activeLine = "trans";        // which line the tab editor is bound to
let exportVariant = "bi";        // SRT export content: "bi" | "orig" | "trans" (local, not stored)

// ---- i18n ----------------------------------------------------------------
// Safe wrapper: returns the localized message, or the fallback if the key is
// missing/empty so the hardcoded markup keeps working in any environment.
function t(key, fallback) {
  try {
    const m = chrome.i18n && chrome.i18n.getMessage(key);
    if (m) return m;
  } catch (_e) { /* ignore */ }
  return fallback;
}

// Walk the DOM once and fill every data-i18n* attribute. Only overwrite when
// the looked-up message is non-empty, so a missing key leaves the hardcoded
// fallback text in place.
function applyI18n() {
  // Keep the document language in sync with the actual UI locale so screen
  // readers / hyphenation match the rendered text (default_locale is "en").
  try {
    const ui = chrome.i18n && chrome.i18n.getUILanguage();
    if (ui) document.documentElement.lang = ui;
  } catch (_e) { /* ignore */ }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-html"));
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
    if (m) el.title = m;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
    if (m) el.setAttribute("aria-label", m);
  });
}

// per-line key prefixing so one set of controls edits either line.
// The per-tab "show this line" label is resolved live via t() in
// bindLineControls so it follows the active locale.
const LINE = {
  trans: {
    show: "showTranslation", font: "transFont", size: "transSize",
    color: "transColor", bg: "transBg", bgOpacity: "transBgOpacity",
    stroke: "transStroke", strokeOpacity: "transStrokeOpacity"
  },
  orig: {
    show: "showOriginal", font: "origFont", size: "origSize",
    color: "origColor", bg: "origBg", bgOpacity: "origBgOpacity",
    stroke: "origStroke", strokeOpacity: "origStrokeOpacity"
  }
};

// ---- persistence ---------------------------------------------------------
function setKey(key, val) {
  state[key] = val;
  const o = {}; o[key] = val;
  chrome.storage.sync.set(o);
  paintPreview();
}

// ---- live preview (mirrors content.js styleOverlay) ----------------------
function paintPreview() {
  const ov = $("prevOverlay"), o = $("prevOrig"), t = $("prevTrans");
  if (!ov || !o || !t) return;

  ov.style.flexDirection = state.order === "trans-top" ? "column" : "column-reverse";
  ov.style.gap = (Number(state.rowGap) || 0) / 2 + "px"; // preview is ~half scale

  // scale font sizes to the compact preview strip (~half of player px)
  o.style.fontFamily = fontStack(state.origFont);
  o.style.fontSize = Math.max(9, Math.round(state.origSize / 2)) + "px";
  o.style.color = state.origColor;
  o.style.background = rgba(state.origBg, state.origBgOpacity);
  o.style.textShadow = outlineShadow(state.origStroke, state.origStrokeOpacity);
  o.style.display = state.showOriginal ? "" : "none";

  t.style.fontFamily = fontStack(state.transFont);
  t.style.fontSize = Math.max(9, Math.round(state.transSize / 2)) + "px";
  t.style.color = state.transColor;
  t.style.background = rgba(state.transBg, state.transBgOpacity);
  t.style.textShadow = outlineShadow(state.transStroke, state.transStrokeOpacity);
  t.style.display = state.showTranslation ? "" : "none";

  const pv = $("preview");
  if (pv) {
    const frame = pv.querySelector(".preview-frame");
    if (frame) {
      frame.style.justifyContent =
        state.position === "top" ? "flex-start" :
        state.position === "center" ? "center" : "flex-end";
    }
    pv.style.opacity = state.enabled ? "1" : "0.4";
  }
}

// ---- segmented controls --------------------------------------------------
function paintSegs() {
  const sync = (sel, val) =>
    document.querySelectorAll(sel + " button").forEach((b) => {
      const on = b.dataset.val === val;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on)); // expose state to screen readers
    });
  sync("#order", state.order);
  // a custom (dragged) position highlights no preset
  sync("#position", state.posMode === "custom" ? "__none__" : state.position);
}

// ---- export (SRT download) -----------------------------------------------
// The export variant is a transient choice (not persisted, so it stays out of
// the shared DEFAULTS contract between popup.js and content.js).
function paintExportSeg() {
  document.querySelectorAll("#exportVariant button").forEach((b) => {
    const on = b.dataset.val === exportVariant;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

// Active tab id only — the tab id needs no "tabs" permission. We avoid reading
// tab.url (which would) and instead detect a non-YouTube page by a null reply
// from sendToTab (no content script there to answer).
function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(tabs && tabs[0]);
      });
    } catch (_e) { resolve(null); }
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }   // no content script
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

// ---- engine status line ----------------------------------------------------
// One quiet line under the engine select. Priority: rate-limited (amber, any
// engine) > auto's per-video decision (muted) > hidden. Reads the limit gate
// from chrome.storage.session (written by background.js on state transitions)
// and the resolved engine from the content script of the active tab.
async function refreshEngineStatus() {
  const el = $("backendStatus");
  if (!el) return;
  el.hidden = true;
  el.classList.remove("warn");

  let limited = false;
  try {
    if (chrome.storage.session) {
      const got = await chrome.storage.session.get("ytdsGtxGate");
      const g = got && got.ytdsGtxGate;
      limited = !!(g && g.backoffMs > 0 && g.gateUntil > Date.now());
    }
  } catch (_e) { /* session storage unavailable — skip the limit line */ }
  if (limited) {
    el.textContent = t("backendStatusLimited",
      "翻译接口暂时限流，已自动放慢重试；已翻译的句子不受影响。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  if (state.engine !== "auto") return;      // manual choice: stay quiet
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const r = await sendToTab(tab.id, { type: "engineStatus" });
  if (!r || !r.ok || !r.engine) return;     // not a YouTube video page / no cues yet
  el.textContent = r.engine === "gtx"
    ? t("backendStatusGtx", "本视频：智能整句（Google）")
    : t("backendStatusTlang", "本视频：整轨翻译（YouTube）");
  el.hidden = false;
}

function showExportMsg(text, kind) {
  const el = $("exportMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function onExportClick() {
  const btn = $("exportBtn");
  const label = btn.textContent;
  showExportMsg("", null);
  btn.disabled = true;
  btn.textContent = t("exportWorking", "正在生成…");
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
      return;
    }
    const resp = await sendToTab(tab.id, { type: "exportSrt", variant: exportVariant });
    if (resp == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
    } else if (resp.ok) {
      showExportMsg(t("exportDone", "已下载字幕") + " (" + (resp.count || 0) + ")", "ok");
    } else if (resp.reason === "notrans") {
      showExportMsg(t("exportNoTrans", "这个视频拿不到译文，试试「整句翻译」或换个目标语言。"), "err");
    } else {
      showExportMsg(t("exportNoCues", "没有可下载的字幕，先播放几秒让字幕加载，再试一次。"), "err");
    }
  } catch (_e) {
    showExportMsg(t("exportFailed", "导出失败，刷新页面后重试。"), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---- per-line tab editor -------------------------------------------------
function bindLineControls() {
  const m = LINE[activeLine];
  $("lineShowLabel").textContent =
    t("lineShow", activeLine === "trans" ? "显示译文" : "显示原文");
  $("lineShow").checked = !!state[m.show];
  $("lineFont").value = state[m.font];
  $("lineSize").value = state[m.size];
  $("lineSizeV").textContent = state[m.size] + "px";
  $("lineColor").value = state[m.color];
  $("lineBg").value = state[m.bg];
  $("lineStroke").value = state[m.stroke];
  $("lineBgOpacity").value = state[m.bgOpacity];
  $("lineBgOpacityV").textContent = Math.round(state[m.bgOpacity] * 100) + "%";
  $("lineStrokeOpacity").value = state[m.strokeOpacity];
  $("lineStrokeOpacityV").textContent = Math.round(state[m.strokeOpacity] * 100) + "%";

  let activeTabId = "";
  document.querySelectorAll("#lineTabs .tab").forEach((b) => {
    const on = b.dataset.line === activeLine;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on)); // expose tab state to screen readers
    if (on) activeTabId = b.id;
  });
  // point the panel at whichever tab is now active
  const panel = $("lineEditor");
  if (panel && activeTabId) panel.setAttribute("aria-labelledby", activeTabId);
}

// ---- bind whole UI from state -------------------------------------------
function bindUI() {
  $("enabled").checked = state.enabled;
  $("targetLang").value = state.targetLang;
  $("backend").value = state.engine;
  $("backendGtxHint").hidden = state.engine !== "gtx";
  $("rowGap").value = state.rowGap;
  $("rowGapV").textContent = state.rowGap + "px";
  paintSegs();
  paintExportSeg();
  bindLineControls();
  paintPreview();
}

// ---- wire events ---------------------------------------------------------
function wire() {
  $("enabled").addEventListener("change", (e) => setKey("enabled", e.target.checked));
  $("targetLang").addEventListener("change", (e) => setKey("targetLang", e.target.value));

  // backend info tooltip
  $("backendInfo").addEventListener("click", () => {
    const tip = $("backendTip");
    const open = tip.hidden;
    tip.hidden = !open;
    $("backendInfo").setAttribute("aria-expanded", String(open));
  });

  // engine select: write the v3.4 key AND mirror the legacy one, in a single
  // set() so content.js sees one change event (one re-cue, not two).
  $("backend").addEventListener("change", (e) => {
    const v = e.target.value;
    state.engine = v;
    state.backend = v === "gtx" ? "gtx" : "tlang";
    chrome.storage.sync.set({ engine: state.engine, backend: state.backend });
    $("backendGtxHint").hidden = v !== "gtx";
    refreshEngineStatus();
  });

  // segmented: order
  document.querySelectorAll("#order button").forEach((b) =>
    b.addEventListener("click", () => { setKey("order", b.dataset.val); paintSegs(); }));

  // position presets also force posMode = "preset"
  document.querySelectorAll("#position button").forEach((b) =>
    b.addEventListener("click", () => {
      state.position = b.dataset.val;
      state.posMode = "preset";
      chrome.storage.sync.set({ position: state.position, posMode: "preset" });
      paintSegs(); paintPreview();
    }));
  $("resetPos").addEventListener("click", () => {
    setKey("posMode", "preset"); paintSegs();
  });

  // row gap
  $("rowGap").addEventListener("input", (e) => {
    $("rowGapV").textContent = e.target.value + "px";
    setKey("rowGap", +e.target.value);
  });

  // tabs
  document.querySelectorAll("#lineTabs .tab").forEach((b) =>
    b.addEventListener("click", () => { activeLine = b.dataset.line; bindLineControls(); }));

  // per-line controls write to the ACTIVE line's keys
  $("lineShow").addEventListener("change", (e) => setKey(LINE[activeLine].show, e.target.checked));
  $("lineFont").addEventListener("change", (e) => setKey(LINE[activeLine].font, e.target.value));
  $("lineSize").addEventListener("input", (e) => {
    $("lineSizeV").textContent = e.target.value + "px";
    setKey(LINE[activeLine].size, +e.target.value);
  });
  $("lineColor").addEventListener("input", (e) => setKey(LINE[activeLine].color, e.target.value));
  $("lineBg").addEventListener("input", (e) => setKey(LINE[activeLine].bg, e.target.value));
  $("lineStroke").addEventListener("input", (e) => setKey(LINE[activeLine].stroke, e.target.value));
  $("lineBgOpacity").addEventListener("input", (e) => {
    $("lineBgOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].bgOpacity, +e.target.value);
  });
  $("lineStrokeOpacity").addEventListener("input", (e) => {
    $("lineStrokeOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].strokeOpacity, +e.target.value);
  });

  // export (SRT download)
  document.querySelectorAll("#exportVariant button").forEach((b) =>
    b.addEventListener("click", () => { exportVariant = b.dataset.val; paintExportSeg(); }));
  $("exportBtn").addEventListener("click", onExportClick);

  // reset all
  $("reset").addEventListener("click", () => {
    state = { ...DEFAULTS };
    chrome.storage.sync.set(DEFAULTS);   // engine:"auto" + backend:"tlang" mirror included
    bindUI();
    refreshEngineStatus();
  });
}

// ---- version footer ------------------------------------------------------
function showVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    if (v && $("version")) $("version").textContent = v;
  } catch (_e) { /* ignore */ }
}

// ---- boot ----------------------------------------------------------------
applyI18n();                       // localize static markup before first paint
// get(null): fetch only what is actually stored, so normalizeEngine can tell
// "engine never set" apart from an explicit value (see content.js).
chrome.storage.sync.get(null, (got) => {
  got = got || {};
  state = { ...DEFAULTS, ...got };
  state.engine = normalizeEngine(got);
  // migrate legacy global bgOpacity onto per-line defaults
  if (typeof got.bgOpacity === "number") {
    if (typeof got.origBgOpacity !== "number") state.origBgOpacity = got.bgOpacity;
    if (typeof got.transBgOpacity !== "number") state.transBgOpacity = got.bgOpacity;
  }
  showVersion();
  bindUI();
  wire();
  refreshEngineStatus();
});
