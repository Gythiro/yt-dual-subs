// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.
// The live preview uses the SAME font map + rgba/outline logic as content.js.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = {
  enabled: true,
  targetLang: "zh-CN",
  langShown: null,             // popup/options only: which target languages the
                               // dropdown offers. null = the shipped defaults.
  engine: "auto",              // "auto" | "tlang" | "gtx" | "byo" (source of
                               // truth since 3.4; "byo" = own key, since 3.6)
  backend: "tlang",            // legacy pre-3.4 key; mirrored on engine change so
                               // old devices on the same sync profile stay sane
  // BYO-key engine (3.6). The key itself lives in storage.local, never sync.
  byoProvider: "",             // providers.js id
  byoModel: "",                // empty = the provider's default model
  byoBaseUrl: "",              // custom provider only (https, validated)
  updateNotes: true,           // open release notes page after feature updates
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
  cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    inter:   'Inter, "Segoe UI Variable", system-ui, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    tahoma:  'Tahoma, Geneva, Verdana, sans-serif',
    trebuchet: '"Trebuchet MS", Tahoma, sans-serif',
    garamond: 'Garamond, "Palatino Linotype", "Book Antiqua", serif',
    cjkserif: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
    cjkround: '"Yuanti SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif'
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
  if (e === "auto" || e === "tlang" || e === "gtx" || e === "byo") return e;
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
// ---- target language dropdown ---------------------------------------------
// Only the languages this user keeps, in the order they arranged them, plus a
// last entry into the manager. The full table is fifty long, and an <option>
// cannot carry a remove button — the same wall that moved provider setup onto
// the options page — so add/remove lives there too.
const MANAGE = "__manage__";

