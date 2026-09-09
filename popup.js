// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.
// The live preview uses the SAME font map + rgba/outline logic as content.js.

// ---- shared settings model ------------------------------------------------
// Every key here must agree with content.js DEFAULTS where both carry it. The
// two lists are NOT identical and the comment used to claim they were: this one
// also holds the popup-only picker state (ttsProvider / ttsVoice / ttsRegion /
// ttsBaseUrl / langShown), and content.js holds ttsComplete, which only the
// player side reads. Anything outside the overlap is written straight to sync
// by whoever owns it — so a reset here has to name those keys explicitly rather
// than trust set(DEFAULTS) to cover them.
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
  ttsBaseUrl: "",              // custom read-aloud endpoint (its own key: D105)
  updateNotes: true,           // open release notes page after feature updates
  // Steady-cruise backdoor keys (no UI here or anywhere yet): content.js
  // sizes read-aloud with them in dense stretches; listed to keep the
  // DEFAULTS contract with content.js in sync.
  ttsCruise: true,
  ttsCruiseRate: 1.25,
  ttsCruiseVideo: 0.85,
  order: "orig-top",           // "orig-top" | "trans-top"
  rowGap: 4,
  position: "bottom",          // "top" | "center" | "bottom"
  posMode: "preset",           // "preset" | "custom"
  selectText: false,           // lines take the pointer for select-and-copy
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
      "翻译接口暂时限流，已自动放慢重试；已翻译的句子还在。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  // A failing BYO engine has to say so: unlike gtx it has no free fallback, so
  // staying quiet would just look like "the extension stopped translating".
  if (byoCode) {
    el.textContent = byoErrText(byoCode, activeProvider());
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const r = await sendToTab(tab.id, { type: "engineStatus" });
  if (!r || !r.ok) return;                  // not a YouTube video page

  // The caption track itself is missing and the recovery loop is on it. This
  // outranks every note below: nothing about engines or languages is true of
  // a video whose track never arrived.
  if (r.trackWait) {
    el.textContent = t("statusTrackRetry",
      "字幕轨没拿到，正在自动重试；急的话刷新页面立即重来。");
    el.classList.add("warn");
    el.hidden = false;
    return;
  }

  if (r.same) {
    // The track already speaks the target language, so the overlay renders a
    // single line. Shown in EVERY engine mode (it answers "why is there only
    // one line?"), unlike the engine line below which is auto-mode-only.
    el.textContent = t("backendStatusSame", "本视频字幕已是译文语言，无需翻译。");
    el.hidden = false;
    return;
  }
  // "Smart sentences (Google)" with no explanation reads as a bug when the
  // user had YouTube's own translation yesterday — reported live in exactly
  // those words. When the reason is the rate limit on YouTube's endpoint, say
  // so. AFTER the same-language check: a video that needs no translation has
  // nothing "filled in", whatever the gate says. And not only for auto — the
  // user who explicitly chose YouTube's translation and is silently getting
  // Google instead is the one who most deserves the explanation.
  if (r.tlangLimited && r.engine === "gtx" &&
      (state.engine === "auto" || state.engine === "tlang")) {
    el.textContent = t("tlangLimitedNote",
      "YouTube 翻译暂时被限流，已用智能整句（Google）顶上；稍后会自动再试。");
    el.classList.add("warn");
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
  // The hint is (re)evaluated on every paint INCLUDING the early returns — a
  // hint left standing after the status row hid is the stale-row bug class.
  // Null hides it until fresh engine data proves it should show.
  paintCompleteHint(null);
  const el = $("ttsStatus");
  if (!el) return;
  el.hidden = true;
  if (!state.ttsEnabled || !ttsCardReady) return;
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const r = await sendToTab(tab.id, { type: "engineStatus" });
  paintCompleteHint(r && r.ok ? r : null);
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
  // A bare "skipped 2" reads as a fault. Most of the time it is not one — the
  // translation simply had not arrived for those lines yet, which is the
  // engine catching up, not failing. Say which it was; the reason took two
  // rounds of guessing to establish when the number stood alone.
  const why = skipWhyText(r.tts.skipWhy);
  const counts = (r.tts.skipped && why)
    ? tsub("ttsStatusCountsWhy",
        [String(r.tts.spoken), String(r.tts.skipped), why],
        "本视频 " + r.tts.spoken + " 句 · 跳过 " + r.tts.skipped + " 句（" + why + "）")
    : tsub("ttsStatusCounts",
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

// The completeness switch's door. Shows only when THIS video at THIS speed is
// audibly cutting tails (over/spoken >= 15%, at least 6 cuts, 12 lines heard,
// rate >= 1.25) and the switch is off — the case where the reader does not
// know the cure exists (four-way review Q2, 4/4: hint over default-change; the panel
// put the bar anywhere in 15-25%). It shipped at 25% — a number from BEFORE
// the speech-rate slope landed beside it: post-slope a 2x video runs ~20-25%
// cut (measured 2026-09-01, 84% -> 25% on the same clip), so the door never
// opened and the owner reported exactly that. One tap flips the real setting;
// "never" is a permanent per-machine dismissal, matching its words.
function paintCompleteHint(r) {
  const row = $("ttsCompleteHint");
  if (!row) return;
  const t2 = r && r.tts;
  const want = !!(t2 && !state.ttsComplete && (t2.uRate || 0) >= 1.25 &&
    (t2.spoken || 0) >= 12 && (t2.over || 0) >= 6 &&
    t2.over / Math.max(1, t2.spoken) >= 0.15);
  if (!want) { row.hidden = true; return; }
  chrome.storage.local.get({ ytdsCompleteHintOff: 0 }, (got) => {
    if (got && got.ytdsCompleteHintOff) { row.hidden = true; return; }
    row.hidden = false;
  });
}

function initCompleteHint() {
  const on = $("ttsCompleteHintOn"), off = $("ttsCompleteHintOff"), row = $("ttsCompleteHint");
  if (!on || !off || !row) return;
  on.addEventListener("click", () => {
    // Direct write, not the debounced helper: the reader just chose, and the
    // running video should slow on its very next line.
    state.ttsComplete = true;
    chrome.storage.sync.set({ ttsComplete: true });
    row.hidden = true;
  });
  off.addEventListener("click", () => {
    chrome.storage.local.set({ ytdsCompleteHintOff: 1 });
    row.hidden = true;
  });
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
// Why lines were skipped, in words. Only two answers are worth a viewer's
// attention: the words were not translated yet (normal, it catches up), or
// the voice never made a sound (a fault, and the error line above already
// names it when the provider said why). Anything the engine reports that is
// neither leaves the count to stand on its own.
function skipWhyText(code) {
  if (code === "noText") return t("ttsSkipLate", "译文没赶上");
  if (code === "dead" || code === "decode" ||
      code === "neverBegan" || code === "nosynth") {
    return t("ttsSkipSilent", "没出声");
  }
  // …and these never reached a provider at all: the extension stopped at its
  // own door. No key stored, no endpoint typed, no host permission, no model
  // — nothing left this machine, so "the provider refused those requests" is
  // a statement about someone else's server for a request that was never
  // sent. It is the same shape as the privacy sentence next door: an
  // assertion about a system we did not talk to. Measured 2026-09-03 with the
  // key deleted: zero synthesis requests, and the card said the provider had
  // refused three of them.
  if (code === "noKey" || code === "noProvider" || code === "noPerm" ||
      code === "badBaseUrl" || code === "noModel") {
    return t("ttsSkipNotSet", "这台电脑上还没配好");
  }
  // Everything else is a provider's own refusal code (429, quota, auth…).
  // These used to map to the empty string, so the reader saw a bare
  // "skipped 40" with nothing to act on — reported in exactly those words
  // ("明明跳过了很多 它却不显示", 2026-08-31).
  if (code) return t("ttsSkipRefused", "服务商拒绝了请求");
  return "";
}

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
  // The custom server is configured by its ADDRESS; an empty key is a valid
  // setup there (no Authorization header) — mirrors resolveTts.
  if (p.custom) return !!String(state.ttsBaseUrl || "").trim();
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
// Retry state for the local voice list, module-level so a repaint triggered by
// the retry itself does not start a second chain.
let localVoiceRetry = 0;
let localVoiceTimer = 0;

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
      if (ready) {
        // Read before painting: the picker is built in one pass and the recent
        // list is part of what it offers.
        const recents = await recentsRead(RECENT_VOICES);
        if (gen !== ttsPaintGen) return;
        paintTtsVoicePick(usable, current, (got && got.ttsVoice) || "", recents);
      }
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

// What the row and its menu are drawing, filled by the paint that already
// worked out which families can speak at all.
let ttsPick = { usable: [], current: null, voice: "", recents: [] };

// The voice this family is actually speaking with. A stored voice can belong
// to another machine (the choice syncs, the machine's voice list does not) or
// to a provider that stopped offering it — in both cases the family's own
// first voice is what will be heard, so it is what the row must name.
function voiceInUse(p, storedVoice, have) {
  if (!p) return "";
  if (storedVoice && ttsVoiceUsableHere(p, storedVoice)) return storedVoice;
  const list = have || familyVoices(p);
  return p.localVoices ? (list[0] || "") : (p.defaultVoice || list[0] || "");
}

// One family's own voices: the machine's list for the browser engine, what we
// ship for the rest. The fetched catalogue is added in the menu, which can
// afford to wait for storage; this one is called on every paint.
function familyVoices(p) {
  if (!p) return [];
  if (p.localVoices) {
    try {
      return self.YTDS_PROVIDERS.tts.localVoiceNames(
        window.speechSynthesis, state.targetLang) || [];
    } catch (_e) { return []; }
  }
  return (p.voices || []).filter((v) => ttsVoiceUsableHere(p, v));
}

// The machine answers late, and sometimes never announces it: getVoices() is
// empty until Chrome has built its table, and "voiceschanged" does not fire if
// the table was already built when we asked (D67 refuted the poll shape on the
// settings page for the same reason). So heal the paint rather than time the
// machine — whenever this row draws an empty local list, draw it again shortly.
function localVoiceLate() {
  if (localVoiceRetry >= 8) return;
  localVoiceRetry++;
  clearTimeout(localVoiceTimer);
  localVoiceTimer = setTimeout(paintTtsCard, 120 * localVoiceRetry);
}

// The row: mark, provider, voice — the shape the translation row has had all
// along. It carried both dimensions in a single dropdown until 2026-08-30,
// which meant every configured family's voices in one list and no way to
// browse ONE family without going to the settings page. Picking a voice still
// writes both keys; the provider simply has a control of its own now.
function paintTtsVoicePick(usable, current, storedVoice, recents) {
  const sel = $("ttsProviderPick");
  const btn = $("ttsVoiceBtn");
  const nameEl = $("ttsProviderName");
  const slot = $("ttsIcon");
  if (!sel || !btn) return;
  const have = familyVoices(current);
  if (current && current.localVoices) {
    if (have.length) localVoiceRetry = 0; else localVoiceLate();
  }
  const voice = voiceInUse(current, storedVoice, have);
  ttsPick = { usable: usable || [], current: current, voice: voice, recents: recents || [] };
  if (slot) {
    slot.textContent = "";
    if (self.YTDS_ICONS) slot.appendChild(self.YTDS_ICONS.iconFor(current));
  }
  const label = (p) => (p.shortKey && t(p.shortKey, p.short)) || p.short || p.name;
  // One family that can speak is not a choice to offer — the translation row
  // hides its picker the same way and says the name instead.
  const many = (usable || []).length > 1;
  sel.hidden = !many;
  if (nameEl) {
    nameEl.hidden = many;
    if (!many && current) { nameEl.textContent = label(current); nameEl.title = nameEl.textContent; }
  }
  // Rebuilt every paint, hidden or not: a family that stopped being usable —
  // a key cleared, a host permission taken back — must not be left behind in
  // the list as an option nobody can hear.
  sel.textContent = "";
  {
    for (const p of usable || []) {
      const o = document.createElement("option");
      o.value = p.id;
      // Name only. The "best for Chinese" tag rides along on the settings
      // page and in the voice list, where there is room for it; in a picker
      // capped at half a 360px row it is what gets clipped — measured, and it
      // clips mid-word ("中文推"), which reads as a bug rather than a hint.
      o.textContent = label(p);
      sel.appendChild(o);
    }
    sel.value = current ? current.id : "";
    if (many) fitPickWidth(sel);
  }
  btn.textContent = "";
  const b = document.createElement("b");
  b.textContent = voice ? ttsVoiceLabel(voice) : t("popupVoiceNone", "未选音色");
  btn.appendChild(b);
  btn.title = b.textContent;
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
      // The completeness switch can be flipped on the settings page while this
      // popup is open; the cut-hint reads it, so it must follow (and so must
      // the hint's own visibility, via the same repaint).
      if (changes.ttsComplete) {
        state.ttsComplete = !!changes.ttsComplete.newValue;
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
    // The event alone is not enough — it only comes if the table was NOT
    // already built when we asked. That half is handled where the list is
    // actually drawn (see the self-healing retry at the end of paintTtsVoices).
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
// The bundle itself is built in diag.js, shared with the settings page. This
// file used to carry its own older copy — the one behind the button that only
// shows up when something is already wrong.
async function buildDiagnostics() {
  return self.YTDS_DIAG.build(state);
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

function byoErrText(code, provider) {
  return t(P ? P.errorKey(code, provider) : "byoErrFailed",
    t("byoErrFailed", "连接失败，稍后再试。"));
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
    // "Set up" means a saved key — except the custom endpoint, whose whole
    // configuration may be just a base URL (a keyless local server), and the
    // keyless presets (Ollama), where the only proof there is anything at that
    // address is a passed Save-and-test (byoOk). Keys alone answered this
    // until 2026-09-01: a tested Ollama was then offered nowhere — the menu
    // skipped it, this row called it unconfigured, and the picker sat empty
    // at full CSS width because its value matched no option.
    const isSetUp = (x) => !!keys[x.id] ||
      (x.custom && !!state.byoBaseUrl) ||
      (x.noKey && !!okMap[x.id]);
    const configured = (P ? P.list : []).filter(isSetUp);
    const model = state.byoModel || p.defaultModel || "";
    // The model used to be half of this line's text. It is now the row's own
    // control, because it is the part that changes — and the part a reader
    // compares against a bill or a doc.
    // Only an LLM has a model to name. DeepL is a translation API with one
    // endpoint and nothing to choose, and the row offered it "未选模型" —
    // a control for a question that provider does not have. The settings page
    // has always guarded this (paintModelRow returns for kind !== "llm"); the
    // popup did not.
    paintModelBtn(isSetUp(p) && p.kind === "llm" ? model : null);

    if (!pick || configured.length < 2) {
      if (pick) pick.hidden = true;
      sum.hidden = false;
      // "Untested" is said in the dropdown when two or more are configured, and
      // was silent for the reader with exactly one — who is the likeliest to be
      // looking at a key that has never answered anything.
      sum.textContent = !isSetUp(p) ? label + " — " + notSet
        : okMap[p.id] ? label
        : label + " · " + t("popupByoUntested", "未验证");
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
    fitPickWidth(pick);
  });
}

// A native select is as wide as its WIDEST option, not the one it is showing.
// With "SiliconFlow · 未验证" in the list, "DeepL" sat in a box twice the width
// of the word — reported from the real machine with a screenshot. So the box
// asks for what is on screen; the CSS cap on half the row still applies, and a
// longer name simply hits it.
function fitPickWidth(sel) {
  if (!sel || sel.hidden) return;
  const label = (sel.options[sel.selectedIndex] || {}).textContent || "";
  let w = 0;
  try {
    const cs = getComputedStyle(sel);
    const c = fitPickWidth.canvas || (fitPickWidth.canvas = document.createElement("canvas"));
    const ctx = c.getContext("2d");
    ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    w = ctx.measureText(label).width;
  } catch (_e) { /* no canvas in some rigs: leave the box as it was */ }
  // padding (9 + 26) + border (2) + a hair so the text never touches the arrow
  sel.style.width = w ? Math.ceil(w + 39) + "px" : "";
}

// Switching providers here changes only which of the set-up ones is in use;
// keys, models and endpoints all stay where the settings page put them. The
// model follows its own provider (byoModelBy), so going back and forth does not
// quietly reset it to the default.
function onPickProvider() {
  const id = $("byoPick").value;
  if (!id || id === state.byoProvider) return;
  // Whatever is on screen belongs to the provider being left. The select can be
  // changed from the keyboard, which fires no click for the outside-click
  // handler to catch, so an open menu would otherwise stay — offering the old
  // family's models under the new family's name.
  closeModelMenu();
  chrome.storage.sync.get({ byoModelBy: {} }, (got) => {
    const byProvider = (got && got.byoModelBy) || {};
    state.byoProvider = id;
    state.byoModel = byProvider[id] || "";
    chrome.storage.sync.set({ byoProvider: id, byoModel: state.byoModel });
    paintByoPanel();
  });
}

// The model gets its own control on that row. Before anything is set up there
// is no model to name, and the panel says so instead.
function paintModelBtn(model) {
  const btn = $("byoModelBtn");
  const cfg = $("byoConfigure");
  const sum = $("byoSummary");
  const row = sum ? sum.parentElement : null;
  const shown = model !== null;
  if (btn) {
    btn.hidden = !shown;
    if (shown) {
      const name = model || t("popupModelNone", "未选模型");
      btn.textContent = "";
      const b = document.createElement("b");
      b.textContent = name;
      btn.appendChild(b);
      // Long ids — deepseek-v4-flash, an Ollama tag — ellipsize on a 360px row.
      btn.title = name;
    }
  }
  // Until something is set up, "配置…" is the only way in and stays. After, the
  // way to the settings page rides the menu's last row: three hit areas on this
  // line would be two too many (方案 §二, grok's ruling).
  if (cfg) cfg.hidden = shown;
  if (row) row.classList.toggle("has-model", shown);
  if (!shown) closeModelMenu();
}

// ---- recent picks ----------------------------------------------------------
// Newest first, at most five, in storage.LOCAL — never sync. A recent entry
// names a provider whose key lives on THIS machine, so a synced list would
// offer the other machine models it has no key for. What deserves to travel is
// the choice in force, and that already rides sync.
const RECENT_MODELS = "byoModelRecents";
const RECENT_VOICES = "ttsVoiceRecents";
const RECENT_MAX = 5;

function recentsRead(store) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [store]: [] }, (got) => {
        const list = (got && got[store]) || [];
        resolve(Array.isArray(list)
          ? list.filter((x) => x && typeof x.p === "string" && typeof x.id === "string")
          : []);
      });
    } catch (_e) { resolve([]); }
  });
}

