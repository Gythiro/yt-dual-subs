// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.
// The live preview uses the SAME font map + rgba/outline logic as content.js.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = {
  enabled: true,
  targetLang: "zh-CN",
  uiLocale: "auto",            // interface language; "auto" = follow the browser
  ttsEnabled: false,           // read the translation line aloud (own key)
  ttsVolume: 100,              // spoken line's own loudness, 0-100 (Audio.volume)
  ttsDuckPct: 25,              // original audio while a line speaks, as % of the
                               // user's own volume (inject.js ducks to this)
  // Which voice speaks. Kept in `state` so the card and the status line read
  // the pick that was just made rather than racing storage for it; the keys
  // themselves live in storage.local and are never mirrored here.
  ttsProvider: "local-speech", // the keyless engine, so the switch works unconfigured
  ttsVoice: "",                // "" = the provider's default
  ttsRegion: "",               // Azure only: its key is bound to a region
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
// All lookups go through YTDS_I18N so the user's interface-language override
// (options → About) applies; on "auto" it is chrome.i18n.getMessage unchanged.
function t(key, fallback) {
  try {
    const m = self.YTDS_I18N.get(key);
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
    const ui = self.YTDS_I18N.effectiveLang();
    if (ui) document.documentElement.lang = ui;
  } catch (_e) { /* ignore */ }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = self.YTDS_I18N.get(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = self.YTDS_I18N.get(el.getAttribute("data-i18n-html"));
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = self.YTDS_I18N.get(el.getAttribute("data-i18n-title"));
    if (m) el.title = m;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const m = self.YTDS_I18N.get(el.getAttribute("data-i18n-aria"));
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
// One drag is one setting change. Writing on every `input` event turned a
// single slider pull into tens of chrome.storage.sync writes, and Chrome
// refuses them past 120 a minute — silently, since nothing read lastError.
// storage.onChanged then never fired either, so the preview here kept moving
// while the subtitles on the video stopped: the worst shape a failure can take.
// The value reaches `state` and the preview immediately; only the write waits.
const pendingWrite = Object.create(null);
let writeTimer = null;

function flushWrites(retriesLeft) {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const batch = {};
  let any = false;
  for (const k of Object.keys(pendingWrite)) { batch[k] = pendingWrite[k]; delete pendingWrite[k]; any = true; }
  if (!any) return;
  try {
    chrome.storage.sync.set(batch, () => {
      // A refused write used to vanish. Put the values back and try once more,
      // far enough out that the per-minute window has moved on.
      if (chrome.runtime.lastError && (retriesLeft || 0) > 0) {
        for (const k of Object.keys(batch)) {
          if (!(k in pendingWrite)) pendingWrite[k] = batch[k];
        }
        writeTimer = setTimeout(() => flushWrites((retriesLeft || 0) - 1), 5000);
      }
    });
  } catch (_e) { /* the popup is going away; the change event already flushed */ }
}

function setKey(key, val) {
  state[key] = val;
  pendingWrite[key] = val;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => flushWrites(1), 180);
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
    const o = document.createElement("option");
    o.value = code;
    // Only one entry can be missing from the table — the stored target, kept
    // above precisely so it stays selectable. Skipping it made the dropdown go
    // blank instead: the reader could not see what they were translating into,
    // and the setting underneath was unchanged. A code this build does not
    // know is labelled with itself, which is at least true.
    o.textContent = info ? info.native : code;
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

// `waitMs` bounds the wait. A content script that is alive but busy never calls
// back and never sets lastError, so without a deadline this promise can simply
// never settle — which is survivable while the caller only paints a line, and
// is not once a caller disables a button until it resolves. The settings page
// has always bounded its equivalent at 800ms; this is the same number.
function sendToTab(tabId, msg, waitMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    if (waitMs) setTimeout(() => finish(null), waitMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) { finish(null); return; }   // no content script
        finish(resp);
      });
    } catch (_e) { finish(null); }
  });
}

