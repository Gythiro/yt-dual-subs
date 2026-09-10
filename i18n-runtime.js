// i18n-runtime.js — one lookup for every string the popup and the options page
// show, honouring the user's interface-language override.
//
// chrome.i18n picks the locale from the browser's UI language and offers no way
// to override it at runtime. That is right for most people and wrong for an
// important minority — the measured user base is largely Chinese-reading people
// on English-UI browsers. So: `uiLocale` in chrome.storage.sync ("auto" or a
// _locales id). On "auto" every lookup is plain chrome.i18n.getMessage. On a
// concrete locale the packed _locales/<id>/messages.json is fetched once (an
// extension page may fetch its own packaged files; no extra permission) and
// lookups resolve there first, chrome.i18n second — so a key missing from a
// stale table still renders instead of going blank.
//
// The content script is NOT routed through this: it shows four short strings
// (drag-handle tips, toggle title, the auto-dub toast) and follows the browser
// locale under an override. Known, accepted, recorded in the design spec —
// wiring it through the background was not worth the orphan-lifecycle surface.
(() => {
  "use strict";

  // Native names, so someone stranded in the wrong language can still find
  // their own. Order is display order: the shipped three, then A→Z by code.
  const SELF_NAMES = {
    en: "English",
    zh_CN: "中文（简体）",
    zh_TW: "中文（繁體）",
    cs: "Čeština",
    de: "Deutsch",
    es: "Español",
    et: "Eesti",
    fi: "Suomi",
    fr: "Français",
    it: "Italiano",
    ja: "日本語",
    ko: "한국어",
    pl: "Polski",
    pt_BR: "Português (Brasil)",
    pt_PT: "Português (Portugal)",
    ro: "Română",
    ru: "Русский",
    th: "ไทย",
    tr: "Türkçe",
    vi: "Tiếng Việt",
    // Added with the twenty-four that came in 2026-09-11. A language is only
    // pickable if it is named here, so a locale folder without a line in this
    // table ships strings nobody can reach: the picker went on offering the
    // original twenty while forty-four were installed.
    bg: "Български",
    bn: "বাংলা",
    ca: "Català",
    da: "Dansk",
    el: "Ελληνικά",
    fil: "Filipino",
    hi: "हिन्दी",
    hr: "Hrvatski",
    hu: "Magyar",
    id: "Bahasa Indonesia",
    lt: "Lietuvių",
    lv: "Latviešu",
    mr: "मराठी",
    ms: "Bahasa Melayu",
    nl: "Nederlands",
    no: "Norsk",
    sk: "Slovenčina",
    sl: "Slovenščina",
    sr: "Српски",
    sv: "Svenska",
    sw: "Kiswahili",
    ta: "தமிழ்",
    te: "తెలుగు",
    uk: "Українська",
  };

  let manual = "";      // "" = auto (chrome.i18n decides)
  let table = null;     // parsed messages.json when manual

  function subst(entry, subs) {
    let msg = entry.message;
    const ph = entry.placeholders || {};
    for (const name of Object.keys(ph)) {
      const idx = parseInt(String(ph[name].content || "").slice(1), 10);
      const val = subs && subs[idx - 1] != null ? String(subs[idx - 1]) : "";
      msg = msg.replace(new RegExp("\\$" + name + "\\$", "gi"), val);
    }
    return msg;
  }

  function get(key, subs) {
    if (table && table[key]) return subst(table[key], subs);
    try {
      const m = chrome.i18n && chrome.i18n.getMessage(key, subs);
      if (m) return m;
    } catch (_e) { /* ignore */ }
    return "";
  }

  // For document.lang and the site's ?lang= parameter.
  function effectiveLang() {
    if (manual) return manual.replace("_", "-");
    try { return (chrome.i18n && chrome.i18n.getUILanguage()) || "en"; }
    catch (_e) { return "en"; }
  }

  function init() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        chrome.storage.sync.get({ uiLocale: "auto" }, (got) => {
          const loc = got && got.uiLocale;
          if (!loc || loc === "auto" || !SELF_NAMES[loc]) return done();
          fetch(chrome.runtime.getURL("_locales/" + loc + "/messages.json"))
            .then((r) => r.json())
            .then((j) => { table = j; manual = loc; done(); })
            .catch(done);           // unreadable table = behave like auto
        });
      } catch (_e) { done(); }
    });
  }

  self.YTDS_I18N = { init, get, effectiveLang, SELF_NAMES };
})();