function recentsPush(store, providerId, id) {
  return recentsRead(store).then((was) => new Promise((resolve) => {
    const next = [{ p: providerId, id }]
      .concat(was.filter((x) => !(x.p === providerId && x.id === id)))
      .slice(0, RECENT_MAX);
    try { chrome.storage.local.set({ [store]: next }, () => resolve()); }
    catch (_e) { resolve(); }
  }));
}

// ---- the model menu --------------------------------------------------------
// Read-only by design. Everything it offers is already on this machine: the
// short list we ship, whatever the settings page fetched with this key, and
// what was picked recently. The popup never fetches — a request from a window
// that dies the moment focus leaves it reads as a broken extension, and a
// catalogue call on a paid key is not something to spend on a glance.
const MENU_MAX = 8;

function askWorker(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) =>
        resolve(chrome.runtime.lastError ? null : r));
    } catch (_e) { resolve(null); }
  });
}

// Which stored catalogue belongs to the endpoint and key in force. The worker
// answers with the endpoint and a one-way fingerprint of the key — this window,
// like the settings page, never holds a key value.
async function cachedCatalog(kind, providerId) {
  const tag = await askWorker({ type: "catalogTag",
    kind: kind === "m" ? "byo" : "tts", provider: providerId });
  const got = await new Promise((resolve) => {
    try { chrome.storage.local.get({ byoCatalogs: {} }, resolve); }
    catch (_e) { resolve(null); }
  });
  try {
    return self.YTDS_CATALOG.pick((got && got.byoCatalogs) || {},
      kind, providerId, tag);
  } catch (_e) { return null; }
}