// ---- engine status line ----------------------------------------------------
// One quiet line under the engine select. Priority: rate-limited (amber, any
// engine) > auto's per-video decision (muted) > hidden. Reads the limit gate
// from chrome.storage.session (written by background.js on state transitions)
// and the resolved engine from the content script of the active tab.
// The diagnostics button rides the engine status line and appears only when
// that line is a complaint: beside a warning it reads as "copy THIS fault",
// which is what a support reply needs. The permanent, tell-people-about-it
// entry is on the settings page (About) — the commonest report, "no subtitles
// at all", raises no warning for this to hang off.
function paintDiagBtn() {
  const btn = $("diagCopy");
  const el = $("backendStatus");
  if (!btn || !el) return;
  btn.hidden = el.hidden || !el.classList.contains("warn");
}

// One exit for a function with eight early returns: whatever paintEngineStatus
// decided, the diagnostics button is re-gated on the way out.
async function refreshEngineStatus() {
  try { await paintEngineStatus(); } finally { paintDiagBtn(); }
}

async function paintEngineStatus() {
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

// ---- read-aloud status line --------------------------------------------------
// One quiet line under the engine status, only while the options-page switch is
// on: is a line sounding right now, which voice, and how this video went —
// skipped lines are the answer to "why did some stay silent". One snapshot per
// popup open; the counts are a hint, not a ledger.
async function refreshTtsStatus() {
  const el = $("ttsStatus");
  if (!el) return;
  el.hidden = true;
  if (!state.ttsEnabled || !ttsCardReady) return;
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const r = await sendToTab(tab.id, { type: "engineStatus" });
  if (!r || !r.ok || !r.tts) return;        // not a video page, or a stale script
  // From `state`, not a fresh read: a voice pick writes storage and refreshes
  // this line in the same breath, and a read racing that write would name the
  // voice the user just moved off. `state` is what the pick set.
  let voice = "";
  try {
    const p = self.YTDS_PROVIDERS && self.YTDS_PROVIDERS.tts.get(state.ttsProvider);
    // The engine falls back when a stored voice is not this provider's, so the
    // line must name the voice that will actually speak. When we cannot say
    // which that is, it names none: the family default is a guess, and for the
    // browser's own voices there is not even one to guess with — the engine
    // hands the line to whatever the system has picked, and no name here is
    // truer than the wrong name.
    const stored = state.ttsVoice || "";
    voice = ttsVoiceUsableHere(p, stored) ? stored : (p ? (p.defaultVoice || "") : stored);
  } catch (_e) { /* no voice shown, the line still counts */ }
  const counts = tsub("ttsStatusCounts",
    [String(r.tts.spoken), String(r.tts.skipped)],
    "本视频 " + r.tts.spoken + " 句 · 跳过 " + r.tts.skipped + " 句");
  // The engine said why: lead with the reason. A stored key is not a working
  // one (it is saved before the test runs), and since the popup can switch
  // provider by picking a voice, the settings page is no longer guaranteed to
  // have shown the user the failure.
  el.classList.toggle("err", !!r.tts.err);
  if (r.tts.err) {
    // …but keep the counts once anything has been read. The reason used to
    // appear only when NOTHING had ever spoken, so it could stand alone;
    // now it also covers a provider that worked and then stopped, and on that
    // video the lines that did play are still true — and one may be sounding
    // while the message is on screen. Dropping the counts there leaves a card
    // that says only "refused" over audio the reader can hear.
    el.textContent = r.tts.spoken ? byoErrText(r.tts.err) + " · " + counts
      : byoErrText(r.tts.err);
    ttsStatusA11y(el);
    el.hidden = false;
    return;
  }
  const head = r.tts.speaking
    ? t("ttsStatusSpeaking", "朗读中")
    : t("ttsStatusOn", "朗读已开");
  // Half-width parens even in CJK: the voice name is a Latin token ("nova").
  el.textContent = head + (voice ? " (" + ttsVoiceLabel(voice) + ")" : "") + " · " + counts;
  ttsStatusA11y(el);
  el.hidden = false;
}

// Will the engine actually find this voice on THIS machine? For every provider
// but one that is a question about the name's shape and the language it
// carries. For the browser's own voices it is a question about the machine:
// ttsVoiceOwned says yes to any of them (providers.js explains why — the worker
// has no voice table), while ttsVoice rides storage.sync between machines, so
// the name may be one that only the other machine has. content.js looks it up
// for real and falls back to the system default when it is not there.
function ttsVoiceUsableHere(p, name) {
  const P2 = self.YTDS_PROVIDERS;
  if (!p || !name || !P2) return false;
  if (p.localVoices) {
    try {
      return P2.tts.localVoiceNames(window.speechSynthesis, state.targetLang)
        .indexOf(name) >= 0;
    } catch (_e) { return false; }
  }
  return P2.tts.voiceOwned(p, name) &&
    P2.tts.voiceAppliesTo(p, name, state.targetLang);
}

// The button carries a static aria-label ("read-aloud settings"), and an
// aria-label WINS over the text inside — so a screen reader announced the
// destination and never the status itself. Fold both together: what it says,
// then where it goes.
function ttsStatusA11y(el) {
  const dest = t("ttsOpenSettings", "朗读设置");
  el.setAttribute("aria-label", el.textContent + (dest ? " · " + dest : ""));
}

// ---- read-aloud card ---------------------------------------------------------
// The switch, both volumes and the voice are per-video decisions (the
// competitor ships all four in its popup too), so they live here at one hop;
// region, testing and adding providers stay on the options page behind the
// status button (HCI audit, 设计规范 §5). Exactly one of the two head rows shows.

// Can this provider actually speak, right now, without visiting the settings
// page? A stored key is NOT enough: the key is saved before the test runs, so
// Azure can hold a key and still be missing the region that becomes its
// request host. Offering it would hand the user a switch that only produces
// silence. Same predicate as options.js's ttsReady — they must not drift.
// ("keyless" is the hook for the built-in speechSynthesis engine.)
const TTS_REGION_OK = /^[a-z0-9]{1,42}$/;      // mirrors background.js resolveTts
function ttsUsable(p, keys, region) {
  if (!p) return false;
  // Keyless means the browser speaks it, which is only true where the browser
  // actually can: no speechSynthesis, no offer.
  if (p.localVoices && !(typeof speechSynthesis !== "undefined")) return false;
  if (!p.keyless && !(keys || {})[p.id]) return false;
  if (p.needsRegion && !TTS_REGION_OK.test(String(region || "").trim().toLowerCase())) {
    return false;
  }
  return true;
}

// Two storage reads deep, so a second call can land first. Only the newest
// paint is allowed to touch the DOM.
let ttsPaintGen = 0;
// What the card decided: a status line claiming "speaking" underneath a card
// that is offering "configure…" contradicts itself, and the card is the one
// holding the evidence (key, region, registry).
let ttsCardReady = false;
async function paintTtsCard() {
  let ready = false;
  let current = null;                // the provider actually in use
  let usable = [];                   // every provider that could speak right now
  const gen = ++ttsPaintGen;
  try {
    const got = await new Promise((res) =>
      chrome.storage.sync.get({ ttsProvider: "local-speech", ttsVoice: "", ttsRegion: "" }, res));
    const loc = await new Promise((res) =>
      chrome.storage.local.get({ ttsKeys: {} }, res));
    if (gen !== ttsPaintGen) return;  // a newer paint already answered
    const keys = (loc && loc.ttsKeys) || {};
    const reg = self.YTDS_PROVIDERS && self.YTDS_PROVIDERS.tts;
    if (reg) {
      // A stored key is not a provider that can be reached. The host is an
      // OPTIONAL permission, and the reader can take it back from Chrome's own
      // settings at any moment — after which every line fails with a
      // permission error this card never saw coming, while the menu goes on
      // offering the provider as if it were ready. Keyless providers ask for
      // no host, so there is nothing to have lost.
      const askHost = (p) => new Promise((res) => {
        let done = false;
        const fin = (ok) => { if (!done) { done = true; res(ok ? p : null); } };
        if (!ttsUsable(p, keys, got && got.ttsRegion)) return fin(false);
        if (p.keyless || !p.origin) return fin(true);
        try {
          // Chrome answers by callback or by promise depending on how it was
          // called; take whichever comes, and if neither can be had, keep the
          // provider — hiding a working one is the worse mistake.
          const r = chrome.permissions.contains({ origins: [p.origin + "/*"] },
            (ok) => fin(!chrome.runtime.lastError && !!ok));
          if (r && typeof r.then === "function") r.then((ok) => fin(!!ok), () => fin(true));
        } catch (_e) { fin(true); }
      });
      const withHost = await Promise.all(reg.list.map(askHost));
      if (gen !== ttsPaintGen) return;  // the extra round trip is a newer paint's chance
      usable = withHost.filter(Boolean);
      current = reg.get(got && got.ttsProvider);
      // The stored provider may have stopped being usable — a key cleared on
      // the settings page, an Azure region never filled in. Something keyless
      // is still there, so fall back to it rather than telling the user the
      // feature needs setting up: it does not.
      if (!current || !usable.includes(current)) {
        current = usable.find((p) => p.keyless) || null;
      }
      ready = !!current;
      if (ready) paintTtsVoicePick(usable, current, (got && got.ttsVoice) || "");
    }
  } catch (_e) { /* unconfigured is the safe face */ }
  if (gen !== ttsPaintGen) return;
  const was = ttsCardReady;
  ttsCardReady = ready;
  $("ttsSetupRow").hidden = ready;
  $("ttsSwitchRow").hidden = !ready;
  $("ttsEnabledChk").checked = !!state.ttsEnabled;
  // Controls only while they would be audible: a knob for a switch that is
  // off promises something the off state cannot deliver.
  const live = ready && state.ttsEnabled;
  $("ttsVolRow").hidden = !live;
  $("ttsVol").value = state.ttsVolume;
  $("ttsVolV").textContent = state.ttsVolume + "%";
  $("ttsDuckRow").hidden = !live;
  $("ttsDuck").value = state.ttsDuckPct;
  $("ttsDuckV").textContent = state.ttsDuckPct + "%";
  $("ttsVoiceRow").hidden = !live;
  // Readiness just changed: the status line was drawn under the old answer.
  if (was !== ready) refreshTtsStatus();
}

// One dropdown, both dimensions: every voice of every provider that has its
// key, grouped per provider once there is more than one — choosing a voice is
// choosing its provider (values are "providerId|voice", never bare: voice
// names can repeat across providers).
function ttsVoiceLabel(v) {
  try {
    return self.YTDS_PROVIDERS.tts.voiceLabel(v, (code) => {
      const info = self.YTDS_LANGS && self.YTDS_LANGS.get(code);
      return info ? info.native : "";
    }, (g) => (g === "f" ? t("ttsVoiceFemale", "女声") : t("ttsVoiceMale", "男声")));
  } catch (_e) { return v; }
}

function paintTtsVoicePick(usable, current, storedVoice) {
  const sel = $("ttsVoicePick");
  if (!sel) return;
  sel.textContent = "";
  const addVoice = (parent, p, v) => {
    const o = document.createElement("option");
    o.value = p.id + "|" + v;
    // Who the voice is and where its accent comes from — the raw id says
    // neither, and thirteen raw ids are a wall rather than a choice.
    o.textContent = ttsVoiceLabel(v);
    parent.appendChild(o);
  };
  // The browser's own engine has no list of its own: its voices are whatever
  // this machine has, narrowed to the language being read. Everything else
  // ships its family with it.
  const voicesOf = (p) => (p.localVoices
    ? self.YTDS_PROVIDERS.tts.localVoiceNames(window.speechSynthesis, state.targetLang)
    : (p.voices || []));
  if (usable.length > 1) {
    for (const p of usable) {
      // The local family's group can be momentarily empty — the machine has
      // not answered yet — but it stays listed: "the free engine is always
      // there" is a promise this card makes, and voiceschanged fills it in.
      const g = document.createElement("optgroup");
      // Not p.name: that literal is the Chinese one for the providers that are
      // known by a Chinese name abroad, and an English reader with one key
      // configured was shown a group headed 浏览器内置（免费）.
      g.label = p.nameKey ? t(p.nameKey, p.name) : p.name;
      for (const v of voicesOf(p)) addVoice(g, p, v);
      sel.appendChild(g);
    }
  } else {
    for (const v of voicesOf(current)) addVoice(sel, current, v);
  }
  const choices = voicesOf(current);
  // A voice fetched on the settings page is one the engine will honour but is
  // not in the family we ship. Leaving it out of the menu did not stop it from
  // speaking — it only stopped the menu from admitting which voice that was.
  const P = self.YTDS_PROVIDERS;
  // Not for the browser's own voices. Their names are whatever THIS machine
  // has installed, ttsVoice rides storage.sync between machines, and
  // ttsVoiceOwned cannot check them (providers.js says as much: the worker has
  // no voice table) — so it says yes to a name from the other machine, this
  // branch would list and select it, and the engine, which looks the name up
  // for real, would fall back to the system default. The control would be
  // naming a voice nobody is hearing. Here the machine's own list is the
  // authority, and voiceschanged repaints when it arrives.
  if (storedVoice && !current.localVoices && !choices.includes(storedVoice) &&
      P.tts.voiceOwned(current, storedVoice) &&
      P.tts.voiceAppliesTo(current, storedVoice, state.targetLang)) {
    // Looked up by the SAME expression that wrote it. Three providers carry a
    // nameKey, so p.name and the label on screen are different strings in
    // every locale — matching on p.name found nothing, and the rescued voice
    // landed outside its group at the bottom of the list. Nothing reaches both
    // lines today, which is exactly why it would have gone unnoticed.
    const curLabel = current.nameKey ? t(current.nameKey, current.name) : current.name;
    const parent = usable.length > 1
      ? Array.prototype.find.call(sel.children,
        (g) => g.tagName === "OPTGROUP" && g.label === curLabel) || sel
      : sel;
    addVoice(parent, current, storedVoice);
    choices.push(storedVoice);
  }
  const voice = storedVoice && choices.includes(storedVoice)
    ? storedVoice : (current.defaultVoice || choices[0] || "");
  sel.value = current.id + "|" + voice;
}

// The settings page can pull the ground out from under this card while it is
// open — clearing the key of the provider in use, or filling in the region that
// was missing. Without this the popup keeps offering a switch that can only
// produce silence (or keeps hiding one that would now work).
function initTtsWatch() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.ttsKeys) paintTtsCard();
        return;
      }
      if (area !== "sync") return;
      let touched = false;
      for (const k of ["ttsProvider", "ttsVoice", "ttsRegion"]) {
        if (!changes[k]) continue;
        state[k] = changes[k].newValue == null ? "" : String(changes[k].newValue);
        touched = true;
      }
      if (touched) { paintTtsCard(); refreshTtsStatus(); }
    });
  } catch (_e) { /* without it the card is simply as stale as it used to be */ }
  // The browser's own engine is the default, and its voice table arrives
  // AFTER this page paints — the first synchronous getVoices() is empty in
  // every Chrome. Same reason as the settings page: without this the shipped
  // default has an empty voice menu here too.
  try {
    const synth = window.speechSynthesis;
    if (synth && typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", () => { paintTtsCard(); });
    }
  } catch (_e) { /* an engine without the event simply paints once */ }
}