function paintLangs() {
  const sel = $("targetLang");
  if (!sel || !self.YTDS_LANGS) return;
  const L = self.YTDS_LANGS;
  const shown = L.shown(state.langShown);
  // A stored target that is no longer in the kept list still has to be
  // selectable, or the popup would silently switch what the user is watching in.
  const codes = shown.includes(state.targetLang) ? shown : shown.concat(state.targetLang);
  sel.textContent = "";
  for (const code of codes) {
    const info = L.get(code);
    if (!info) continue;
    const o = document.createElement("option");
    o.value = code;
    o.textContent = info.native;
    sel.appendChild(o);
  }
  const manage = document.createElement("option");
  manage.value = MANAGE;
  manage.textContent = t("langManage", "管理语言…");
  sel.appendChild(manage);
  sel.value = state.targetLang;
}

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

  const onByo = state.engine === "byo";
  let limited = false;
  let byoCode = "";
  try {
    if (chrome.storage.session) {
      // Each engine has its own gate; read the one that is actually serving.
      const gateKey = onByo ? "ytdsByoGate" : "ytdsGtxGate";
      const got = await chrome.storage.session.get([gateKey, "ytdsByoStatus"]);
      const g = got && got[gateKey];
      limited = !!(g && g.backoffMs > 0 && g.gateUntil > Date.now());
      const st = onByo && got && got.ytdsByoStatus;
      if (st && st.code) byoCode = st.code;
    }
  } catch (_e) { /* session storage unavailable — skip the limit line */ }
  if (limited) {
    el.textContent = t("backendStatusLimited",
      "翻译接口暂时限流，已自动放慢重试；已翻译的句子不受影响。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  // A failing BYO engine has to say so: unlike gtx it has no free fallback, so
  // staying quiet would just look like "the extension stopped translating".
  if (byoCode) {
    el.textContent = byoErrText(byoCode);
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const r = await sendToTab(tab.id, { type: "engineStatus" });
  if (!r || !r.ok) return;                  // not a YouTube video page
  if (r.same) {
    // The track already speaks the target language, so the overlay renders a
    // single line. Shown in EVERY engine mode (it answers "why is there only
    // one line?"), unlike the engine line below which is auto-mode-only.
    el.textContent = t("backendStatusSame", "本视频字幕已是目标语言，无需翻译。");
    el.hidden = false;
    return;
  }
  // Own-key mode names the provider that is answering — the whole point of
  // choosing it is knowing it is in use.
  if (r.engine === "byo") {
    const p = self.YTDS_PROVIDERS && self.YTDS_PROVIDERS.get(r.provider);
    const name = (p && p.name) || "";
    el.textContent = tsub("backendStatusByo", [name], "本视频：自带 Key（" + name + "）");
    el.hidden = false;
    return;
  }
  if (state.engine !== "auto") return;      // manual choice: stay quiet
  if (!r.engine) return;                    // no cues yet
  el.textContent = r.engine === "gtx"
    ? t("backendStatusGtx", "本视频：智能整句（Google）")
    : t("backendStatusTlang", "本视频：整轨翻译（YouTube）");
  el.hidden = false;
}

// ---- BYO-key engine row ---------------------------------------------------
// Everything configurable about an own-key engine lives on the options page
// (options.js explains why — in short, a permission prompt can dismiss a popup
// and take the callback with it). The popup only reports what is set up and
// links there; it never reads or writes the key itself.
const P = self.YTDS_PROVIDERS;

function tsub(key, subs, fb) {
  try { return (chrome.i18n && chrome.i18n.getMessage(key, subs)) || fb; }
  catch (_e) { return fb; }
}

function activeProvider() {
  return (P && P.get(state.byoProvider)) || null;
}

function byoErrText(code) {
  return t(P ? P.errorKey(code) : "byoErrFailed", t("byoErrFailed", "连接失败，稍后再试。"));
}

function paintByoPanel() {
  const panel = $("byoPanel");
  if (!panel) return;
  panel.hidden = state.engine !== "byo";
  if (panel.hidden) return;

  const p = activeProvider();
  // Same tile the options list draws, so the two surfaces agree visually.
  // Guarded: this is the popup's only dependency on provider-icons.js, and a
  // missing icon must never cost us the rest of the panel.
  const slot = $("byoIcon");
  slot.textContent = "";
  if (self.YTDS_ICONS) slot.appendChild(self.YTDS_ICONS.iconFor(p));

  const sum = $("byoSummary");
  const pick = $("byoPick");
  const notSet = t("popupByoNotSet", "还没配置");
  if (!p) {
    sum.textContent = notSet;
    sum.hidden = false;
    if (pick) pick.hidden = true;
    return;
  }
  // Short name here: at 360px the full "Alibaba 百炼 (Qwen / DeepSeek)" would
  // eat the model name, which is the part that changes.
  const label = p.short || p.name;
  // Two different questions: which providers are set up (a saved key), and
  // which of those have actually answered a request (byoOk, written by the
  // settings page when a test passes). With more than one set up, switching
  // between them is a popup-sized job — going to the settings page to click a
  // name was both slower and, until this release, a way to end up on a
  // provider with no key at all.
  chrome.storage.local.get({ byoKeys: {}, byoOk: {} }, (got) => {
    const keys = (got && got.byoKeys) || {};
    const okMap = (got && got.byoOk) || {};
    const configured = (P ? P.list : []).filter((x) => keys[x.id]);
    const model = state.byoModel || p.defaultModel || "";

    if (!pick || configured.length < 2) {
      if (pick) pick.hidden = true;
      sum.hidden = false;
      sum.textContent = keys[p.id]
        ? label + (model ? " · " + model : "")
        : label + " — " + notSet;
      return;
    }

    sum.hidden = true;
    pick.hidden = false;
    pick.textContent = "";
    for (const x of configured) {
      const o = document.createElement("option");
      o.value = x.id;
      const name = x.short || x.name;
      o.textContent = okMap[x.id]
        ? name
        : name + " · " + t("popupByoUntested", "未验证");
      pick.appendChild(o);
    }
    pick.value = p.id;
  });
}

// Switching providers here changes only which of the set-up ones is in use;
// keys, models and endpoints all stay where the settings page put them. The
// model follows its own provider (byoModelBy), so going back and forth does not
// quietly reset it to the default.
function onPickProvider() {
  const id = $("byoPick").value;
  if (!id || id === state.byoProvider) return;
  chrome.storage.sync.get({ byoModelBy: {} }, (got) => {
    const byProvider = (got && got.byoModelBy) || {};
    state.byoProvider = id;
    state.byoModel = byProvider[id] || "";
    chrome.storage.sync.set({ byoProvider: id, byoModel: state.byoModel });
    paintByoPanel();
  });
}

function showExportMsg(text, kind) {
  const el = $("exportMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

// ---- export with the own-key engine ---------------------------------------
// Two things separate this from the free download: it spends the user's quota,
// and it sends the WHOLE track to their provider (playback only ever sends the
// sentences actually watched). Both are said out loud before anything is sent,
// and the run can be stopped while it works.
let exportByo = false;           // transient, like exportVariant — never stored
let exportPoll = null;           // progress poll while a download runs

function byoExportOffered() {
  return state.engine === "byo" && exportVariant !== "orig";
}

function paintExportEngine() {
  const row = $("exportByoRow");
  const note = $("exportEngineNote");
  if (!row || !note) return;
  const offered = byoExportOffered();
  // "Original only" has nothing to translate — the choice would be a no-op.
  if (!offered) exportByo = false;
  row.hidden = !offered;
  $("exportByo").checked = exportByo;
  note.hidden = !offered;
  note.textContent = exportByo
    ? t("exportByoNote", "整片字幕会发给你的服务商翻译，消耗额度；点导出后会先给出预估。")
    : t("exportUsesYouTube", "导出用的是 YouTube 自带的整轨翻译（免费、不消耗你的 API）。");
  note.classList.toggle("warn", exportByo);
}

function showConfirm(text) {
  $("exportConfirmText").textContent = text;
  $("exportConfirm").hidden = false;
}
function hideConfirm() { $("exportConfirm").hidden = true; }

// Busy state covers both buttons: the export button says what is happening and
// the stop button appears only while there is something to stop.
function setExportBusy(on, canStop) {
  const btn = $("exportBtn");
  btn.disabled = on;
  btn.textContent = on
    ? t("exportWorking", "正在生成…")
    : t("exportSrt", "下载 SRT 字幕");
  const stop = $("exportStop");
  stop.hidden = !(on && canStop);
  stop.disabled = false;
  stop.textContent = t("exportStop", "停止");
}

function stopPoll() {
  if (exportPoll) { clearInterval(exportPoll); exportPoll = null; }
}

function startPoll(tabId) {
  stopPoll();
  exportPoll = setInterval(async () => {
    const s = await sendToTab(tabId, { type: "exportStatus" });
    if (!s || !s.ok) return;
    if (!s.running) { stopPoll(); return; }
    showExportMsg(tsub("exportProgress", [String(s.done), String(s.total)],
      "翻译中… " + s.done + "/" + s.total), null);
  }, 700);
}

function exportErrText(resp) {
  if (resp.reason === "cancelled") return t("exportCancelled", "已取消导出。");
  if (resp.reason === "byofail") return byoErrText(resp.code || "failed");
  if (resp.reason === "same") return t("backendStatusSame", "本视频字幕已是目标语言，无需翻译。");
  if (resp.reason === "limited") {
    return t("exportLimited",
      "YouTube 暂时限制了整轨翻译，过一会儿再试；或者勾选「用自带 Key 翻译」。");
  }
  if (resp.reason === "notrans") {
    return t("exportNoTrans", "这个视频拿不到译文，试试「整轨翻译」或换个目标语言。");
  }
  return t("exportNoCues", "没有可下载的字幕，先播放几秒让字幕加载，再试一次。");
}

const NOT_YOUTUBE = () => t("exportNotYoutube", "请在 YouTube 视频页面使用导出。");

// The download itself. useByo has already been confirmed by the caller.
async function runExport(useByo) {
  hideConfirm();
  showExportMsg("", null);
  setExportBusy(true, useByo);
  let tabId = null;
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) { showExportMsg(NOT_YOUTUBE(), "err"); return; }
    tabId = tab.id;
    if (useByo) startPoll(tabId);
    const resp = await sendToTab(tabId, {
      type: "exportSrt", variant: exportVariant, byo: !!useByo
    });
    if (resp == null) {
      showExportMsg(NOT_YOUTUBE(), "err");
    } else if (resp.ok) {
      let msg = t("exportDone", "已下载字幕") + " (" + (resp.count || 0) + ")";
      // A partial fall back to YouTube's lines changes what is in the file, so
      // it is reported rather than quietly accepted.
      if (resp.failedChunks) {
        msg += " · " + tsub("exportPartial", [String(resp.failedChunks)],
          resp.failedChunks + " 段回落到 YouTube 译文");
      }
      showExportMsg(msg, "ok");
    } else {
      showExportMsg(exportErrText(resp), "err");
    }
  } catch (_e) {
    showExportMsg(t("exportFailed", "导出失败，刷新页面后重试。"), "err");
  } finally {
    stopPoll();
    setExportBusy(false, false);
  }
}

async function onExportClick() {
  hideConfirm();
  if (!byoExportOffered() || !exportByo) return runExport(false);

  // Price it first: the estimate is the whole point of the confirmation.
  showExportMsg("", null);
  setExportBusy(true, false);
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) { showExportMsg(NOT_YOUTUBE(), "err"); return; }
    const plan = await sendToTab(tab.id, { type: "exportPlan" });
    if (plan == null) { showExportMsg(NOT_YOUTUBE(), "err"); return; }
    if (!plan.ok) { showExportMsg(exportErrText(plan), "err"); return; }
    // Everything already translated while watching: nothing leaves the browser
    // and nothing is spent, so there is nothing to confirm.
    if (!plan.requests) { setExportBusy(false, false); return runExport(true); }
    const p = activeProvider();
    const name = (p && (p.short || p.name)) || "";
    showConfirm(tsub("exportConfirm",
      [name, String(plan.lines), String(plan.requests)],
      "将用「" + name + "」翻译 " + plan.lines + " 条字幕，约 " + plan.requests +
      " 次请求，消耗你的 API 额度。整片字幕会离开浏览器发给该服务商——播放时只发送你看过的片段。"));
  } catch (_e) {
    showExportMsg(t("exportFailed", "导出失败，刷新页面后重试。"), "err");
  } finally {
    setExportBusy(false, false);
  }
}