async function modelMenuItems(p) {
  const current = state.byoModel || p.defaultModel || "";
  const out = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  // The one in use goes first and is never left out. It may have been typed on
  // the settings page, fetched by a key this machine no longer has, or chosen
  // on another machine — the choice syncs, the catalogue does not — and a menu
  // that dropped it would read as the model having been unset.
  add(current);
  for (const r of await recentsRead(RECENT_MODELS)) if (r.p === p.id) add(r.id);
  (p.models || []).forEach(add);
  const hit = await cachedCatalog("m", p.id);
  if (hit) hit.items.forEach(add);
  return { items: out.slice(0, MENU_MAX), current, cached: !!hit };
}

let modelMenuGen = 0;

function modelMenuIsOpen() {
  const menu = $("byoModelMenu");
  return !!(menu && !menu.hidden);
}

function closeModelMenu() {
  const menu = $("byoModelMenu");
  const btn = $("byoModelBtn");
  if (menu) { menu.hidden = true; menu.textContent = ""; }
  if (btn) btn.setAttribute("aria-expanded", "false");
  modelMenuGen++;          // a build still in flight must not paint over this
}

async function openModelMenu() {
  const p = activeProvider();
  const menu = $("byoModelMenu");
  const btn = $("byoModelBtn");
  if (!p || !menu || !btn) return;
  const gen = ++modelMenuGen;
  const { items, current, cached } = await modelMenuItems(p);
  if (gen !== modelMenuGen) return;   // a newer open, or a close, got here first
  if (activeProvider() !== p) return; // …or the row changed provider meanwhile
  menu.textContent = "";
  for (const id of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pmenu-item" + (id === current ? " on" : "");
    row.setAttribute("role", "menuitem");
    if (id === current) row.setAttribute("aria-current", "true");
    const label = document.createElement("span");
    label.textContent = id;
    row.appendChild(label);
    row.title = id;
    row.addEventListener("click", () => onPickModel(id));
    menu.appendChild(row);
  }
  const sep = document.createElement("div");
  sep.className = "pmenu-sep";
  menu.appendChild(sep);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "pmenu-item pmenu-more";
  more.setAttribute("role", "menuitem");
  const moreLabel = document.createElement("span");
  // Nothing here but the model in use, and nothing fetched with this key: the
  // last row says what to do about that rather than reporting an empty list.
  moreLabel.textContent = (!cached && items.length < 2)
    ? t("popupModelFetch", "到设置页拉取模型")
    : t("popupModelMore", "更多模型…");
  more.appendChild(moreLabel);
  more.addEventListener("click", () => openOptionsAt("#setup"));
  menu.appendChild(more);
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const first = menu.querySelector(".pmenu-item.on") || menu.querySelector(".pmenu-item");
  if (first) first.focus();
}

