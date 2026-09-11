// skins.js — which look the extension's own two pages wear.
//
// Loaded FIRST in the <head> of popup.html and options.html, before the
// stylesheets have anything to paint. It does three things, in this order:
//
//   1. Reads the last-known choice from localStorage — synchronously, which is
//      the whole reason this file exists. chrome.storage is async, and a popup
//      that paints in one skin and switches to another 80ms later flashes on
//      every single open. localStorage is the cache; it is never the truth.
//   2. Reconciles against chrome.storage.sync, which IS the truth, and writes
//      the cache back. A first open on a second machine flashes once and then
//      never again.
//   3. Follows later changes, so the settings page and an open popup agree
//      without either being reloaded.
//
// Adding a skin later is two lines: an entry in SKINS below, and a block in
// skins.css under `html[data-skin="<id>"]`. Nothing else in the codebase knows
// a skin exists — the pages carry one attribute and the CSS does the rest.
//
// Why an attribute on <html> and not a second stylesheet: a <link> added at
// runtime loads asynchronously, which is the flash again. Every skin ships in
// one already-linked file and costs nothing until its attribute is set.

(function (root) {
  "use strict";

  const KEY = "uiSkin";                 // chrome.storage.sync
  const CACHE = "ytdsSkin";             // localStorage, same value, fast path
  const DEFAULT = "default";

  // `name` is a proper name and stays untranslated the way provider names do;
  // `nameKey` is for skins whose name is a word rather than a name — the
  // shipped default is one ("默认" / "Default"), so it carries a key.
  // swatch = 底 / 强调 / **第三个真正用得上的颜色**。它是给「挑哪一套」用的
  // 辨认，不是预览：真正的预览是设置页当场换漆，你看见的就是真界面。
  // 第三块取那一套自己的第二个信号色(霓虹的品红)；只有一个强调色的皮肤——
  // 出厂这一套就是——取它的文字色，因为再取一个近黑的边框色，三块里就有两块
  // 看不出区别，色块也就不再帮人辨认了。
  // 三块色必须是那一套**真的在用**的 token：options-interact 会在皮肤生效之后
  // 量真实像素来对第一块和第二块，第三块必须出现在它声明过的 token 里。
  const SKINS = [
    { id: "default", nameKey: "skinDefault", name: "Default",
      swatch: ["#0e0f11", "#3ea6ff", "#f1f1f1"] },
    { id: "neon", nameKey: "skinNeon", name: "Neon Terminal",
      swatch: ["#07080c", "#38e8ff", "#ff4d8d"] }
  ];
  const BY_ID = {};
  for (const s of SKINS) BY_ID[s.id] = s;

  const known = (id) => (typeof id === "string" && BY_ID[id]) ? id : DEFAULT;

  // The default skin is the stylesheets as written, so it carries NO attribute
  // at all. That keeps `html:not([data-skin])` correct for anyone reading the
  // DOM, and means a skin can never half-apply if skins.css fails to load.
  function apply(id) {
    const el = document.documentElement;
    if (!el) return;
    const use = known(id);
    if (use === DEFAULT) el.removeAttribute("data-skin");
    else el.setAttribute("data-skin", use);
  }

  function cacheWrite(id) {
    try { localStorage.setItem(CACHE, known(id)); } catch (_e) { /* private mode: skip */ }
  }
  function cacheRead() {
    try { return known(localStorage.getItem(CACHE)); } catch (_e) { return DEFAULT; }
  }

  // ---- 1. the synchronous first paint --------------------------------------
  apply(cacheRead());

  // ---- 2. reconcile with the truth ----------------------------------------
  try {
    chrome.storage.sync.get({ [KEY]: DEFAULT }, (got) => {
      const id = known(got && got[KEY]);
      cacheWrite(id);
      apply(id);
    });
  } catch (_e) { /* no extension APIs (a mock-up page): the cache stands */ }

  // ---- 3. follow later changes --------------------------------------------
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "sync" || !ch[KEY]) return;
      const id = known(ch[KEY].newValue);
      cacheWrite(id);
      apply(id);
    });
  } catch (_e) { /* ditto */ }

  function set(id) {
    const use = known(id);
    cacheWrite(use);
    apply(use);                        // instant here; onChanged carries it elsewhere
    return new Promise((resolve) => {
      try { chrome.storage.sync.set({ [KEY]: use }, resolve); }
      catch (_e) { resolve(); }
    });
  }

  root.YTDS_SKINS = {
    list: SKINS,
    get: (id) => BY_ID[known(id)],
    DEFAULT,
    KEY,
    current: () => known(document.documentElement.getAttribute("data-skin")),
    apply, set
  };
})(typeof self !== "undefined" ? self : this);