async function onExportStop() {
  const stop = $("exportStop");
  stop.disabled = true;
  stop.textContent = t("exportStopping", "正在停止…");
  const tab = await getActiveTab();
  if (tab && tab.id != null) await sendToTab(tab.id, { type: "exportCancel" });
}

// A popup that was closed while a download ran must re-attach to it, not offer
// to start a second one. Also picks up the result of a run that finished while
// the popup was shut.
async function resumeExport() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const s = await sendToTab(tab.id, { type: "exportStatus" });
  if (!s || !s.ok) return;
  if (s.running) {
    setExportBusy(true, true);
    showExportMsg(tsub("exportProgress", [String(s.done), String(s.total)],
      "翻译中… " + s.done + "/" + s.total), null);
    startPoll(tab.id);
    return;
  }
  // Stale results are worse than none: a line from ten minutes ago reads as if
  // it described the click just made.
  const r = s.result;
  if (!r || !r.ts || Date.now() - r.ts > 60000) return;
  if (r.ok) {
    showExportMsg(t("exportDone", "已下载字幕") + " (" + (r.count || 0) + ")", "ok");
  } else {
    showExportMsg(exportErrText(r), "err");
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
  $("updateNotes").checked = !!state.updateNotes;
  paintLangs();
  $("backend").value = state.engine;
  $("backendGtxHint").hidden = state.engine !== "gtx";
  paintExportEngine();
  $("rowGap").value = state.rowGap;
  $("rowGapV").textContent = state.rowGap + "px";
  paintSegs();
  paintExportSeg();
  bindLineControls();
  paintPreview();
  // Last on purpose: it is the only part of the paint that depends on another
  // script, so if it ever throws the rest of the popup is already drawn.
  paintByoPanel();
}