// Storage first, screen after: a click that lands outside an extension popup
// can close the whole window with it, and a switch that only reached the screen
// is a switch that did not happen. Both keys in one write — byoModel is what
// the worker reads next, byoModelBy is what brings this model back after a hop
// to another provider and back.
async function onPickModel(id) {
  const p = activeProvider();
  closeModelMenu();
  // The row that opened the menu takes the focus back. Hiding the element the
  // focus was inside drops it on <body>, which loses a keyboard reader their
  // place entirely.
  const opener = $("byoModelBtn");
  if (opener && !opener.hidden) opener.focus();
  if (!p || !id) return;
  if (id === (state.byoModel || p.defaultModel || "")) return;
  const got = await new Promise((resolve) => {
    try { chrome.storage.sync.get({ byoModelBy: {} }, resolve); }
    catch (_e) { resolve(null); }
  });
  // The provider picker is one click away from this menu, and this read has
  // just been to storage and back. If the reader switched providers in that
  // window, byoModel now belongs to the other one — writing ours over it would
  // leave the row naming a model that provider cannot use. The per-provider
  // memory is still worth keeping, so it is written either way, below.
  const stillOurs = state.byoProvider === p.id;
  const byProvider = Object.assign({}, (got && got.byoModelBy) || {});
  byProvider[p.id] = id;
  const write = stillOurs
    ? { byoModel: id, byoModelBy: byProvider }
    : { byoModelBy: byProvider };
  await new Promise((resolve) => {
    try { chrome.storage.sync.set(write, () => resolve()); }
    catch (_e) { resolve(); }
  });
  await recentsPush(RECENT_MODELS, p.id, id);
  if (!stillOurs) return;              // the row belongs to someone else now
  state.byoModel = id;
  paintByoPanel();
  // Lines already on screen keep the translation they were given: switching
  // model means "the part coming up is hard", not "buy the last twenty minutes
  // again". The next line out is the first one the new model sees.
  showModelMsg(tsub("popupModelSwitched", [id], "此后使用 " + id));
}