// ---- line-style card fold ----------------------------------------------------
// Folded by default; opening it sticks (storage.local, per machine — screen
// habits are not preferences worth syncing). The ten controls then only occupy
// the popup for people actually styling their lines.
function setLineFold(open, persist) {
  $("lineCard").classList.toggle("open", !!open);
  $("lineFold").setAttribute("aria-expanded", String(!!open));
  $("lineBody").hidden = !open;
  if (persist) {
    try { chrome.storage.local.set({ uiLineOpen: !!open }); } catch (_e) { /* ignore */ }
  }
}
function initLineFold() {
  try {
    chrome.storage.local.get({ uiLineOpen: false }, (got) => {
      setLineFold(!!(got && got.uiLineOpen), false);
    });
  } catch (_e) { /* stays folded */ }
}

// ---- diagnostics ------------------------------------------------------------
// One click, one plain-text bundle: exactly the facts a "translations don't
// show up" report needs and that no user ever types by hand (store reviews
// prove it). Field names stay English — the reader is the developer; values
// may be anything. Nothing here needs a new permission: version and UA are
// local, gates come from session storage, and the page names itself through
// the content script because the popup deliberately cannot read tab.url.
async function buildDiagnostics() {
  const L = [];
  let ver = "";
  try { ver = chrome.runtime.getManifest().version; } catch (_e) { /* ignore */ }
  L.push("Dual Subtitles for YouTube — diagnostic");
  L.push("version: " + (ver || "?"));
  L.push("browser: " + navigator.userAgent);
  let ui = "";
  try { ui = (chrome.i18n && chrome.i18n.getUILanguage()) || ""; } catch (_e) { /* ignore */ }
  L.push("ui-language: " + (ui || "?") +
    (state.uiLocale && state.uiLocale !== "auto" ? " (override: " + state.uiLocale + ")" : ""));
  L.push("target-language: " + (state.targetLang || "?"));
  L.push("engine-setting: " + (state.engine || "?") +
    (state.engine === "byo"
      ? " (" + (state.byoProvider || "?") + (state.byoModel ? " / " + state.byoModel : "") + ")"
      : ""));
  try {
    if (chrome.storage.session) {
      const got = await chrome.storage.session.get(["ytdsGtxGate", "ytdsByoGate", "ytdsByoStatus"]);
      const gate = (name, g) => {
        if (!g || !g.backoffMs) return name + ": clear";
        const left = Math.max(0, Math.round(((g.gateUntil || 0) - Date.now()) / 1000));
        return name + ": backoff " + Math.round(g.backoffMs / 1000) + "s" +
          (left ? " (" + left + "s left)" : " (expired)");
      };
      L.push(gate("gtx-gate", got && got.ytdsGtxGate));
      L.push(gate("byo-gate", got && got.ytdsByoGate));
      const st = got && got.ytdsByoStatus;
      if (st && st.code) L.push("byo-last-error: " + st.code + " (" + (st.provider || "?") + ")");
    }
  } catch (_e) { L.push("gates: unavailable"); }
  try {
    const tab = await getActiveTab();
    // Bounded here and nowhere else: the two status-line callers can afford to
    // wait forever because all they do is not paint a line, while this one is
    // holding a disabled button.
    const r = tab && tab.id != null
      ? await sendToTab(tab.id, { type: "engineStatus" }, 800) : null;
    if (r && r.ok) {
      L.push("page: " + (r.href || "youtube (id unknown)"));
      L.push("video-engine: " + (r.engine || "none yet") +
        (r.provider ? " (" + r.provider + ")" : "") +
        (r.same ? ", same-language" : "") +
        (r.track && r.track !== "none" ? ", track=" + r.track : "") +
        (r.fellBack ? ", fell-back" : ""));
    } else {
      L.push("page: not a YouTube video tab");
    }
  } catch (_e) { L.push("page: unavailable"); }
  L.push("time: " + new Date().toISOString());
  return L.join("\n");
}