// ---- wire events ---------------------------------------------------------
function wire() {
  $("enabled").addEventListener("change", (e) => setKey("enabled", e.target.checked));
  $("updateNotes").addEventListener("change", (e) => setKey("updateNotes", e.target.checked));
  $("targetLang").addEventListener("change", (e) => {
    if (e.target.value === MANAGE) {
      e.target.value = state.targetLang;   // put it back before leaving
      toOptions("#langs");
      return;
    }
    setKey("targetLang", e.target.value);
  });

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
    // Legacy mirror for pre-3.4 devices: they cannot do "byo", and the closest
    // thing they understand is client-side translation, i.e. gtx.
    state.backend = (v === "gtx" || v === "byo") ? "gtx" : "tlang";
    chrome.storage.sync.set({ engine: state.engine, backend: state.backend });
    $("backendGtxHint").hidden = v !== "gtx";
    paintByoPanel();
    refreshEngineStatus();
  });

  // ---- the settings page -------------------------------------------------
  // Two ways in, and the header gear is the one that always exists: the BYO row
  // only appears once the own-key engine is chosen, which used to leave Getting
  // started and About unreachable for everyone on the default engine.
  // openOptionsPage() cannot carry a hash, so a request for one section opens
  // the page by URL instead.
  const toOptions = (hash) => {
    try {
      if (typeof hash === "string" && hash) {
        chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + hash });
      } else {
        chrome.runtime.openOptionsPage();
      }
    } catch (_e) { /* ignore */ }
    window.close();          // hand over to the tab instead of stacking UI
  };
  // Bare handlers: a click event as the first argument must not be mistaken
  // for a hash.
  $("openOptions").addEventListener("click", () => toOptions());
  $("byoConfigure").addEventListener("click", () => toOptions());
  const pick = $("byoPick");
  if (pick) pick.addEventListener("change", onPickProvider);

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

  // "try dragging": flash the grip on the page. Answering with the label itself
  // when there is no YouTube tab — a dead-feeling button is what we just spent a
  // whole round fixing elsewhere.
  $("tryDrag").addEventListener("click", async () => {
    const tab = await getActiveTab();
    const resp = tab && tab.id != null
      ? await sendToTab(tab.id, { type: "flashHandle" })
      : null;
    if (resp && resp.ok) return;
    // Report in the explanation slot, not on the button: the button is three
    // characters wide and a sentence there would break the row.
    const hint = $("posHintText");
    const was = hint.textContent;
    hint.textContent = t("posTryNoVideo", "请先打开 YouTube 视频页");
    setTimeout(() => { hint.textContent = was; }, 2600);
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
    b.addEventListener("click", () => {
      exportVariant = b.dataset.val;
      paintExportSeg();
      paintExportEngine();          // "original only" has nothing to translate
      hideConfirm();                // the estimate was for the other variant
    }));
  $("exportByo").addEventListener("change", (e) => {
    exportByo = e.target.checked;
    hideConfirm();
    paintExportEngine();
  });
  $("exportBtn").addEventListener("click", onExportClick);
  $("exportGo").addEventListener("click", () => runExport(true));
  $("exportBack").addEventListener("click", () => hideConfirm());
  $("exportStop").addEventListener("click", onExportStop);

  // reset all
  $("reset").addEventListener("click", () => {
    state = { ...DEFAULTS };
    chrome.storage.sync.set(DEFAULTS);   // engine:"auto" + backend:"tlang" mirror included
    // Reset means reset: don't leave orphan API keys on the machine. The panel
    // also has its own "clear" button for doing this alone.
    try {
      chrome.storage.local.remove("byoKeys");
      paintByoPanel();               // the summary must stop claiming a key
    } catch (_e) { /* ignore */ }
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

// ---- update badge + what's new row ---------------------------------------
// Opening the popup clears the "NEW" badge; the row links to the release
// notes and stays until opened once (per announced version).
const SITE_URL = "https://gythiro.github.io/yt-dual-subs/";

function popupLang() {
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
    if (ui.toLowerCase().indexOf("zh") === 0) return "zh";
  } catch (_e) { /* ignore */ }
  return "en";
}

// Footer links. Built here rather than hard-coded in the markup so the site
// links carry the UI language (a Chinese user landing on the English page was a
// real bug once) and everything stays in one place.
const STORE_URL =
  "https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge";

function initFooterLinks() {
  const lang = popupLang();
  const set = (id, href) => { const el = $(id); if (el) el.href = href; };
  set("lnkSite", SITE_URL + "?src=popup&lang=" + lang);
  set("lnkGithub", "https://github.com/Gythiro/yt-dual-subs");
  set("lnkFeedback", SITE_URL + "feedback.html?src=popup&lang=" + lang);
  set("lnkReview", STORE_URL + "/reviews");
}

function initWhatsNew() {
  try { chrome.action.setBadgeText({ text: "" }); } catch (_e) { /* ignore */ }
  try {
    chrome.storage.local.get({ updWhatsNew: "", updRowSeen: "" }, (got) => {
      const ver = got && got.updWhatsNew;
      if (!ver || got.updRowSeen === ver) return;
      const el = $("whatsNew");
      if (!el) return;
      let lang = "en";
      try {
        const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
        if (ui.toLowerCase().indexOf("zh") === 0) lang = "zh";
      } catch (_e) { /* ignore */ }
      let label = "";
      try { label = chrome.i18n.getMessage("whatsNewRow", [ver]); } catch (_e) { /* ignore */ }
      el.textContent = label || ("See what's new in v" + ver + " →");
      el.href = SITE_URL + "updated.html?ver=" + ver + "&lang=" + lang + "&src=popup";
      el.hidden = false;
      el.addEventListener("click", () => {
        try { chrome.storage.local.set({ updRowSeen: ver }); } catch (_e) { /* ignore */ }
        el.hidden = true;
      });
    });
  } catch (_e) { /* ignore */ }
}

// ---- boot ----------------------------------------------------------------
applyI18n();                       // localize static markup before first paint
initFooterLinks();
initWhatsNew();
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
  resumeExport();
});