// ---- the voice menu -------------------------------------------------------
// Twin of the model menu, and for the same reason: one family at a time. The
// voice in use first, then what was picked lately, then the rest of that
// family — and the last row is the settings page, which is the only place that
// can fetch a language's full catalogue and play it before you commit.
//
// Not capped the way models are: a family's voices ARE this control's subject,
// the menu scrolls, and "the one I want is not here, so I have to go to the
// settings page" is exactly the complaint this row was rebuilt to answer.
const VOICE_MENU_MAX = 60;
let voiceMenuGen = 0;

async function voiceMenuItems(p) {
  const current = ttsPick.voice || "";
  const out = [];
  const seen = new Set();
  const names = Object.create(null);
  const add = (v) => { if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
  add(current);
  for (const r of ttsPick.recents) {
    if (r.p === p.id && ttsVoiceUsableHere(p, r.id)) add(r.id);
  }
  familyVoices(p).forEach(add);
  // What this key fetched on the settings page. The machine's own voices are
  // never cached — they are asked for fresh, and they belong to this machine.
  if (!p.localVoices) {
    const hit = await cachedCatalog("v " + (state.targetLang || ""), p.id);
    if (hit) {
      (hit.items || []).forEach((v) => {
        add(v);
        if (hit.names && hit.names[v]) names[v] = hit.names[v];
      });
    }
  }
  return { items: out.slice(0, VOICE_MENU_MAX), current, names };
}

function voiceMenuIsOpen() {
  const menu = $("ttsVoiceMenu");
  return !!(menu && !menu.hidden);
}

function closeVoiceMenu() {
  const menu = $("ttsVoiceMenu");
  const btn = $("ttsVoiceBtn");
  if (menu) { menu.hidden = true; menu.textContent = ""; }
  if (btn) btn.setAttribute("aria-expanded", "false");
  voiceMenuGen++;
}

async function openVoiceMenu() {
  const p = ttsPick.current;
  const menu = $("ttsVoiceMenu");
  const btn = $("ttsVoiceBtn");
  if (!p || !menu || !btn) return;
  const gen = ++voiceMenuGen;
  const { items, current, names } = await voiceMenuItems(p);
  if (gen !== voiceMenuGen) return;          // a newer open, or a close, won
  if (ttsPick.current !== p) return;         // …or the row changed family
  menu.textContent = "";
  for (const v of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pmenu-item" + (v === current ? " on" : "");
    row.setAttribute("role", "menuitem");
    if (v === current) row.setAttribute("aria-current", "true");
    const label = document.createElement("span");
    label.textContent = names[v] || ttsVoiceLabel(v);
    row.appendChild(label);
    row.title = label.textContent;
    row.addEventListener("click", () => onPickVoice(v));
    menu.appendChild(row);
  }
  const sep = document.createElement("div");
  sep.className = "pmenu-sep";
  menu.appendChild(sep);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "pmenu-item pmenu-more";
  more.setAttribute("role", "menuitem");
  const moreLabel = document.createElement("span");
  moreLabel.textContent = t("popupVoiceMore", "更多音色…");
  more.appendChild(moreLabel);
  more.addEventListener("click", () => openOptionsAt("#readaloud"));
  menu.appendChild(more);
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const first = menu.querySelector(".pmenu-item.on") || menu.querySelector(".pmenu-item");
  if (first) first.focus();
}

// Both keys in one write, the way this control has always done it: a voice
// belongs to a family, so choosing one chooses the family too.
function onPickVoice(v) {
  const p = ttsPick.current;
  closeVoiceMenu();
  const btn = $("ttsVoiceBtn");
  if (btn) { try { btn.focus(); } catch (_e) { /* ignore */ } }
  if (!p || !v) return;
  state.ttsProvider = p.id;
  state.ttsVoice = v;
  ttsPick.voice = v;
  chrome.storage.sync.set({ ttsProvider: p.id, ttsVoice: v });
  recentsPush(RECENT_VOICES, p.id, v);
  paintTtsCard();
  refreshTtsStatus();
}

// Switching family: the voice has to come with it, because a voice name means
// nothing to another provider. The one this family was last heard with comes
// back (that is what the recent list is for); failing that, its own default.
function onPickTtsProvider() {
  const sel = $("ttsProviderPick");
  const p = self.YTDS_PROVIDERS && self.YTDS_PROVIDERS.tts.get(sel && sel.value);
  if (!p || (ttsPick.current && p.id === ttsPick.current.id)) return;
  closeVoiceMenu();
  const last = ttsPick.recents.find((r) => r.p === p.id && ttsVoiceUsableHere(p, r.id));
  const voice = (last && last.id) || voiceInUse(p, "");
  state.ttsProvider = p.id;
  state.ttsVoice = voice;
  chrome.storage.sync.set({ ttsProvider: p.id, ttsVoice: voice });
  if (voice) recentsPush(RECENT_VOICES, p.id, voice);
  paintTtsCard();
  refreshTtsStatus();
}

let modelMsgTimer = 0;

function showModelMsg(text) {
  const el = $("byoModelMsg");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  clearTimeout(modelMsgTimer);
  if (text) {
    modelMsgTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = "";
    }, 2600);
  }
}

