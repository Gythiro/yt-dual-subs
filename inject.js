// inject.js — MAIN world, document_start.
// Hooks XMLHttpRequest + fetch to capture the YouTube player's OWN
// /api/timedtext request URL (which carries a valid "pot"), then reuses that
// exact URL to fetch json3 cues — and, optionally, a tlang-aligned translation.
//
// NEVER throw into the page: every hook body is wrapped in try/catch.
(() => {
  "use strict";

  // ---- guard against double injection -------------------------------------
  if (window.__ytdsInjected) return;
  window.__ytdsInjected = true;

  const TIMEDTEXT_MARK = "/api/timedtext";

  // Most recently seen timedtext URL of any kind.
  let lastTimedtextUrl = "";
  // The player's ORIGINAL-track fetch: a timedtext URL WITHOUT a "tlang" param.
  // This is the only URL whose "pot" we may reuse.
  let sourceUrl = "";
  // The videoId that sourceUrl was captured for. produceCues bails if this no
  // longer matches the current location video, so a stale (previous-video) URL
  // can never be fetched and posted under the new videoId.
  let sourceVid = "";
  // Identity of the captured source track, IGNORING fmt/tlang. Used so our own
  // json3 re-fetches (and pot rotations on the same track) are not mistaken for
  // a brand-new source — which would otherwise re-trigger produceCues in a loop.
  let sourceKey = "";

  let currentVideoId = videoIdFromLocation();

  // pending config from content.js (set once popup config arrives)
  let cfg = null;            // { targetLang, mode: "auto"|"tlang"|"gtx" }
  let nocuesTimer = null;    // fires if no timedtext URL shows up
  let producedForUrl = "";   // dedupe: last sourceUrl we produced cues for
  // Monotonic request token echoed back to content.js so it can drop any
  // 'cues'/'nocues' that does not correspond to its latest sendConfig().
  let reqNonce = 0;

  // ---- helpers -------------------------------------------------------------
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  // tlang code map: YouTube uses zh-Hans / zh-Hant for translation targets.
  function mapTlang(code) {
    if (code === "zh-CN") return "zh-Hans";
    if (code === "zh-TW") return "zh-Hant";
    return code;
  }

  function hasTlang(url) {
    try {
      return new URL(url, location.href).searchParams.has("tlang");
    } catch (_e) {
      return /[?&]tlang=/.test(url);
    }
  }

  function isTimedtext(url) {
    return typeof url === "string" && url.indexOf(TIMEDTEXT_MARK) !== -1;
  }

  // Track identity ignoring the params that rotate or that WE vary. "pot" (the
  // proof-of-origin token) is rotated by the player periodically for the SAME
  // track — if we kept it in the key, each rotation would look like a brand-new
  // source and re-trigger produceCues, causing the overlay to flicker. So strip
  // pot/fmt/tlang; what remains (v, lang, kind, ...) is the stable track id.
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("fmt");
      u.searchParams.delete("tlang");
      u.searchParams.delete("pot");
      return u.toString();
    } catch (_e) {
      return url;
    }
  }

  // Track kind of a captured timedtext URL: auto-generated (ASR) tracks carry
  // kind=asr; human tracks have no kind param. Drives the "auto" engine choice.
  function trackKindOf(url) {
    try {
      return new URL(url, location.href).searchParams.get("kind") === "asr"
        ? "asr" : "manual";
    } catch (_e) {
      return "manual";
    }
  }

  // Parse the "v" param off a captured timedtext URL when present; otherwise
  // fall back to the current location video id.
  function vidOfUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.searchParams.get("v") || videoIdFromLocation();
    } catch (_e) {
      return videoIdFromLocation();
    }
  }

  // Build a fetch URL from the captured source URL: preserve every param
  // (including pot + signature), force fmt=json3, drop any stray tlang.
  function buildUrl(base, tlangTarget) {
    const u = new URL(base, location.href);
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    if (tlangTarget) u.searchParams.set("tlang", tlangTarget);
    return u.toString();
  }

  // Parse json3 into cue objects. Robust against missing/empty segs.
  // Preserves json3 EVENT ORDER (do not sort here): the orig and tlang
  // responses are aligned cue-for-cue by event order, so the i-th surviving
  // event of the orig response corresponds to the i-th of the tlang response.
  function parseJson3(json) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (const ev of json.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      let text = "";
      let off = 0;
      for (const s of ev.segs) {
        if (s && typeof s.utf8 === "string") {
          text += s.utf8;
          // Track the last NON-BLANK word's offset. ASR tracks carry per-word
          // tOffsetMs; blank segs ("\n") may carry one too and would inflate it.
          if (s.utf8.trim() && typeof s.tOffsetMs === "number") off = s.tOffsetMs;
        }
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;          // skip style/window/blank events
      const start = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
      const dur = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
      // lastOff = absolute time of the event's last word. Manual tracks have no
      // per-word segs, so lastOff === start — sentence grouping in content.js
      // reads the pause as (next.start - lastOff), which for manual tracks is
      // roughly the cue duration and therefore almost always a sentence break.
      cues.push({ start, dur, text, lastOff: start + off });
    }
    return cues;
  }

  // page-context fetch — same-origin youtube.com so pot/signature stay valid.
  async function fetchJson3(url) {
    const res = await fetch(url, { method: "GET", credentials: "include" });
    if (!res.ok) throw new Error("timedtext http " + res.status);
    const txt = await res.text();
    if (!txt) throw new Error("timedtext empty body");
    return JSON.parse(txt);
  }

  // ---- bridge to content.js ------------------------------------------------
  function post(type, extra) {
    try {
      window.postMessage(Object.assign(
        { source: "ytds-inject", type, videoId: currentVideoId, nonce: reqNonce },
        extra || {}
      ), "*");
    } catch (_e) { /* never throw */ }
  }

  function clearNocuesTimer() {
    if (nocuesTimer) { clearTimeout(nocuesTimer); nocuesTimer = null; }
  }

  // Produce cues (+ optional aligned translation) from the captured source URL.
  async function produceCues(force) {
    if (!cfg || !sourceUrl) return;
    // The captured source URL must belong to the CURRENT video. Without this,
    // a config round-trip on SPA nav could refetch the previous video's URL and
    // post it stamped with the new videoId.
    if (sourceVid !== currentVideoId) return;
    if (!force && producedForUrl === sourceUrl) return;
    producedForUrl = sourceUrl;
    clearNocuesTimer();

    const vid = currentVideoId;
    // Capture the nonce NOW, at produce start. post() must stamp the reply with
    // THIS nonce, not the live global reqNonce at send-time: otherwise two
    // produces running concurrently (e.g. boot + yt-navigate-finish both send
    // config) would both be stamped with the latest nonce and both accepted by
    // content.js -> double cue-loop restart -> startup flicker.
    const myNonce = reqNonce;
    // Which engine wants the tlang track? Everything except explicit "gtx".
    // Measured across videos (2026-07): YouTube's whole-track translation is
    // usually solid even on ASR, so "auto" stays on it and the sentence-group
    // gtx path serves as the (much better than per-cue) fallback when a track
    // isn't translatable — plus as the user's manual choice.
    const kind = trackKindOf(sourceUrl);
    const wantTlang = cfg.mode !== "gtx";
    try {
      const origJson = await fetchJson3(buildUrl(sourceUrl, null));
      const cues = parseJson3(origJson);

      let tcues = null;
      if (wantTlang) {
        try {
          const target = mapTlang(cfg.targetLang);
          const transJson = await fetchJson3(buildUrl(sourceUrl, target));
          tcues = parseJson3(transJson);
        } catch (_e) {
          tcues = null;             // translation failed; orig still usable
        }
      }

      // ignore if we navigated away mid-fetch (or the source no longer matches)
      if (vid !== currentVideoId || sourceVid !== currentVideoId) return;

      if (!cues.length) {
        producedForUrl = "";        // allow a retry if the track later yields cues
        post("nocues", { nonce: myNonce });
        return;
      }

      // Pair orig+tlang by EVENT ORDER while alignment is known, BEFORE any
      // sorting downstream. content.js then sorts the single cue array and
      // reads cue.trans, so re-sorting can never desync the translation.
      const aligned = tcues ? (cues.length === tcues.length) : null;
      if (tcues && aligned) {
        for (let i = 0; i < cues.length; i++) {
          cues[i].trans = tcues[i] ? tcues[i].text : "";
        }
      }

      post("cues", { cues, tcues, aligned, trackKind: kind, nonce: myNonce });
    } catch (_e) {
      // could not fetch/parse — let content.js fall back to scraping, but only
      // if we are still on the same video the fetch was started for.
      if (vid !== currentVideoId || sourceVid !== currentVideoId) return;
      producedForUrl = "";          // allow a retry on next capture
      post("nocues", { nonce: myNonce });
    }
  }

  // Produce a COMPLETE bilingual cue set for SRT export, on demand. Unlike
  // produceCues (which drives the live overlay and honours the user's backend
  // choice), this ALWAYS fetches the whole-track tlang translation by reusing
  // the captured pot-bearing source URL — so a full translation is available for
  // download even when the live overlay is running in gtx (per-sentence) mode.
  // Orig+tlang are paired by EVENT ORDER here, before content.js sorts, so the
  // translation can never desync from the original. Posts an "exportdata" reply
  // correlated by exportId; never throws into the page.
  async function produceExport(targetLang, exportId) {
    if (!sourceUrl || sourceVid !== currentVideoId) {
      post("exportdata", { ok: false, exportId });
      return;
    }
    try {
      const origJson = await fetchJson3(buildUrl(sourceUrl, null));
      const cues = parseJson3(origJson);
      if (!cues.length) { post("exportdata", { ok: false, exportId }); return; }

      let tcues = null;
      let aligned = null;
      if (targetLang) {
        try {
          const transJson = await fetchJson3(buildUrl(sourceUrl, mapTlang(targetLang)));
          tcues = parseJson3(transJson);
          aligned = cues.length === tcues.length;
          if (aligned) {
            for (let i = 0; i < cues.length; i++) {
              cues[i].trans = tcues[i] ? tcues[i].text : "";
            }
          }
        } catch (_e) {
          tcues = null; aligned = null;   // translation failed; orig still usable
        }
      }

      post("exportdata", { ok: true, cues, tcues, aligned, exportId });
    } catch (_e) {
      post("exportdata", { ok: false, exportId });
    }
  }

  // Called whenever we capture a fresh source URL.
  function onSourceCaptured() {
    if (!cfg) return;               // wait for config before fetching
    produceCues(false);
  }

  // Record a timedtext URL seen on the wire.
  function noteTimedtext(url) {
    try {
      if (!isTimedtext(url)) return;
      lastTimedtextUrl = url;
      if (!hasTlang(url)) {
        // The player's original-track fetch — the only pot we may reuse.
        // Always keep the freshest exact URL (pot can rotate), but only treat
        // it as a NEW source (and re-produce) when the track identity changes.
        const key = normKey(url);
        sourceUrl = url;
        sourceVid = vidOfUrl(url);
        if (key !== sourceKey) {
          sourceKey = key;
          onSourceCaptured();
        }
      }
    } catch (_e) { /* never throw */ }
  }

  // ---- video-change reset --------------------------------------------------
  // Returns true if a change was detected and state was reset.
  function checkVideoChange() {
    try {
      const v = videoIdFromLocation();
      if (v && v !== currentVideoId) {
        currentVideoId = v;
        lastTimedtextUrl = "";
        sourceUrl = "";
        sourceVid = "";
        sourceKey = "";
        producedForUrl = "";
        clearNocuesTimer();
        return true;
      }
    } catch (_e) { /* never throw */ }
    return false;
  }
  setInterval(checkVideoChange, 500);

  // ---- nocues watchdog -----------------------------------------------------
  function armNocuesTimer() {
    clearNocuesTimer();
    const vid = currentVideoId;
    const nonceAtArm = reqNonce;
    nocuesTimer = setTimeout(() => {
      nocuesTimer = null;
      if (vid !== currentVideoId) return;
      if (nonceAtArm !== reqNonce) return;
      if (!sourceUrl) post("nocues");      // never saw the player fetch captions
    }, 6000);
  }

  // ---- receive config from content.js --------------------------------------
  window.addEventListener("message", (evt) => {
    try {
      if (evt.source !== window) return;
      const d = evt.data;
      if (!d || d.source !== "ytds-content") return;

      if (d.type === "config") {
        // Treat the config message as the authoritative nav signal: reset any
        // stale capture synchronously if the location video changed, rather
        // than waiting up to 500ms for the poll. This closes the cross-video
        // contamination window — produceCues will only run for a sourceUrl
        // captured for the now-current video.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        cfg = {
          targetLang: d.targetLang,
          // "auto" | "tlang" | "gtx" — anything unrecognized lands on auto.
          mode: (d.mode === "tlang" || d.mode === "gtx") ? d.mode : "auto"
        };
        // Adopt the content-supplied nonce so our posts correlate to THIS
        // sendConfig(); content.js drops any reply with an older nonce.
        if (typeof d.nonce === "number") reqNonce = d.nonce;
        producedForUrl = "";            // force re-produce under new config
        if (sourceUrl && sourceVid === currentVideoId) {
          produceCues(true);            // already captured for this video
        } else {
          armNocuesTimer();             // wait for player's timedtext fetch
        }
      } else if (d.type === "export-request") {
        // On-demand SRT export: build a COMPLETE bilingual cue set regardless of
        // the live backend mode (see produceExport). Correlated by exportId.
        // Sync video state first so a just-navigated tab can't export the
        // previous video's captured URL.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        produceExport(d.targetLang, d.exportId);
      }
    } catch (_e) { /* never throw */ }
  }, false);

  // ---- hook XMLHttpRequest --------------------------------------------------
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function (method, url) {
      try { this.__ytdsUrl = url; } catch (_e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.send = function () {
      try { noteTimedtext(this.__ytdsUrl); } catch (_e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (_e) { /* never throw */ }

  // ---- hook fetch -----------------------------------------------------------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          let url = "";
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url;
          noteTimedtext(url);
        } catch (_e) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
    }
  } catch (_e) { /* never throw */ }

  // ---- robust capture via Resource Timing ----------------------------------
  // Hook-independent fallback: the player's /api/timedtext request shows up in
  // Resource Timing with its FULL url (incl. pot) regardless of whether it used
  // XHR or fetch — and even if another extension (e.g. an older dual-subtitles
  // build) has locked XMLHttpRequest.prototype.open so our XHR hook never
  // installs. This is the mechanism the rewrite was validated against.
  try {
    const scan = (entries) => {
      for (const e of entries) {
        if (e && typeof e.name === "string" && isTimedtext(e.name)) {
          noteTimedtext(e.name);
        }
      }
    };
    try { scan(performance.getEntriesByType("resource")); } catch (_e) { /* ignore */ }
    if (typeof PerformanceObserver === "function") {
      const po = new PerformanceObserver((list) => {
        try { scan(list.getEntries()); } catch (_e) { /* ignore */ }
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (_e) { /* never throw */ }
})();
