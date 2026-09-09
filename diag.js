// diag.js — the "copy diagnostic info" bundle, shared by the popup and the
// settings page.
//
// It used to live in options.js with a second, older copy in popup.js — the
// popup's button only appears when the status line shows a warning, which is
// exactly when someone presses it, and that copy still printed the format
// D125 had replaced. One builder, two buttons.
//
// Everything here is written for whoever reads a bug report, in English by
// design; nothing in it is painted into the UI. Keys are never printed, a
// custom endpoint is reduced to its origin, a video to its id.
(() => {
  "use strict";

  // ---- diagnostics (the permanent entry; the popup has a warning-only twin) ----
  // This page is not the YouTube tab, so it cannot ask "the active tab" what it
  // is rendering. It asks EVERY tab instead: only tabs carrying our content
  // script answer, which is exactly the set we want. No new permission — the
  // reply comes from a script we already inject, and tabs.query without the
  // "tabs" permission still returns ids. Several YouTube tabs open is not a
  // problem to disambiguate but a thing to report: all of them go in the bundle.
  function askYouTubeTabs() {
    return new Promise((resolve) => {
      let done = false;
      // Declared here, above the timer, on purpose: the timeout used to hand over
      // an empty list because this was scoped inside the query callback and there
      // was nothing else it could name. Every tab in every window is asked, and
      // one that is mid-load — or that Chrome has frozen in the background —
      // simply never calls back, so a single quiet tab threw away every answer
      // that had arrived and the bundle reported "no YouTube tab open". That
      // bundle is the only source of truth support gets.
      const out = [];
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      // A copy: replies still in flight keep pushing after the deadline, and the
      // caller should not be handed an array that grows under it.
      setTimeout(() => finish(out.slice()), 800);
      try {
        chrome.tabs.query({}, (tabs) => {
          const ids = (tabs || []).map((t) => t.id).filter((id) => id != null);
          if (!ids.length) return finish([]);
          let left = ids.length;
          for (const id of ids) {
            try {
              chrome.tabs.sendMessage(id, { type: "engineStatus" }, (r) => {
                void chrome.runtime.lastError;   // most tabs have no listener
                if (r && r.ok) out.push(r);
                if (--left === 0) finish(out);
              });
            } catch (_e) {
              if (--left === 0) finish(out);
            }
          }
        });
      } catch (_e) { finish([]); }
    });
  }

  // A YouTube URL reduced to the part a bug report can use. Anything that is not
  // recognisably a YouTube video address is dropped rather than guessed at.
  function diagPageRef(href) {
    if (!href) return "youtube (id unknown)";
    let u;
    try { u = new URL(String(href)); } catch (_e) { return "youtube (unreadable address)"; }
    const shorts = /^\/shorts\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
    const id = shorts ? shorts[1] : u.searchParams.get("v");
    if (id) return (shorts ? "shorts " : "watch ") + id;
    return "youtube" + (u.pathname && u.pathname !== "/" ? " " + u.pathname : "");
  }

  // An address is diagnostic ("is it localhost:11434 or something else?"), a path
  // is not, and a query string can carry a token. Origin only, never more.
  function diagOrigin(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    // "localhost:11434" parses — protocol "localhost:", origin "null" — and the
    // bundle printed the word null for anyone who left off the scheme.
    try {
      const u = new URL(raw);
      return /^https?:$/.test(u.protocol) ? u.origin : "(unreadable)";
    } catch (_e) { return "(unreadable)"; }
  }

  async function build(state) {
    const L = [];
    let ver = "";
    try { ver = chrome.runtime.getManifest().version; } catch (_e) { /* ignore */ }
    L.push("Dual Subtitles for YouTube — diagnostic");
    L.push("version: " + (ver || "?"));
    L.push("browser: " + navigator.userAgent);
    let ui = "";
    try { ui = (chrome.i18n && chrome.i18n.getUILanguage()) || ""; } catch (_e) { /* ignore */ }
    // Read the settings this page does not keep in `state`. state holds what the
    // options UI edits; a bug report needs what the extension is actually set to,
    // which is a different and larger set — and two lines below used to guess at
    // it from `state` and get it wrong (see the read-aloud note).
    const CFG_DEFAULTS = {
      uiLocale: "auto", enabled: true, engine: "auto", ttsEnabled: false,
      ttsComplete: false, ttsVolume: 100, ttsDuckPct: 25, ttsCruise: true,
      byoBaseUrl: "", ttsBaseUrl: "", ttsRegion: ""
    };
    let cfg = Object.assign({}, CFG_DEFAULTS);
    try {
      const got = await new Promise((res) => chrome.storage.sync.get(CFG_DEFAULTS, res));
      cfg = Object.assign({}, CFG_DEFAULTS, got || {});   // a failed read prints defaults, not "undefined"
    } catch (_e) { /* keep the defaults */ }
    const uiLocale = cfg.uiLocale || "auto";
    L.push("ui-language: " + (ui || "?") +
      (uiLocale && uiLocale !== "auto" ? " (override: " + uiLocale + ")" : ""));
    // "It does nothing" starts here: the overlay has a master switch, and a
    // bundle that never mentions it cannot rule the switch out.
    L.push("subtitles: " + (cfg.enabled ? "on" : "OFF"));
    L.push("target-language: " + (state.targetLang || "?"));
    // The engine setting itself, for everyone — not just own-key users. This line
    // used to read "see popup" for the whole free-engine majority, which is the
    // one thing a bundle must never say: it exists so nobody has to go and look.
    // The provider rides on this line only when the engine IS byo. Anyone who
    // has saved a key but still runs auto (the common case: the settings page
    // never writes `engine`) used to read "auto — qwen / qwen-flash", and
    // support went looking at qwen's quota while YouTube's own translation was
    // doing the work.
    const prov = state.byoProvider
      ? state.byoProvider + (state.byoModel ? " / " + state.byoModel : "") : "";
    L.push("engine-setting: " + (cfg.engine || "?") +
      (cfg.engine === "byo" && prov ? " — " + prov : ""));
    if (cfg.engine !== "byo" && prov) L.push("byo-configured: " + prov + " (not in use)");
    // ttsProvider defaults to "local-speech" and is never emptied, so the old
    // `state.ttsProvider || "off"` could not print "off" even once: a user who
    // had never touched read-aloud was reported as running it on the browser's
    // voices, and support would chase a feature that was not on.
    if (!cfg.ttsEnabled) {
      L.push("read-aloud: off");
    } else {
      L.push("read-aloud: on — " + (state.ttsProvider || "?") +
        (state.ttsVoice ? " / " + state.ttsVoice : "") +
        (cfg.ttsRegion ? " / " + cfg.ttsRegion : "") +
        ", finish-every-line " + (cfg.ttsComplete ? "on" : "off") +
        ", cruise " + (cfg.ttsCruise ? "on" : "off") +
        ", volume " + cfg.ttsVolume + " duck " + cfg.ttsDuckPct + "%");
    }
    const bases = [];
    if (cfg.byoBaseUrl) bases.push("translation " + diagOrigin(cfg.byoBaseUrl));
    if (cfg.ttsBaseUrl) bases.push("speech " + diagOrigin(cfg.ttsBaseUrl));
    if (bases.length) L.push("custom-endpoint: " + bases.join(", "));
    // Which providers have a key SAVED — names only, never a key or any part of
    // one. "Translation stopped working" and "no key was ever saved" look the
    // same from outside, and this is the line that tells them apart.
    try {
      const got = await new Promise((res) =>
        chrome.storage.local.get({ byoKeys: {}, ttsKeys: {} }, res)) || {};
      const t = Object.keys(got.byoKeys || {}).sort();
      const s = Object.keys(got.ttsKeys || {}).sort();
      L.push("keys-saved: " + (t.length ? t.join(", ") : "none") + " (translation)" +
        " / " + (s.length ? s.join(", ") : "none") + " (speech)");
    } catch (_e) { L.push("keys-saved: unavailable"); }
    // A saved key and a granted domain are two different steps, and Chrome's
    // grant prompt is dismissable. "I entered my key and nothing happens" is
    // usually this, and nothing in the bundle could tell it apart from a key
    // that was never saved at all.
    try {
      if (chrome.permissions && chrome.permissions.getAll) {
        const perms = await new Promise((res) => chrome.permissions.getAll(res));
        const hosts = ((perms && perms.origins) || [])
          .map((o) => o.replace(/^\*:\/\//, "").replace(/\/\*$/, ""))
          .filter((h) => h.indexOf("youtube.com") < 0 && h.indexOf("translate.googleapis") < 0);
        // The two every install has (youtube.com, translate.googleapis.com) are
      // filtered out above so the list is only what the user granted.
      L.push("granted-hosts: " + (hosts.length ? hosts.join(", ") : "none optional granted"));
      }
    } catch (_e) { /* older browser or no permissions API: say nothing */ }
    // Two commands ship with no default key (D95), so "the shortcut does nothing"
    // is most often "nothing is bound". Chrome answers that; we could not.
    try {
      if (chrome.commands && chrome.commands.getAll) {
        const cmds = await new Promise((res) => chrome.commands.getAll(res));
        const bound = (cmds || []).filter((c) => c && c.shortcut)
          .map((c) => c.name + "=" + c.shortcut);
        L.push("shortcuts: " + (bound.length ? bound.join(", ") : "none bound"));
      }
    } catch (_e) { /* ignore */ }
    // A machine with no speech voices installed reports the same "it says
    // nothing" as a misconfigured provider (A14 shipped a usability predicate
    // for exactly this), and only the count tells them apart.
    try {
      if (typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices) {
        const vs = speechSynthesis.getVoices() || [];
        const lang = String(state.targetLang || "").toLowerCase().split("-")[0];
        const forTarget = lang
          ? vs.filter((v) => String(v.lang || "").toLowerCase().indexOf(lang) === 0).length
          : 0;
        // Cold, the synchronous getVoices() is an empty list that fills a moment
        // later (the read-aloud pane has a retry loop for exactly this); "0
        // installed" here sent support down the no-voices road (A14) for a page
        // that had simply been opened a second ago.
        L.push(vs.length
          ? "browser-voices: " + vs.length + " installed" +
            (lang ? ", " + forTarget + " for " + state.targetLang : "")
          : "browser-voices: not loaded yet at the moment of copying (retry in a few seconds)");
      }
    } catch (_e) { /* ignore */ }
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
        // How long ago matters as much as what: a 401 from two hours back and a
        // 401 from ten seconds back are different reports, and the timestamp was
        // being stored and then dropped.
        if (st && st.code) {
          const age = st.ts ? Math.max(0, Math.round((Date.now() - st.ts) / 1000)) : null;
          L.push("byo-last-error: " + st.code + " (" + (st.provider || "?") + ")" +
            (age == null ? "" : age < 90 ? ", " + age + "s ago"
              : ", " + Math.round(age / 60) + "min ago"));
        }
      }
    } catch (_e) { L.push("gates: unavailable"); }
    let pages = [];
  try { pages = await askYouTubeTabs(); } catch (_e) { pages = []; }
    if (!pages.length) {
      // Nobody answered. That is two situations, and the bundle used to report
      // both as "no YouTube tab open": on the real machine, straight after a
      // reload, a watch page WAS open — its content script predated the
      // update and had gone quiet, as orphans are built to. They cannot be
      // told apart from here: without the "tabs" permission (deliberately not
      // asked for) tabs.query hands back no URLs, and its url filter answers
      // zero even with youtube.com among the granted hosts (measured
      // 2026-09-02). So say both, and the one thing that fixes the second.
      L.push("page: no YouTube tab answered — if one is open, refresh it");
    } else {
      pages.forEach((r, i) => {
        const n = pages.length > 1 ? " #" + (i + 1) : "";
        // The video, not the visit. A full watch URL carries the timestamp the
        // reader was at, the playlist they came through, and whatever tracking
        // parameters the link they followed had on it — and the hint under this
        // button tells people to paste the result into an email or an issue,
        // where issues are public. The id is what a report needs to reproduce
        // anything; the rest is a record of somebody's afternoon.
        L.push("page" + n + ": " + diagPageRef(r.href));
        // engineStatus already carries all of this; the bundle used to keep four
        // fields of it and drop the rest on the floor — including every number
        // the read-aloud investigations of 2026-08/09 were actually conducted on
        // (the playback rate, the cut count, why lines were skipped) and both
        // "why is it behaving like this" flags (rate-limited, recovering).
        L.push("video-engine" + n + ": " + (r.engine || "none yet") +
          (r.provider ? " (" + r.provider + ")" : "") +
          (r.same ? ", same-language" : "") +
          (r.track && r.track !== "none" ? ", track=" + r.track : "") +
          (r.fellBack ? ", fell-back" : "") +
          (r.tlangLimited ? ", whole-track rate-limited" : "") +
          (r.trackWait ? ", no caption track — retrying" : ""));
        const s = r.tts;
        if (s) {
          // Speed first: it is the single number every read-aloud report turns
          // on, and the one thing the user is least likely to think to mention.
          // uRate is 0 until inject has reported the rate once; "1x" would be a
          // guess dressed as a reading.
          L.push("read-aloud-run" + n + ": speed " + (s.uRate ? s.uRate + "x" : "?") +
            ", spoken " + s.spoken + ", skipped " + s.skipped +
            (s.skipWhy ? " (" + s.skipWhy + ")" : "") +
            ", cut-short " + (s.over || 0) +
            (s.jumps ? ", jump-cuts " + s.jumps : "") +
            ", asked " + (s.asked || 0) +
            ", debt " + (s.debt || 0) + "ms" +
            (s.cru ? ", cruising" : "") +
            (s.speaking ? ", speaking now" : "") +
            (s.err ? ", err=" + s.err : ""));
          // The last few takeovers, in the trace's own shorthand: which cue was
          // cut, by how much, and how long the arm was willing to wait. Reading
          // these off a live tab is what every one of those investigations did.
          // Three cut shapes come down the trace. "take" carries the index of the
          // line that TOOK OVER (content.js says so: the cut line's own index is
          // gone by claim time), "lcancel" the index of the line that was
          // stopped, and "jump" — a seek — carries neither an index nor a
          // duration, and used to print "cue undefined lost undefinedms".
          const cuts = (s.trace || []).filter((e) => e && e.k === "cut" &&
            (e.by === "take" || e.by === "lcancel")).slice(-5);
          for (const c of cuts) {
            L.push(c.by === "take"
              ? "  cut" + n + ": cue " + c.i + " took over, previous line lost " + c.cutMs + "ms" +
                (c.wanted != null ? " (wanted " + c.wanted + "ms, waited " + c.waited + "ms)" : "")
              : "  cut" + n + ": cue " + c.i + " stopped early, lost " + c.cutMs + "ms");
          }
        }
      });
    }
    L.push("time: " + new Date().toISOString());
    return L.join("\n");
  }
  self.YTDS_DIAG = { build, askYouTubeTabs, diagPageRef, diagOrigin };
})();