// Opening the settings page is a module-level job: the model menu's last row
// leads there too, and that row is built long after the init closure has run.
// openOptionsPage() cannot carry a hash, so a request for one section opens the
// page by URL instead.
function openOptionsAt(hash) {
  try {
    if (typeof hash === "string" && hash) {
      chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + hash });
    } else {
      chrome.runtime.openOptionsPage();
    }
  } catch (_e) { /* ignore */ }
  window.close();          // hand over to the tab instead of stacking UI
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
    ? t("exportByoNote", "整片字幕会交给你的服务商、用你的 Key 翻译，消耗额度；点导出后会先给出预估。")
    : t("exportUsesYouTube", "导出用的是 YouTube 自带的整轨翻译——免费，不消耗你的 API。");
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
// Same contract as hideConfirm: dismissed = the reader backed out, so focus
// returns to the button that opened it.
function hideResetConfirm(dismissed) {
  const panel = $("resetConfirm");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  if (!dismissed) return;
  const btn = $("reset");
  if (btn) { try { btn.focus(); } catch (_e) { /* ignore */ } }
}

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
    : t("exportSrt", "下载 SRT");
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
    // Rate-limit waits get a live countdown — a frozen "generating…" over a
    // 2-minute gate reads as a hang (reported from the real machine). The seconds come from the
    // run's own waitUntil (whole-track gate) or the BYO lane's session gate.
    const waitUntil = Number(s.waitUntil) || 0;
    if (waitUntil > Date.now()) {
      const secs = Math.max(1, Math.ceil((waitUntil - Date.now()) / 1000));
      showExportMsg(tsub("exportWaiting", [String(secs)],
        "翻译接口正在限流，约 " + secs + " 秒后继续"), "warn");
      return;
    }
    if (s.total > 0) {
      showExportMsg(tsub("exportProgress", [String(s.done), String(s.total)],
        "翻译中… " + s.done + "/" + s.total), null);
    }
  }, 700);
}