// Collecting takes up to the tab-query deadline, and the answer — success or
// failure — is a label swap. Three things were missing around that:
// the button stayed live while collecting, so a second press started a second
// collection and the two restore timers then fought over the label; the
// restore text was read off the button rather than from its key; and the
// failure branch set a label and scheduled nothing, so a refused clipboard
// left "copy failed" on a settings page that stays open for hours.
let diagBusy = false;
let diagRestore = 0;

async function onDiagCopy() {
  const btn = $("diagCopy");
  if (diagBusy) return;
  diagBusy = true;
  clearTimeout(diagRestore);
  if (btn) btn.disabled = true;
  const restoreIn = (ms) => {
    diagRestore = setTimeout(() => {
      if (!btn) return;
      btn.classList.remove("ok");
      btn.textContent = t("diagCopy", "复制诊断信息");
    }, ms);
  };
  try {
    const text = await buildDiagnostics();
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.classList.add("ok");
      btn.textContent = t("diagCopied", "已复制 — 直接粘贴进邮件或 issue");
      restoreIn(2200);
    }
  } catch (_e) {
    if (btn) {
      btn.textContent = t("diagCopyFail", "复制失败 — 请改用截图");
      restoreIn(2200);
    }
  } finally {
    diagBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ---- BYO-key engine row ---------------------------------------------------
// Everything configurable about an own-key engine lives on the options page
// (options.js explains why — in short, a permission prompt can dismiss a popup
// and take the callback with it). The popup only reports what is set up and
// links there; it never reads or writes the key itself.
const P = self.YTDS_PROVIDERS;

function tsub(key, subs, fb) {
  try { return self.YTDS_I18N.get(key, subs) || fb; }
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
  const label = (p.shortKey && t(p.shortKey, p.short)) || p.short || p.name;
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
      // The model id is the part users compare against a bill or a doc, and in
      // long-label locales the row ellipsizes it — hover keeps the full text.
      sum.title = sum.textContent;
      return;
    }

    sum.hidden = true;
    pick.hidden = false;
    pick.textContent = "";
    for (const x of configured) {
      const o = document.createElement("option");
      o.value = x.id;
      const name = (x.shortKey && t(x.shortKey, x.short)) || x.short || x.name;
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

// The one panel whose whole job is to tell you what something will cost before
// you agree to it. It used to appear with no role, no name and no focus move:
// a keyboard user pressed Download, focus stayed on the button, and the
// estimate was announced to nobody. Escape now cancels it too — there was no
// keydown handler anywhere in this popup.
// The two opacity sliders run 0..1 and their badges read as a percentage, so
// a screen reader announced "0.6" beside a label that says 60%. One helper
// writes both, and the value a reader hears is the value on screen.
function setPct(id, v) {
  const pct = Math.round(v * 100) + "%";
  const badge = $(id + "V");
  if (badge) badge.textContent = pct;
  const input = $(id);
  if (input) input.setAttribute("aria-valuetext", pct);
}

function showConfirm(text) {
  $("exportConfirmText").textContent = text;
  $("exportConfirm").hidden = false;
  const go = $("exportGo");
  if (go) { try { go.focus(); } catch (_e) { /* ignore */ } }
}
// dismissed: the READER closed this — Escape, or the back link. Then focus
// belongs on the control that opened it, rather than falling to the top of the
// document. Most callers are not that: they close the panel because the
// estimate on it went stale (the engine changed, the variant changed, the
// own-key box was ticked), and the reader is still on the control they just
// used. Moving them off it mid-thought is the opposite of what putting focus
// back is for. The export path is not a dismissal either — it focuses the
// button it is about to disable, which drops focus to the body.
function hideConfirm(dismissed) {
  const panel = $("exportConfirm");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  if (!dismissed) return;
  const back = $("exportBtn");
  if (back && !back.disabled) { try { back.focus(); } catch (_e) { /* ignore */ } }
}

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
  setPct("lineBgOpacity", state[m.bgOpacity]);
  $("lineStrokeOpacity").value = state[m.strokeOpacity];
  setPct("lineStrokeOpacity", state[m.strokeOpacity]);

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
let posHintTimer = 0;

function wire() {
  $("enabled").addEventListener("change", (e) => setKey("enabled", e.target.checked));
  $("diagCopy").addEventListener("click", onDiagCopy);
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
    // The export card is derived from the engine too, and it was drawn once at
    // boot. Switching engines inside the popup therefore left it describing the
    // engine that used to be selected: the own-key download unreachable after
    // switching to it, and — worse — a warning about spending your own quota
    // standing over a download that had just become free. A note about money
    // and about where the whole track gets sent is the last thing that may go
    // stale while the user is looking at it.
    paintExportEngine();
    // An estimate on screen was calculated for the old engine. It is not an
    // answer to the question the card now asks.
    hideConfirm();
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

  // ---- read-aloud card ---
  // Both doors land on the read-aloud pane: the empty state to set it up, the
  // status line for the low-frequency knobs (voice, region, ducking).
  $("ttsConfigure").addEventListener("click", () => toOptions("#readaloud"));
  $("ttsStatus").addEventListener("click", () => toOptions("#readaloud"));
  $("ttsEnabledChk").addEventListener("change", (e) => {
    setKey("ttsEnabled", e.target.checked);
    paintTtsCard();                // the volume row follows the switch
    refreshTtsStatus();            // and the status line follows both
  });
  $("ttsVol").addEventListener("input", (e) => {
    $("ttsVolV").textContent = e.target.value + "%";
    setKey("ttsVolume", +e.target.value);   // content.js re-levels a playing line
  });
  $("ttsDuck").addEventListener("input", (e) => {
    $("ttsDuckV").textContent = e.target.value + "%";
    setKey("ttsDuckPct", +e.target.value);  // rides the next duck message
  });
  // One change, both keys, one write: the engine reads them together and the
  // options page follows through its storage listener.
  $("ttsVoicePick").addEventListener("change", (e) => {
    const cut = e.target.value.indexOf("|");
    if (cut < 1) return;
    const provider = e.target.value.slice(0, cut);
    const voice = e.target.value.slice(cut + 1);
    state.ttsProvider = provider;
    state.ttsVoice = voice;
    chrome.storage.sync.set({ ttsProvider: provider, ttsVoice: voice });
    refreshTtsStatus();                     // the "(voice)" in the status line
  });

  // line-style card fold
  $("lineFold").addEventListener("click", () => {
    setLineFold($("lineBody").hidden, true);
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
    // Restore from the key, not from whatever is on screen. Read back inside
    // the 2.6s window, "what was there" is the previous ANSWER, so a second
    // press — which is exactly what someone does when they miss a reply this
    // quiet — wrote the answer back permanently and the line never returned to
    // being an explanation. Clearing the pending timer stops the two from
    // racing as well.
    clearTimeout(posHintTimer);
    hint.textContent = t("posTryNoVideo", "请先打开 YouTube 视频页");
    posHintTimer = setTimeout(() => {
      hint.textContent = t("posHint", "也可直接在视频上拖动字幕框");
    }, 2600);
  });

  // A popup can be dismissed the moment a drag ends, taking any pending timer
  // with it. `change` fires on release for range and colour inputs, so the last
  // value of a gesture is always written even if the debounce never fires.
  document.querySelectorAll('input[type="range"], input[type="color"]').forEach((el) =>
    el.addEventListener("change", () => flushWrites(1)));

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
    setPct("lineBgOpacity", +e.target.value);
    setKey(LINE[activeLine].bgOpacity, +e.target.value);
  });
  $("lineStrokeOpacity").addEventListener("input", (e) => {
    setPct("lineStrokeOpacity", +e.target.value);
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
  $("exportBack").addEventListener("click", () => hideConfirm(true));
  // Escape cancels the spend confirmation. There was no keydown handler in
  // this popup at all, so the only way out of that panel was to find the
  // Cancel button — which is also the only place the estimate is announced.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const panel = $("exportConfirm");
    if (!panel || panel.hidden) return;
    e.preventDefault();
    hideConfirm(true);
  });
  $("exportStop").addEventListener("click", onExportStop);

  // reset all
  $("reset").addEventListener("click", () => {
    state = { ...DEFAULTS };
    chrome.storage.sync.set(DEFAULTS);   // engine:"auto" + backend:"tlang" mirror included
    // Reset means reset: don't leave orphan API keys on the machine. Both
    // stores, not just the translation one — read-aloud keys were surviving a
    // reset that had already switched the feature off, so turning it back on
    // silently resumed spending an account the user thought they had cleared.
    // The panels also have their own "clear" buttons for doing this alone.
    try {
      // byoOk goes with them. It records which providers have PROVEN a key by
      // answering a request; kept after the keys are gone, the next key typed
      // into that provider inherits a tick it never earned and the panel calls
      // it verified without anything having been tested.
      chrome.storage.local.remove(["byoKeys", "ttsKeys", "byoOk"]);
      chrome.storage.sync.remove(["ttsProvider", "ttsVoice", "ttsRegion"]);
      paintByoPanel();               // the summary must stop claiming a key
      paintTtsCard();                // …and so must the read-aloud card
    } catch (_e) { /* ignore */ }
    bindUI();
    refreshEngineStatus();
    refreshTtsStatus();              // reset turned read-aloud off: hide its line
    paintTtsCard();                  // …and put the switch row back to unchecked
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
    const ui = self.YTDS_I18N.effectiveLang();
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
      const lang = popupLang();
      let label = "";
      try { label = self.YTDS_I18N.get("whatsNewRow", [ver]); } catch (_e) { /* ignore */ }
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
// The i18n override has to be known before anything paints text — one storage
// read (and, only under an override, one fetch of a packaged file).
self.YTDS_I18N.init().then(() => {
  applyI18n();                     // localize static markup before first paint
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
    initLineFold();
    initTtsWatch();
    refreshEngineStatus();
    refreshTtsStatus();
    paintTtsCard();
    resumeExport();
  });
});