function exportErrText(resp) {
  if (resp.reason === "cancelled") return t("exportCancelled", "已取消导出。");
  if (resp.reason === "byofail") return byoErrText(resp.code || "failed", activeProvider());
  if (resp.reason === "same") return t("backendStatusSame", "本视频字幕已是译文语言，无需翻译。");
  if (resp.reason === "limited") {
    return t("exportLimited",
      "YouTube 暂时限制了整轨翻译，过一会儿再试。配好自己的 Key 之后，导出卡片上会多一个勾选，可以绕开它。");
  }
  if (resp.reason === "notrans") {
    return t("exportNoTrans", "这个视频拿不到译文，试试「整轨翻译」或换个译文语言。");
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
    // Both paths poll now: the whole-track path can sit inside a rate-limit
    // wait, and a wait without a countdown or a stop button reads as a hang.
    startPoll(tabId);
    setExportBusy(true, true);
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
  hideResetConfirm(false);                         // one question at a time (the reset panel closes ours)
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
    // Through the shortKey like every other place a short name is shown: the
    // bare `p.short` put 「百炼」 into nineteen locales' confirm sentence.
    const name = (p && ((p.shortKey && t(p.shortKey, p.short)) || p.short || p.name)) || "";
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
  $("selectText").checked = !!state.selectText;
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
  $("selectText").addEventListener("change", (e) => setKey("selectText", e.target.checked));
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
  // The opener itself lives at module level (openOptionsAt) because the model
  // menu's last row needs it too.
  const toOptions = openOptionsAt;
  // Bare handlers: a click event as the first argument must not be mistaken
  // for a hash.
  $("openOptions").addEventListener("click", () => toOptions());
  $("byoConfigure").addEventListener("click", () => toOptions());
  const pick = $("byoPick");
  if (pick) pick.addEventListener("change", onPickProvider);

  // ---- the model menu ----
  // The row is the entry (设计规范 §5-3: status is the door). One hit area,
  // one menu, and the settings page on its last row.
  const modelBtn = $("byoModelBtn");
  if (modelBtn) {
    modelBtn.addEventListener("click", () => {
      if (modelMenuIsOpen()) { closeModelMenu(); modelBtn.focus(); }
      else openModelMenu();
    });
  }
  // The voice menu is the same layer over a different row, so it gets the same
  // two rules: arrows walk it, Escape gives the button back its focus.
  const voiceBtn = $("ttsVoiceBtn");
  document.addEventListener("keydown", (e) => {
    if (!voiceMenuIsOpen()) return;
    if (e.key === "Escape") {
      closeVoiceMenu();
      if (voiceBtn) voiceBtn.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.prototype.slice.call(
      $("ttsVoiceMenu").querySelectorAll(".pmenu-item"));
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1)
      : (at + step + rows.length) % rows.length;
    rows[next].focus();
  });
  document.addEventListener("click", (e) => {
    if (!voiceMenuIsOpen()) return;
    const menu = $("ttsVoiceMenu");
    if (menu && menu.contains(e.target)) return;
    if (voiceBtn && voiceBtn.contains(e.target)) return;
    closeVoiceMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (!modelMenuIsOpen()) return;
    if (e.key === "Escape") {
      closeModelMenu();
      if (modelBtn) modelBtn.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.prototype.slice.call(
      $("byoModelMenu").querySelectorAll(".pmenu-item"));
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1)
      : (at + step + rows.length) % rows.length;
    rows[next].focus();
  });
  // Anywhere else closes it: this is a layer over one row, not a mode. The
  // click that opened it is excluded by the two contains() checks.
  document.addEventListener("click", (e) => {
    if (!modelMenuIsOpen()) return;
    const menu = $("byoModelMenu");
    if (menu && menu.contains(e.target)) return;
    if (modelBtn && modelBtn.contains(e.target)) return;
    closeModelMenu();
  });

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
  $("ttsProviderPick").addEventListener("change", onPickTtsProvider);
  $("ttsVoiceBtn").addEventListener("click", () => {
    if (voiceMenuIsOpen()) { closeVoiceMenu(); return; }
    openVoiceMenu();
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

  // A popup can be dismissed the moment a gesture ends, taking any pending
  // timer with it. `change` fires on release for range and colour inputs and
  // on the click itself for checkboxes — for all of them it IS the end of the
  // gesture, so flush there and the last value is written even if the
  // debounce never fires. Checkboxes were missing from this list: tick one,
  // close the popup inside 180ms, and the tick silently never happened.
  document.querySelectorAll(
    'input[type="range"], input[type="color"], input[type="checkbox"]').forEach((el) =>
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
    // Whichever panel holds the focus closes first; with neither focused, the
    // reset panel (the later one) goes first.
    const reset = $("resetConfirm"), panel = $("exportConfirm");
    const inExport = panel && !panel.hidden && panel.contains(document.activeElement);
    if (inExport) { e.preventDefault(); hideConfirm(true); return; }
    if (reset && !reset.hidden) { e.preventDefault(); hideResetConfirm(true); return; }
    if (!panel || panel.hidden) return;
    e.preventDefault();
    hideConfirm(true);
  });
  $("exportStop").addEventListener("click", onExportStop);

  // reset all — behind an inline confirm. A native confirm() closes the popup
  // (设计规范 §二; the export card's panel is the precedent), and the text says
  // what goes: every setting, the keys on this machine, and the per-provider
  // model/voice memory, which used to vanish without a word. Focus lands on
  // the SAFE button: Enter must not be the destructive path.
  $("reset").addEventListener("click", () => {
    hideConfirm(false);                              // the export panel, if open
    const panel = $("resetConfirm");
    if (!panel) return;
    panel.hidden = false;
    const back = $("resetBack");
    if (back) { try { back.focus(); } catch (_e) { /* ignore */ } }
  });
  $("resetBack").addEventListener("click", () => hideResetConfirm(true));
  $("resetGo").addEventListener("click", () => {
    hideResetConfirm(true);                          // focus back on the button, not on body
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
      // ytdsCompleteHintOff goes too: it is the "don't show again" on the
      // cut-tail hint, a preference and not a secret, and a reset that keeps
      // it leaves a door shut that the reset claims to reopen.
      chrome.storage.local.remove(["byoKeys", "ttsKeys", "byoOk", "ytdsCompleteHintOff",
        "byoCatalogs"]);                 // fetched model lists are a cache, not a setting
      // "Back to how it was when first installed" — so the first-run hints come
      // back too: the drag grip's and the corner arrow's budgets are re-seeded
      // exactly as background.js seeds them on install.
      chrome.storage.local.set({ handleHintsLeft: 3, menuHintsLeft: 3 });
      // ttsComplete and the two per-provider memories are written straight to
      // sync by other surfaces and are not in this file's DEFAULTS, so
      // set(DEFAULTS) above cannot reach them. They survived a reset that says
      // it resets everything: "finish every line" stayed on, and each provider
      // still remembered the model and voice last used with it.
      chrome.storage.sync.remove(["ttsProvider", "ttsVoice", "ttsRegion",
        "ttsComplete", "byoModelBy", "ttsModelBy", "byoSiteBy"]);
      paintByoPanel();               // the summary must stop claiming a key
      paintTtsCard();                // …and so must the read-aloud card
    } catch (_e) { /* ignore */ }
    bindUI();
    refreshEngineStatus();
    refreshTtsStatus();              // reset turned read-aloud off: hide its line
    paintTtsCard();                  // …and put the switch row back to unchecked
    // DEFAULTS carries zh-CN because a file has to carry something; the value
    // a fresh install actually gets is derived from the browser's languages.
    // Reset says "back to how it was when first installed", so it asks for
    // that same guess rather than leaving everyone on Chinese.
    try {
      chrome.runtime.sendMessage({ type: "guessTargetLang" }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) return;
        state.targetLang = resp.targetLang;
        bindUI();
      });
    } catch (_e) { /* ignore */ }
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
  initCompleteHint();
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
