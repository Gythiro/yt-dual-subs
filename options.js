// options.js — the BYO-key setup page (chrome.runtime.openOptionsPage()).
//
// Why this is a page and not part of the popup:
//   1. a 360px popup cannot hold an icon list + model presets + doc links;
//   2. chrome.permissions.request() from a popup can dismiss the popup when the
//      permission dialog takes focus, and the callback then has nowhere to
//      render — a normal tab has no such problem;
//   3. the key pages and pricing pages want real estate next to the fields.
//
// Contract with the rest of the extension:
//   sync  : byoProvider / byoModel / byoBaseUrl   (also read by background.js)
//   local : byoKeys[providerId]                   (never synced, never rendered)
// The popup only switches engines and shows a one-line summary of what is set
// up here.

"use strict";

const $ = (id) => document.getElementById(id);
const P = self.YTDS_PROVIDERS;
const ICONS = self.YTDS_ICONS;
const SITE_URL = "https://gythiro.github.io/yt-dual-subs/";

// Keep in step with popup.js and store-assets/v3.6设计/00-R3设计.md §4: a custom
// endpoint can only be requested at runtime if the manifest declares
// "https://*/*" as an optional host permission, which is still an open call.
const ALLOW_CUSTOM_ENDPOINT = false;

// Through YTDS_I18N so the interface-language override (About section below)
// applies here too; "auto" resolves to plain chrome.i18n.getMessage.
const t = (k, fb) => {
  try { return self.YTDS_I18N.get(k) || fb; }
  catch (_e) { return fb; }
};
const tsub = (k, subs, fb) => {
  try { return self.YTDS_I18N.get(k, subs) || fb; }
  catch (_e) { return fb; }
};

function uiLang() {
  try {
    const ui = self.YTDS_I18N.effectiveLang();
    if (ui.toLowerCase().indexOf("zh") === 0) return "zh";
  } catch (_e) { /* ignore */ }
  return "en";
}

let state = { byoProvider: "", byoModel: "", byoBaseUrl: "", targetLang: "zh-CN",
              ttsProvider: "local-speech", ttsVoice: "" };
// Which provider's panel is on screen. Deliberately NOT state.byoProvider:
// clicking a name in the list means "let me set this one up", and it used to
// switch the whole extension over to it on the spot — even with no key saved,
// which quietly broke translation until the user noticed. Nothing is switched
// until a key actually goes through (see persist), or the user picks a
// configured provider from the popup.
let editing = "";
const storedKeys = Object.create(null);     // providerId -> true (never the value)
const fetchedModels = Object.create(null);  // providerId -> [model ids]
// Per-provider model, so switching between two configured providers does not
// throw away the model chosen for either.
let modelsBy = Object.create(null);

const CUSTOM_MODEL = "__custom__";

// ---- i18n for static markup ------------------------------------------------
function applyI18n() {
  // CSS keys CJK-specific rules (uppercase off for group labels) off this.
  try {
    const ui = self.YTDS_I18N.effectiveLang();
    if (ui) document.documentElement.lang = ui;
  } catch (_e) { /* ignore */ }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const s = t(el.dataset.i18n, "");
    if (s) el.textContent = s;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const s = t(el.dataset.i18nAria, "");
    if (s) el.setAttribute("aria-label", s);
  });
  const title = t("optTitle", "");
  if (title) document.title = title + " — " + t("extName", "Dual Subtitles for YouTube");
}

// ---- provider helpers ------------------------------------------------------
function providerList() {
  return P.list.filter((p) => ALLOW_CUSTOM_ENDPOINT || !p.custom);
}

function modelFor(id) {
  return modelsBy[id] || "";
}

function current() {
  const p = P.get(editing);
  if (!p) return null;
  return (ALLOW_CUSTOM_ENDPOINT || !p.custom) ? p : null;
}

// Four providers are known by a Chinese name at home and a romanised one
// abroad (百炼 / Model Studio, 豆包 / Doubao, …). The literal in providers.js is
// the Chinese one, so an English UI has to look the label up.
function providerLabel(p) {
  if (p.custom) return t("byoCustom", "自定义（OpenAI 兼容）");
  return p.nameKey ? t(p.nameKey, p.name) : p.name;
}

// ---- list ------------------------------------------------------------------
function renderList() {
  const ul = $("plist");
  ul.textContent = "";
  let openTabId = "";
  for (const p of providerList()) {
    const li = document.createElement("li");
    // The <ul> is the tablist; a tablist owns tabs. Leaving the wrappers as
    // listitems puts a role that is not "tab" between the two, so the tabs
    // stop being owned and the "3 of 12" a reader announces comes from
    // nowhere. popup's #lineTabs has no wrappers at all; here the bullets are
    // load-bearing for layout, so they say they are scaffolding instead.
    li.setAttribute("role", "presentation");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pitem" + (p.id === editing ? " on" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(p.id === editing));
    // Same three-part pattern popup uses for #lineTabs: the tab has an id, it
    // names the panel it opens, and the panel names it back (below). Provider
    // ids are the ASCII slugs in providers.js, so they make legal id values.
    btn.id = "ptab-" + p.id;
    btn.setAttribute("aria-controls", "detail");
    if (p.id === editing) openTabId = btn.id;
    btn.appendChild(ICONS.iconFor(p));

    const name = document.createElement("span");
    name.className = "pitem-name";
    name.textContent = providerLabel(p);
    btn.appendChild(name);

    // Which one the extension is actually translating with — the thing the
    // highlight used to imply and no longer does.
    if (p.id === state.byoProvider) {
      const inUse = document.createElement("span");
      inUse.className = "pitem-inuse";
      inUse.textContent = t("optInUse", "使用中");
      btn.appendChild(inUse);
    } else if (storedKeys[p.id]) {
      const ok = document.createElement("span");
      ok.className = "pitem-ok";
      ok.textContent = "✓";
      ok.title = t("optConfigured", "已配置");
      btn.appendChild(ok);
    }

    btn.addEventListener("click", () => {
      if (editing === p.id) return;
      editing = p.id;                 // set it up; nothing switches yet
      showMsg("", null);
      showModelMsg("", null);
      renderList();
      renderDetail();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  // renderList() rebuilds the whole list on every switch, so the panel's name
  // is not something to write once at load — it has to be re-pointed here.
  // Drop it rather than let it go stale if nothing is open: an unnamed panel
  // is merely unhelpful, one named after a tab that is gone is a lie.
  const panel = $("detail");
  if (panel) {
    if (openTabId) panel.setAttribute("aria-labelledby", openTabId);
    else panel.removeAttribute("aria-labelledby");
  }
}

// ---- model field -----------------------------------------------------------
// Curated entries first (only providers we actually ran have any), then whatever
// the user's own key reported, then the value already saved.
function modelChoices(p) {
  const seen = new Set();
  const out = [];
  const add = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  (p.models || []).forEach(add);
  (fetchedModels[p.id] || []).forEach(add);
  add(modelFor(p.id));
  add(p.defaultModel);
  return out;
}

function renderModelField(p) {
  $("modelRow").hidden = p.kind !== "llm";
  if (p.kind !== "llm") return;

  const sel = $("modelSel");
  const input = $("modelInput");
  const choices = modelChoices(p);

  sel.textContent = "";
  for (const id of choices) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id + (id === p.defaultModel ? "  ·  " + t("optRecommended", "推荐") : "");
    sel.appendChild(o);
  }
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL;
  customOpt.textContent = t("optModelCustom", "自定义…");
  sel.appendChild(customOpt);

  const saved = modelFor(p.id) || p.defaultModel;
  const known = saved && choices.includes(saved);
  sel.value = known ? saved : CUSTOM_MODEL;
  sel.hidden = false;

  const typing = sel.value === CUSTOM_MODEL;
  input.hidden = !typing;
  input.value = typing ? (modelFor(p.id) || "") : "";
  input.placeholder = t("byoModelRequired", "必填：模型名");

  if (!choices.length) {
    showModelMsg(t("optNoModelsYet", "还没有模型列表——点右边的按钮用你的 Key 拉取，或直接手填。"), null);
  }
}

function showModelMsg(text, kind) {
  const el = $("modelMsg");
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

// ---- key field -------------------------------------------------------------
function paintKeyField(p) {
  const inp = $("key");
  const clear = $("keyClear");
  inp.value = "";
  inp.type = $("showKey").checked ? "text" : "password";
  inp.placeholder = p.kind === "deepl" ? "xxxxxxxx-xxxx-…:fx" : "sk-…";
  clear.hidden = true;

  chrome.storage.local.get({ byoKeys: {} }, (got) => {
    const key = ((got && got.byoKeys) || {})[p.id] || "";
    storedKeys[p.id] = !!key;
    // The one thing a first-time visitor has to notice.
    $("needKey").hidden = !!key;
    if (!key) return;
    // Every DeepL Free key ends in ":fx", so masking to those four characters
    // would tell the user nothing — mask the last four before the suffix.
    const last4 = key.replace(/:fx$/, "").slice(-4);
    inp.placeholder = tsub("byoKeySaved", [last4], "已保存 ····" + last4);
    clear.hidden = false;
  });
}

// ---- detail ----------------------------------------------------------------
function renderDetail() {
  const p = current();
  if (!p) return;

  const icon = $("pIcon");
  icon.textContent = "";
  icon.appendChild(ICONS.iconFor(p));
  $("pName").textContent = providerLabel(p);
  const kind = $("pKind");
  kind.hidden = p.kind !== "deepl";
  kind.textContent = "DeepL API";

  const keyLink = $("pKeyLink");
  keyLink.hidden = !p.keyUrl;
  if (p.keyUrl) keyLink.href = p.keyUrl;
  const priceLink = $("pPricingLink");
  priceLink.hidden = !p.pricingUrl;
  if (p.pricingUrl) priceLink.href = p.pricingUrl;
  $("pGuideLink").href = SITE_URL + "guide.html?lang=" + uiLang() + "#" + p.id;

  $("baseRow").hidden = !p.custom;
  $("baseUrl").value = state.byoBaseUrl || "";

  renderModelField(p);
  paintKeyField(p);
  showMsg("", null);
}

function showMsg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.classList.remove("ok", "err", "warn");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

function errText(code) {
  return t(P.errorKey(code), t("byoErrFailed", "连接失败，稍后再试。"));
}

// ---- plan / save / probe ---------------------------------------------------
// Read synchronously: permissions.request() has to be reached inside the click
// gesture, so nothing may await before it.
function plan() {
  const p = current();
  if (!p) return { error: "noProvider" };

  const typedKey = $("key").value.trim();
  const sel = $("modelSel");
  const model = p.kind !== "llm"
    ? ""
    : (sel.value === CUSTOM_MODEL ? $("modelInput").value.trim() : sel.value);

  let baseUrl = "";
  let origins;
  if (p.custom) {
    const parsed = P.parseCustomBase($("baseUrl").value);
    if (!parsed) return { error: "badBaseUrl" };
    baseUrl = parsed.baseUrl;
    origins = P.originsFor(p, parsed.origin);
  } else {
    origins = P.originsFor(p);
  }
  return { provider: p, origins, typedKey, model, baseUrl };
}

// Saving a key IS the moment to switch to that provider: the user typed it and
// pressed the button. Clicking around the list is not, which is why this is the
// only place byoProvider moves from inside the settings page.
// Saving what belongs to the provider being set up: its key, and the model
// chosen for it. Neither of these is a decision about which provider the
// extension translates with.
function persistForProvider(pl) {
  modelsBy[pl.provider.id] = pl.model;
  chrome.storage.sync.set({ byoModelBy: Object.assign({}, modelsBy) });
  return pl.typedKey ? saveKey(pl.provider.id, pl.typedKey) : Promise.resolve();
}

// …and the decision itself. Kept separate because it used to be inseparable:
// "fetch this provider's models" ran the whole of this, so opening a provider
// you were curious about and asking what it offers switched the extension over
// to it — a different account's quota, and a host permission prompt, for a
// question. The invariant at the top of this file said nothing switches until a
// key goes through; this is what made that true again.
function persist(pl) {
  state.byoProvider = pl.provider.id;
  state.byoModel = pl.model;
  state.byoBaseUrl = pl.baseUrl;
  modelsBy[pl.provider.id] = pl.model;
  // One set() so content.js re-cues once instead of three times.
  chrome.storage.sync.set({
    byoProvider: state.byoProvider,
    byoModel: state.byoModel,
    byoBaseUrl: state.byoBaseUrl,
    byoModelBy: Object.assign({}, modelsBy)
  });
  return pl.typedKey ? saveKey(pl.provider.id, pl.typedKey) : Promise.resolve();
}

// Which providers have answered a real request, so the popup can say which of
// the saved keys is known to work rather than just "saved".
function markVerified(id, ok) {
  chrome.storage.local.get({ byoOk: {} }, (got) => {
    const map = (got && got.byoOk) || {};
    if (ok) map[id] = true; else delete map[id];
    chrome.storage.local.set({ byoOk: map });
  });
}

function saveKey(id, key) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ byoKeys: {} }, (got) => {
      const keys = (got && got.byoKeys) || {};
      if (key == null) delete keys[id]; else keys[id] = key;
      chrome.storage.local.set({ byoKeys: keys }, () => {
        storedKeys[id] = key != null;
        resolve();
      });
    });
  });
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

// Both buttons need the same preamble: a valid plan, host permission, and the
// configuration on disk before the worker can act on it.
//
// The button goes to its busy label BEFORE the permission request, so a click
// always changes something on screen. Without that, a permission prompt the user
// dismisses (its callback never fires) looks exactly like a dead button — which
// is what happened on the real machine.
// `adopt` says whether finishing this makes the provider the one in use. Saving
// and testing a key does; asking a provider what models it has does not.
function withSetup(btn, busyKey, busyFallback, onError, run, adopt) {
  const pl = plan();
  if (pl.error) { onError(pl.error); return; }
  if (!pl.typedKey && !storedKeys[pl.provider.id]) { onError("noKey"); return; }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t(busyKey, busyFallback);
  const done = () => { btn.disabled = false; btn.textContent = label; };

  try {
    chrome.permissions.request({ origins: pl.origins }, (granted) => {
      if (chrome.runtime.lastError || !granted) { done(); onError("noPerm"); return; }
      (adopt === false ? persistForProvider(pl) : persist(pl))
        .then(() => run(pl))
        // A rejection here would otherwise be swallowed and read as a no-op.
        .catch((err) => onError((err && err.code) || "failed"))
        .then(done, done);
    });
  } catch (_e) {
    done();
    onError("noPerm");
  }
}

async function runTest(pl) {
  showMsg("", null);
  try {
    const resp = await sendToBackground({ type: "byoTest", targetLang: state.targetLang });
    if (resp && resp.ok) {
      const sample = String(resp.sample || "").slice(0, 60);
      markVerified(pl.provider.id, true);
      renderList();
      showMsg(tsub("byoTestOk", [sample], "连接成功：" + sample), "ok");
    } else {
      markVerified(pl.provider.id, false);
      showMsg(errText(resp && resp.code), "err");
    }
  } finally {
    paintKeyField(pl.provider);
    renderList();
  }
}

async function runFetchModels(pl) {
  showModelMsg("", null);
  try {
    // Name the provider being asked about. Without it the worker answers for
    // whichever one the extension is translating with, which is why this used
    // to switch over first.
    const resp = await sendToBackground({ type: "byoModels", provider: pl.provider.id });
    if (resp && resp.ok && resp.models && resp.models.length) {
      fetchedModels[pl.provider.id] = resp.models;
      renderModelField(pl.provider);
      showModelMsg(tsub("optModelsFetched", [String(resp.models.length)],
        "拉到 " + resp.models.length + " 个模型"), "ok");
    } else {
      showModelMsg(resp && resp.code
        ? errText(resp.code)
        : t("optModelsFailed", "拉取失败——可以直接手填模型名。"), "err");
    }
  } finally {
    paintKeyField(pl.provider);
  }
}

// ---- target languages ------------------------------------------------------
// Two lists: the ones the popup offers, and everything else. The popup keeps a
// native <select>, which cannot hold a remove button inside an <option> — the
// same limitation that put provider setup on this page — so the arranging
// happens here and the popup just renders the result.
const LANGS = self.YTDS_LANGS;
let langKept = null;              // array of codes; null until storage is read

function showLangMsg(text, kind) {
  const el = $("langMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

// Intl.DisplayNames has been in Chrome since 81 and the manifest floor is 111,
// but a Chromium fork could still lack it — fall back to the English name
// rather than dropping the label.
let displayNames = null;
try {
  const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "en";
  displayNames = new Intl.DisplayNames([ui], { type: "language" });
} catch (_e) { /* fall back below */ }

function localName(info) {
  if (displayNames) {
    try {
      const n = displayNames.of(info.code);
      // A locale with no name for the code echoes the code straight back.
      if (n && n !== info.code) return n;
    } catch (_e) { /* fall through */ }
  }
  return info.en || "";
}

function langRow(info, kept) {
  const li = document.createElement("li");
  li.className = "olang";
  li.dataset.code = info.code;

  const name = document.createElement("span");
  name.className = "olang-name";
  name.textContent = info.native;
  // Second label in the READER's language, not always English: "Nederlands
  // Dutch" is no help to someone running the Chinese UI. The browser already
  // knows every one of these names in every locale, so nothing is maintained
  // here — the table's English name is only the fallback.
  const second = localName(info);
  if (second && second !== info.native) {
    const el = document.createElement("span");
    el.className = "olang-en";
    el.textContent = "  " + second;
    name.appendChild(el);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "olang-btn" + (kept ? " remove" : " add");
  btn.textContent = kept ? "×" : "+";
  const label = kept ? t("langsRemoveAria", "移除") : t("langsAddAria", "添加");
  btn.setAttribute("aria-label", label + " " + info.native);
  btn.title = label;
  btn.addEventListener("click", () => (kept ? removeLang(info.code) : addLang(info.code)));

  li.appendChild(name);
  li.appendChild(btn);
  return li;
}

function renderLangs() {
  const keptEl = $("langKept"), moreEl = $("langMore");
  if (!keptEl || !moreEl || !LANGS) return;
  const kept = langKept || LANGS.defaults();
  const keptSet = new Set(kept);

  keptEl.textContent = "";
  for (const code of kept) {
    const info = LANGS.get(code);
    if (info) keptEl.appendChild(langRow(info, true));
  }
  // The last one cannot be removed: an empty dropdown is a broken control.
  if (kept.length === 1) {
    const only = keptEl.querySelector(".olang-btn");
    if (only) { only.disabled = true; only.title = t("langsLastOne", "至少要留一个"); }
  }

  moreEl.textContent = "";
  const rest = LANGS.all().filter((l) => !keptSet.has(l.code));
  if (!rest.length) {
    const li = document.createElement("li");
    li.className = "olang-empty";
    li.textContent = t("langsAllAdded", "全部语言都已加入。");
    moreEl.appendChild(li);
  }
  for (const info of rest) moreEl.appendChild(langRow(info, false));
}

function persistLangs() {
  try { chrome.storage.sync.set({ langShown: langKept }); } catch (_e) { /* ignore */ }
}

function addLang(code) {
  const kept = (langKept || LANGS.defaults()).slice();
  if (kept.includes(code)) return;
  kept.push(code);
  langKept = kept;
  persistLangs();
  renderLangs();
  const info = LANGS.get(code);
  showLangMsg(tsub("langsAdded", [info ? info.native : code],
    "已加入「" + (info ? info.native : code) + "」"), "ok");
}

function removeLang(code) {
  const kept = (langKept || LANGS.defaults()).filter((c) => c !== code);
  if (!kept.length) return;                 // guarded in the UI too
  langKept = kept;
  persistLangs();
  renderLangs();
  // Removing the language currently in use would leave the popup pointing at
  // something it no longer lists, so move the selection with it.
  chrome.storage.sync.get({ targetLang: "zh-CN" }, (got) => {
    if (got && got.targetLang === code) {
      chrome.storage.sync.set({ targetLang: kept[0] });
      const info = LANGS.get(kept[0]);
      showLangMsg(tsub("langsSwitched", [info ? info.native : kept[0]],
        "它正在使用中,已改为「" + (info ? info.native : kept[0]) + "」"), null);
    }
  });
}

// ---- sections --------------------------------------------------------------
// One page, three views. The hash is what makes them addressable: the first-run
// tab opens `options.html#start`, so a brand new user lands on the three-step
// page instead of an API key form they have no reason to fill in yet.
const SECTIONS = {
  start: { el: "secStart", title: "optNavStart", intro: "startIntro" },
  setup: { el: "detail", title: "optTitle", intro: "optIntro" },
  langs: { el: "secLangs", title: "optNavLangs", intro: "langsIntro" },
  readaloud: { el: "secReadaloud", title: "optNavReadaloud", intro: "ttsIntro" },
  about: { el: "secAbout", title: "optNavAbout", intro: "aboutIntro" }
};

function showSection(name) {
  const sec = SECTIONS[name] ? name : "setup";
  for (const [key, def] of Object.entries(SECTIONS)) {
    const el = $(def.el);
    if (el) el.hidden = key !== sec;
  }
  // The provider list belongs to the setup view only — it is that view's
  // navigation, not the page's.
  $("plistWrap").hidden = sec !== "setup";
  document.querySelectorAll(".onav-item").forEach((b) => {
    const on = b.dataset.sec === sec;
    b.classList.toggle("on", on);
    b.setAttribute("aria-current", on ? "page" : "false");
  });
  const def = SECTIONS[sec];
  $("pageTitle").textContent = t(def.title, $("pageTitle").textContent);
  $("pageIntro").textContent = t(def.intro, $("pageIntro").textContent);
  // …and the tab strip, which was built once at boot and then said
  // "Translation service setup" whichever pane you were on. The heading and
  // the title come from the same key, so they cannot disagree.
  const heading = $("pageTitle").textContent;
  if (heading) document.title = heading + " — " + t("extName", "Dual Subtitles for YouTube");
  // The footer's privacy/trademark lines show per pane (options.css keys off
  // this attribute); the feedback link stays on every pane.
  const oft = $("oft");
  if (oft) oft.dataset.sec = sec;
  if (location.hash.slice(1) !== sec) {
    // replace, not push: the section switch is not somewhere "back" should go.
    history.replaceState(null, "", "#" + sec);
  }
}

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

async function buildDiagnostics() {
  const L = [];
  let ver = "";
  try { ver = chrome.runtime.getManifest().version; } catch (_e) { /* ignore */ }
  L.push("Dual Subtitles for YouTube — diagnostic");
  L.push("version: " + (ver || "?"));
  L.push("browser: " + navigator.userAgent);
  let ui = "";
  try { ui = (chrome.i18n && chrome.i18n.getUILanguage()) || ""; } catch (_e) { /* ignore */ }
  let uiLocale = "auto";
  try {
    const got = await new Promise((res) => chrome.storage.sync.get({ uiLocale: "auto" }, res));
    uiLocale = (got && got.uiLocale) || "auto";
  } catch (_e) { /* ignore */ }
  L.push("ui-language: " + (ui || "?") +
    (uiLocale && uiLocale !== "auto" ? " (override: " + uiLocale + ")" : ""));
  L.push("target-language: " + (state.targetLang || "?"));
  L.push("engine-setting: " + (state.byoProvider
    ? "byo (" + state.byoProvider + (state.byoModel ? " / " + state.byoModel : "") + ")"
    : "see popup"));
  L.push("read-aloud: " + (state.ttsProvider || "off") +
    (state.ttsVoice ? " / " + state.ttsVoice : ""));
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
  const pages = await askYouTubeTabs();
  if (!pages.length) {
    L.push("page: no YouTube tab open");
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
      L.push("video-engine" + n + ": " + (r.engine || "none yet") +
        (r.provider ? " (" + r.provider + ")" : "") +
        (r.same ? ", same-language" : "") +
        (r.track && r.track !== "none" ? ", track=" + r.track : "") +
        (r.fellBack ? ", fell-back" : "") +
        (r.tts ? ", tts spoken=" + r.tts.spoken + " skipped=" + r.tts.skipped +
          (r.tts.err ? " err=" + r.tts.err : "") : ""));
    });
  }
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
  const btn = $("aboutDiag");
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

function initAbout() {
  const lang = uiLang();
  let ver = "";
  try { ver = chrome.runtime.getManifest().version; } catch (_e) { /* ignore */ }
  $("aboutVer").textContent = ver || "—";
  initUiLocale();
  const set = (id, href) => { const el = $(id); if (el) el.href = href; };
  set("aboutSite", SITE_URL + "?src=options&lang=" + lang);
  set("aboutGithub", "https://github.com/Gythiro/yt-dual-subs");
  set("aboutChangelog", SITE_URL + "updated.html?lang=" + lang + "&src=options");
  set("aboutRoadmap", SITE_URL + "roadmap.html?lang=" + lang + "&src=options");
  set("troubleFeedback", SITE_URL + "feedback.html?lang=" + lang + "&src=options");
  const diag = $("aboutDiag");
  if (diag) diag.addEventListener("click", onDiagCopy);
}

// ---- wiring ----------------------------------------------------------------
// ---- read-aloud (TTS) setup -------------------------------------------------
// The pipeline's user half: pick a provider, store a key (masked ever after),
// pick a voice, save-and-test. Mirrors the translation setup's discipline —
// permissions.request is the FIRST thing in the click handler (any await ahead
// of it silently spends the user gesture), the key never rides back into the
// DOM, and the test exercises the stored configuration, not the draft.
const ttsStored = Object.create(null);      // providerId -> true (never the key)

function ttsProvider() {
  return P.tts.get($("ttsProviderSel").value) || null;
}

function showTtsMsg(text, kind) {
  const el = $("ttsMsg");
  el.textContent = text || "";
  el.className = "omsg" + (kind ? " " + kind : "");
  el.hidden = !text;
}

function paintTtsKeyField(p) {
  const inp = $("ttsKey");
  const clear = $("ttsKeyClear");
  inp.value = "";
  inp.type = $("ttsShowKey").checked ? "text" : "password";
  inp.placeholder = p.keyHint != null ? p.keyHint : "sk-…";
  clear.hidden = true;
  // Azure's key is bound to a region that becomes the request host; only a
  // provider that says so gets the field.
  const regionRow = $("ttsRegionRow");
  if (regionRow) regionRow.hidden = !p.needsRegion;
  chrome.storage.local.get({ ttsKeys: {} }, (got) => {
    const key = ((got && got.ttsKeys) || {})[p.id] || "";
    ttsStored[p.id] = !!key;
    if (!key) return;
    const last4 = key.slice(-4);
    inp.placeholder = tsub("byoKeySaved", [last4], "已保存 ····" + last4);
    clear.hidden = false;
  });
}

// Who the voice is and which language it grew up speaking — the accent it
// carries into all the others. The raw id says neither.
function voiceLabel(v) {
  try {
    return P.tts.voiceLabel(v, (code) => {
      const info = LANGS.get(code);
      return info ? info.native : "";
    }, (g) => (g === "f" ? t("ttsVoiceFemale", "女声") : t("ttsVoiceMale", "男声")));
  } catch (_e) { return v; }
}

// Voices fetched for one language, remembered per provider so switching back
// and forth does not re-spend the round trip. Lives only for this page's life:
// the built-in family is the durable answer and what the engine falls back to.
const fetchedVoices = Object.create(null);   // providerId -> [voice id]

// Two catalogues, never one list. The family a provider ships FOLLOWS the
// reader across all fifty target languages; what "fetch this language's voices"
// returns is PINNED to the language it was fetched for. Merging them produced a
// menu where the two behaved differently and nothing said so — and, for Google,
// where thirty of the thirty-eight fetched entries were the family list again
// under longer names. So fetching switches which catalogue is on screen rather
// than appending to it, and there is a way back.
let voiceCatalogue = "family";          // "family" | "language"

function ttsVoiceChoices(p) {
  if (voiceCatalogue === "language" && (fetchedVoices[p.id] || []).length) {
    return fetchedVoices[p.id].slice();
  }
  return (p.voices || []).slice();
}

// The machine's own voices, for the language being read. Chrome fills this
// list asynchronously on first call, hence the event. The rule for "which of
// them count" lives in providers.js so that this page and the popup cannot
// drift into offering different menus.
function localVoicesFor(lang) {
  return P.tts.localVoiceNames(window.speechSynthesis, lang);
}

function paintTtsVoices(p) {
  const sel = $("ttsVoiceSel");
  sel.textContent = "";
  const choices = p.localVoices
    ? localVoicesFor(state.targetLang) : ttsVoiceChoices(p);
  const inLanguage = !p.localVoices && voiceCatalogue === "language" &&
    (fetchedVoices[p.id] || []).length > 0;
  const add = (parent, v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = voiceLabel(v);
    parent.appendChild(o);
  };
  if (inLanguage) {
    // The id carries the engine generation, and that is the actual difference
    // between two entries whose names are both a single letter. Grouping by it
    // turns a column of near-identical strings into a handful of short lists.
    const tiers = [];
    const byTier = Object.create(null);
    for (const v of choices) {
      const tier = P.tts.voiceTier(v);          // "" for providers whose ids carry none
      if (!byTier[tier]) { byTier[tier] = []; tiers.push(tier); }
      byTier[tier].push(v);
    }
    const grouped = tiers.filter(Boolean).length > 1;
    for (const tier of tiers) {
      // An untiered id has nothing to head a group with, and one group is a
      // heading over the whole list — neither earns a label it would have to
      // be given in twenty languages.
      if (!tier || !grouped) { byTier[tier].forEach((v) => add(sel, v)); continue; }
      const g = document.createElement("optgroup");
      g.label = tier;
      byTier[tier].forEach((v) => add(g, v));
      sel.appendChild(g);
    }
  } else {
    choices.forEach((v) => add(sel, v));
  }
  const want = state.ttsVoice || p.defaultVoice || "";
  // A voice fetched on an earlier visit is one the engine honours but that is
  // not in the family we ship, and the fetched catalogue does not outlive this
  // page. Leaving it out of the menu never stopped it from speaking — it only
  // stopped the menu from admitting which voice that was, and then the next
  // save wrote the family's first entry down in its place. Same branch the
  // popup grew for the same reason.
  // Not for the browser's own voices: their names are whatever THIS machine
  // has installed, ttsVoice rides storage.sync between machines, and
  // voiceOwned cannot check them (providers.js says so) — so a voice picked on
  // another machine would be listed and selected here without existing, and
  // the engine would quietly speak in the default voice instead.
  // Only into the family menu. The fetched catalogue is PINNED to the language
  // it was fetched for, so a name from outside it — the family default among
  // them — does not belong in that list.
  if (want && !inLanguage && !p.localVoices && !choices.includes(want) &&
      P.tts.voiceOwned(p, want) &&
      P.tts.voiceAppliesTo(p, want, state.targetLang)) {
    add(sel, want);
    choices.push(want);
  }
  if (want && choices.includes(want)) sel.value = want;
  const row = $("ttsFetchRow");
  if (row) row.hidden = !p.listVoices;
  const back = $("ttsBackToFamily");
  if (back) back.hidden = !inLanguage;
  const fetchBtn = $("ttsFetchVoices");
  // Offering "fetch" again while its own result is on screen invites a second
  // round trip for the same answer.
  if (fetchBtn) fetchBtn.hidden = inLanguage;
  // Nothing to key, nothing to test: the browser is already installed.
  const keyField = $("ttsKey");
  if (keyField) {
    const field = keyField.closest(".ofield");
    if (field) field.hidden = !!p.keyless;
  }
  const testBtn = $("ttsTestBtn");
  if (testBtn) testBtn.hidden = !!p.keyless;
}

function persistTts(p, typedKey) {
  return new Promise((resolve) => {
    state.ttsProvider = p.id;
    state.ttsVoice = voiceToSave(p);
    chrome.storage.sync.set({ ttsProvider: state.ttsProvider, ttsVoice: state.ttsVoice }, () => {
      if (!typedKey) return resolve();
      chrome.storage.local.get({ ttsKeys: {} }, (got) => {
        const keys = Object.assign({}, (got && got.ttsKeys) || {});
        keys[p.id] = typedKey;
        chrome.storage.local.set({ ttsKeys: keys }, resolve);
      });
    });
  });
}

// What "save" should write down for the voice. Not simply what the dropdown
// shows: the dropdown cannot always show the stored voice. Fetching a
// language's voices REPLACES the menu with a list pinned to that language, and
// a name from outside it — the family default, or a voice fetched for another
// language — has no place in that list. The menu then shows its first entry
// while the engine goes on using the stored one, and writing down what the
// menu shows loses a voice the reader never touched.
//
// So: if the menu is offering the stored voice, the menu is the answer — the
// reader may have just changed it. If it is not, and the stored voice is still
// one this provider will honour, it stays. Only a stored voice this provider
// would not accept is replaced.
function voiceToSave(p) {
  const sel = $("ttsVoiceSel");
  const stored = state.ttsVoice || "";
  const offered = Array.prototype.some.call(sel.options, (o) => o.value === stored);
  // The same two questions the menu above asked. Asking only the first — does
  // this provider own the name — kept a voice that no longer applies to the
  // language being read: the menu correctly refused to list it, and save wrote
  // it back anyway, so the page disagreed with itself and the engine replaced
  // the voice on every line.
  if (!offered && stored && P.tts.voiceOwned(p, stored) &&
      P.tts.voiceAppliesTo(p, stored, state.targetLang)) {
    return stored;
  }
  return sel.value || p.defaultVoice || "";
}

// The playback half only unlocks once the STORED provider can actually sound
// (registry hit, and a key unless the provider is keyless — the same predicate
// the popup's card uses). The dropdown draft does not count: switching it
// without saving changes nothing about what the engine plays with.
// Mirrors popup.js's ttsUsable — the two must not drift, or one page offers a
// switch the other knows cannot sound.
const TTS_REGION_OK = /^[a-z0-9]{1,42}$/;      // mirrors background.js resolveTts
function ttsReady() {
  const p = P.tts.get(state.ttsProvider || "");
  if (!p) return Promise.resolve(false);
  // Mirrors popup.js ttsUsable: a browser without speechSynthesis cannot be
  // offered the engine that depends on it.
  if (p.localVoices) {
    return Promise.resolve(typeof speechSynthesis !== "undefined");
  }
  return new Promise((res) => {
    chrome.storage.sync.get({ ttsRegion: "" }, (sy) => {
      // Azure's key is bound to a region that becomes the request host, and the
      // key is stored before the test runs — so "has a key" can still mean
      // "cannot speak a single line".
      if (p.needsRegion &&
          !TTS_REGION_OK.test(String((sy && sy.ttsRegion) || "").trim().toLowerCase())) {
        return res(false);
      }
      if (p.keyless) return res(true);
      chrome.storage.local.get({ ttsKeys: {} }, (got) => {
        res(!!(((got && got.ttsKeys) || {})[p.id]));
      });
    });
  });
}

function paintTtsUse() {
  const use = $("ttsUse");
  if (!use) return;
  ttsReady().then((ready) => {
    $("ttsNeedKey").hidden = ready;
    use.classList.toggle("locked", !ready);
    for (const id of ["ttsEnabled", "ttsVolume", "ttsDuckPct"]) {
      const el = $(id);
      if (el) el.disabled = !ready;
    }
  });
}

function initReadaloud() {
  const sel = $("ttsProviderSel");
  if (!sel) return;
  const guide = $("ttsGuideLink");
  if (guide) {
    guide.href = SITE_URL + "guide.html?lang=" + uiLang() + "&src=options#readaloud";
  }
  const en = $("ttsEnabled");
  if (en) {
    chrome.storage.sync.get({ ttsEnabled: false }, (got) => { en.checked = !!(got && got.ttsEnabled); });
    en.addEventListener("change", () => {
      chrome.storage.sync.set({ ttsEnabled: en.checked });
    });
  }
  // Loudness sliders. Live-written on input (the popup's sliders set the
  // precedent): the spoken line follows ttsVolume while it sounds, and the
  // duck depth rides the next duck message.
  for (const [id, defV] of [["ttsVolume", 100], ["ttsDuckPct", 25]]) {
    const r = $(id);
    if (!r) continue;
    const label = $(id + "V");
    const paint = () => { if (label) label.textContent = r.value + "%"; };
    chrome.storage.sync.get({ [id]: defV }, (got) => {
      r.value = got && got[id] != null ? got[id] : defV;
      paint();
    });
    r.addEventListener("input", () => {
      paint();
      chrome.storage.sync.set({ [id]: Number(r.value) });
    });
  }
  // Azure region: stored normalized (it is spliced into the request host, and
  // the worker refuses anything that is not a plain hostname label).
  const region = $("ttsRegion");
  if (region) {
    chrome.storage.sync.get({ ttsRegion: "" }, (got) => {
      region.value = (got && got.ttsRegion) || "";
    });
    region.addEventListener("input", () => {
      chrome.storage.sync.set({ ttsRegion: region.value.trim().toLowerCase() });
      paintTtsUse();     // typing a valid region unlocks playback on the spot
    });
  }
  sel.textContent = "";
  for (const p of P.tts.list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  const cur = P.tts.get(state.ttsProvider) || P.tts.list[0];
  sel.value = cur.id;
  paintTtsKeyField(cur);
  paintTtsVoices(cur);
  paintTtsUse();

  // The machine's voice table is not ready when this page paints: the first
  // synchronous getVoices() returns an empty array in every Chrome, and the
  // list announces itself afterwards. Painting once left the DEFAULT engine
  // with an empty picker — the one screen where "no voices" reads as "this
  // feature is broken" rather than "this provider has none".
  const synth = window.speechSynthesis;
  if (synth && typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", () => {
      const p = ttsProvider();
      if (!p || !p.localVoices) return;   // an API provider's list is ours, not the machine's
      const vsel = $("ttsVoiceSel");
      const had = vsel ? vsel.value : "";
      paintTtsVoices(p);
      // Chrome may announce more than once (a voice pack finishing later). A
      // repaint must not undo a pick that has been made but not yet saved.
      if (had && vsel && Array.prototype.some.call(vsel.options, (o) => o.value === had)) {
        vsel.value = had;
      }
    });
  }

  sel.addEventListener("change", () => {
    const p = ttsProvider();
    if (!p) return;
    showTtsMsg("", null);
    // The fetch line answers a question about the provider that was on screen
    // when it was asked ("switched to this language's 38 voices"). Left
    // standing, it describes voices that are not in the dropdown underneath it.
    showTtsVoiceMsg("", null);
    // …and neither is the catalogue it switched to: another provider's fetched
    // list is not this one's.
    voiceCatalogue = "family";
    paintTtsKeyField(p);
    paintTtsVoices(p);
  });
  $("ttsShowKey").addEventListener("change", () => {
    $("ttsKey").type = $("ttsShowKey").checked ? "text" : "password";
  });
  $("ttsKeyClear").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) return;
    chrome.storage.local.get({ ttsKeys: {} }, (got) => {
      const keys = Object.assign({}, (got && got.ttsKeys) || {});
      delete keys[p.id];
      chrome.storage.local.set({ ttsKeys: keys }, () => {
        paintTtsKeyField(p);
        paintTtsUse();             // clearing the stored provider's key re-locks
      });
    });
  });
  // The local engine previews without a round trip — same sentence, same
  // language, spoken by the machine.
  function speakLocalSample(voiceName) {
    const synth = window.speechSynthesis;
    if (!synth) { showTtsMsg(t("ttsPreviewFail", "播不出来"), "err"); return; }
    try { synth.cancel(); } catch (_e) { /* ignore */ }
    const lang = state.targetLang || "zh-CN";
    const u = new SpeechSynthesisUtterance(
      (LANGS && LANGS.sample ? LANGS.sample(lang) : "") || "Hello.");
    u.lang = lang;
    const v = (synth.getVoices() || []).find((x) => x && x.name === voiceName);
    if (v) u.voice = v;
    try { synth.speak(u); } catch (_e) {
      showTtsMsg(t("ttsPreviewFail", "播不出来"), "err");
    }
  }

  // One player for both doors into it: Preview, and Save-and-test once it has
  // proved the key. The blob is released when the line finishes.
  let previewAudio = null;
  function playPreview(resp, after) {
    const done = () => { if (after) after(); };
    if (!resp || !resp.b64) { done(); return; }
    if (previewAudio) { try { previewAudio.pause(); } catch (_e) { /* ignore */ } }
    try {
      const bin = atob(resp.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: resp.mime || "audio/mpeg" }));
      previewAudio = new Audio(url);
      const cleanup = () => { try { URL.revokeObjectURL(url); } catch (_e) { /* ignore */ } done(); };
      previewAudio.addEventListener("ended", cleanup);
      previewAudio.addEventListener("error", () => {
        showTtsMsg(t("ttsPreviewFail", "播不出来"), "err");
        cleanup();
      });
      previewAudio.play().catch(() => {
        showTtsMsg(t("ttsPreviewFail", "播不出来"), "err");
        cleanup();
      });
    } catch (_e) { done(); }
  }

  // Preview: hear the SELECTED voice — saved or not — speak a line in the
  // language being read. Nothing is written; the audio comes back with the
  // probe the worker already had to run, so this costs one synthesis and no
  // extra plumbing. Permissions are not requested here: only a provider whose
  // key went through Save-and-test can be previewed, and that flow already
  // granted the host.
  function showTtsVoiceMsg(text, kind) {
    const el = $("ttsVoiceMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "ohint" + (kind ? " " + kind : "");
    el.hidden = !text;
  }

  $("ttsFetchVoices").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    if (!ttsStored[p.id] && !p.keyless) { showTtsMsg(errText("noKey"), "err"); return; }
    const btn = $("ttsFetchVoices");
    const label = t("ttsFetchVoices", "拉取这个语言的更多音色");
    btn.disabled = true;
    btn.textContent = t("ttsFetching", "拉取中…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsVoiceMsg("", null);
    sendToBackground({ type: "ttsVoices" })
      .then((resp) => {
        if (!resp || !resp.ok) {
          // Falling back to the built-in family is the honest failure: a voice
          // list is not something a user can type in by hand.
          showTtsVoiceMsg(errText(resp && resp.code), "err");
          done();
          return;
        }
        // Exact-string filtering kept "cmn-CN-Chirp3-HD-Achernar" alongside the
        // "Achernar" already on offer — the same voice twice, thirty times over.
        const extra = P.tts.mergeFetched(p, resp.voices);
        fetchedVoices[p.id] = extra;
        if (extra.length) voiceCatalogue = "language";
        paintTtsVoices(p);
        // Say what changed and what it costs, not "more". These voices work for
        // the language they were fetched for and no other.
        showTtsVoiceMsg(extra.length
          ? tsub("ttsVoicesSwitched", [String(extra.length)],
            "已切到这个语言专属的 " + extra.length + " 个音色,它们只对当前译文语言有效。")
          : t("ttsVoicesNone", "这家在这个语言下没有额外音色。"), extra.length ? "ok" : null);
        done();
      })
      .catch((err) => { showTtsVoiceMsg(errText((err && err.code) || "failed"), "err"); done(); });
  });

  $("ttsBackToFamily").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) return;
    voiceCatalogue = "family";
    showTtsVoiceMsg("", null);
    paintTtsVoices(p);
  });

  // Picking a voice IS the decision — there is nothing else to confirm. It used
  // to be written down only by "save and test", which this page hides for a
  // keyless provider: the browser's own engine is keyless and is the one every
  // reader starts on, so its voice could not be chosen from this page at all.
  // A reader picked one, pressed Preview, heard it, and nothing was stored.
  $("ttsVoiceSel").addEventListener("change", () => {
    const p = ttsProvider();
    if (!p) return;
    const inUse = p.id === state.ttsProvider;
    // The dropdown on this page means "the one I am setting up" — a draft the
    // reader browses with (initCrossPageSync says so, and refuses to drag it).
    // So a voice picked while looking at ANOTHER provider is part of setting
    // that one up, not a decision about the one in use — and writing ttsVoice
    // alone would file it under the id of the provider in use, whose engine
    // does not recognise it, silently replacing a voice nobody touched.
    // Save-and-test is what commits that pair, together.
    //
    // Unless there is no save-and-test: a keyless provider has nothing to
    // test, this page hides the button for it, and picking a voice is the
    // entire setup. Then the pick has to carry the engine with it, or the free
    // engine can never be chosen from this page at all.
    if (!inUse && !p.keyless) return;
    state.ttsVoice = $("ttsVoiceSel").value || "";
    const write = { ttsVoice: state.ttsVoice };
    if (!inUse) {
      state.ttsProvider = p.id;
      write.ttsProvider = p.id;
    }
    chrome.storage.sync.set(write);
  });

  $("ttsPreview").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    if (!ttsStored[p.id] && !p.keyless) { showTtsMsg(errText("noKey"), "err"); return; }
    if (p.localVoices) {
      // Nothing to fetch: this page has a speaker and the browser has voices.
      speakLocalSample($("ttsVoiceSel").value);
      return;
    }
    const btn = $("ttsPreview");
    const label = t("ttsPreview", "试听");
    btn.disabled = true;
    btn.textContent = t("ttsPreviewPlaying", "播放中…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsMsg("", null);
    if (previewAudio) { try { previewAudio.pause(); } catch (_e) { /* ignore */ } }
    sendToBackground({ type: "ttsTest", voice: $("ttsVoiceSel").value })
      .then((resp) => {
        if (!resp || !resp.ok || !resp.b64) {
          showTtsMsg(errText(resp && resp.code), "err");
          done();
          return;
        }
        playPreview(resp, done);
      })
      .catch((err) => { showTtsMsg(errText((err && err.code) || "failed"), "err"); done(); });
  });

  $("ttsTestBtn").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    const typed = $("ttsKey").value.trim();
    if (!typed && !ttsStored[p.id]) { showTtsMsg(errText("noKey"), "err"); return; }
    const btn = $("ttsTestBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("byoTesting", "正在测试…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsMsg("", null);
    try {
      // First statement inside the gesture — see the header comment.
      chrome.permissions.request({ origins: [p.origin + "/*"] }, (granted) => {
        if (chrome.runtime.lastError || !granted) { done(); showTtsMsg(errText("noPerm"), "err"); return; }
        persistTts(p, typed)
          .then(() => sendToBackground({ type: "ttsTest" }))
          .then((resp) => {
            if (resp && resp.ok) {
              const kb = Math.max(1, Math.round((resp.bytes || 0) / 1024));
              showTtsMsg(tsub("ttsTestOk", [String(kb), voiceLabel(resp.voice || "")],
                "连接成功：试音 " + kb + " KB（" + (resp.voice || "") + "）"), "ok");
              // It already synthesized a real line; a byte count is a poor
              // substitute for hearing it.
              playPreview(resp);
            } else {
              showTtsMsg(errText(resp && resp.code), "err");
            }
          })
          .catch((err) => showTtsMsg(errText((err && err.code) || "failed"), "err"))
          .then(() => { paintTtsKeyField(p); paintTtsUse(); done(); },
                () => { paintTtsKeyField(p); paintTtsUse(); done(); });
      });
    } catch (_e) {
      done();
      showTtsMsg(errText("noPerm"), "err");
    }
  });
}

// ---- cross-page sync ---------------------------------------------------------
// This page is a long-lived tab and the popup writes the same sync keys — a
// switch flipped in the popup must not leave a stale one here (it did). One
// listener, per-key dispatch; a control already holding the new value is left
// alone, which also swallows the echo of this page's own writes. An unsaved
// key draft is never repainted away.
function initCrossPageSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.ttsKeys) {
          paintTtsUse();                       // a key appearing/vanishing flips the lock
          const p = ttsProvider();
          if (p && $("ttsKey") && !$("ttsKey").value) paintTtsKeyField(p);
        }
        return;
      }
      if (area !== "sync") return;
      const c = changes;
      if (c.ttsEnabled) {
        const en = $("ttsEnabled");
        const v = !!c.ttsEnabled.newValue;
        if (en && en.checked !== v) en.checked = v;
      }
      for (const id of ["ttsVolume", "ttsDuckPct"]) {
        if (!c[id]) continue;
        const r = $(id);
        const v = String(c[id].newValue);
        // A slider under the user's thumb is not repainted: the write that got
        // here is almost certainly its own echo, and yanking the knob mid-drag
        // makes the two pages fight (the region field guards the same way).
        if (r && r.value !== v && document.activeElement !== r) {
          r.value = v;
          const label = $(id + "V");
          if (label) label.textContent = v + "%";
        }
      }
      if (c.ttsProvider || c.ttsVoice) {
        if (c.ttsProvider) state.ttsProvider = String(c.ttsProvider.newValue || "");
        if (c.ttsVoice) state.ttsVoice = String(c.ttsVoice.newValue || "");
        // The dropdown means "the one I am setting up" — never drag it to the
        // one now in use. Doing that would strand a half-typed key under
        // another provider's name, and Save-and-test would store it there.
        const sel = $("ttsProviderSel");
        const shown = P.tts.get(sel && sel.value);
        if (shown && shown.id === state.ttsProvider && c.ttsVoice) paintTtsVoices(shown);
        paintTtsUse();
      }
      if (c.ttsRegion) {
        const r = $("ttsRegion");
        const v = String(c.ttsRegion.newValue || "");
        if (r && document.activeElement !== r && r.value !== v) r.value = v;
        paintTtsUse();          // a region is what unlocks Azure's playback half
      }
      if (c.targetLang) {
        const sel = $("startTargetSel");
        const v = String(c.targetLang.newValue || "");
        if (sel && sel.value !== v) sel.value = v;
        // …and the voice menu with it. Which voices apply depends on the
        // language: one fetched for Chinese stops applying the moment the
        // reader moves to Japanese, and the popup can move it while this page
        // is open. Updating only the dropdown left `state` on the old
        // language, so this page went on offering — and saving — a voice the
        // engine had already stopped using.
        if (v) state.targetLang = v;
        const shownTts = ttsProvider();
        if (shownTts) paintTtsVoices(shownTts);
      }
      if (c.byoProvider) {
        state.byoProvider = String(c.byoProvider.newValue || "");
        renderList();                          // the "in use" tag follows the popup's pick
      }
      if (c.langShown) {
        const next = c.langShown.newValue || null;
        if (JSON.stringify(next) !== JSON.stringify(langKept)) {
          langKept = next;
          renderLangs();
        }
      }
    });
  } catch (_e) { /* no listener = the page behaves as before */ }
}

// The start page's translation-target confirmation. The install hook guessed a
// target from the browser's preferred languages; this is where the guess is
// visible and one click from corrected. Full 50-language list — the popup's
// trimmed dropdown would hide exactly the language a mis-guessed user needs.
function initStartTarget() {
  const sel = $("startTargetSel");
  if (!sel) return;
  sel.textContent = "";
  for (const info of LANGS.all()) {
    const o = document.createElement("option");
    o.value = info.code;
    // The language's own name, same source as the popup's dropdown — one
    // setting must not have two names ("中文（简体）" here, not Intl's
    // country-flavored "中文（中国）").
    o.textContent = info.native || localName(info);
    sel.appendChild(o);
  }
  // A stored target this build has never heard of — a newer copy on another
  // machine picked one and sync brought the code over — is not in the list
  // above, and assigning it to a select that lacks it leaves the value empty.
  // Falling back to zh-CN there made this block state, in a sentence about what
  // the reader is going to get, a language that is not the one configured. It
  // did not change the setting, which is worse rather than better: someone who
  // reads "Chinese" and agrees walks away with something else in force.
  // Same answer as the popup's own list: label it with itself and let it be
  // chosen away deliberately.
  const want = state.targetLang || "zh-CN";
  sel.value = want;
  if (!sel.value) {
    const o = document.createElement("option");
    o.value = want;
    o.textContent = want;
    sel.appendChild(o);
    sel.value = want;
  }
  sel.addEventListener("change", () => {
    state.targetLang = sel.value;
    chrome.storage.sync.set({ targetLang: sel.value });
  });
}

// The interface-language picker. "auto" follows the browser; a concrete choice
// names each language in itself (Deutsch, 日本語…) so someone stranded in the
// wrong language can still find their own. Applying a change re-reads every
// string on the page — a reload is the one honest way to do that everywhere.
function initUiLocale() {
  const sel = $("uiLocaleSel");
  if (!sel) return;
  chrome.storage.sync.get({ uiLocale: "auto" }, (got) => {
    const cur = (got && got.uiLocale) || "auto";
    sel.textContent = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = t("uiLocaleAuto", "自动（跟随浏览器）");
    sel.appendChild(auto);
    for (const [id, name] of Object.entries(self.YTDS_I18N.SELF_NAMES)) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = name;
      sel.appendChild(o);
    }
    sel.value = self.YTDS_I18N.SELF_NAMES[cur] ? cur : "auto";
    sel.addEventListener("change", () => {
      chrome.storage.sync.set({ uiLocale: sel.value }, () => location.reload());
    });
  });
}

function wire() {
  document.querySelectorAll(".onav-item").forEach((b) =>
    b.addEventListener("click", () => showSection(b.dataset.sec)));
  $("startToSetup").addEventListener("click", () => showSection("setup"));
  $("langReset").addEventListener("click", () => {
    langKept = null;
    persistLangs();
    renderLangs();
    showLangMsg(t("langsResetDone", "已恢复默认列表。"), "ok");
  });
  window.addEventListener("hashchange", () => showSection(location.hash.slice(1)));

  $("modelSel").addEventListener("change", () => {
    const p = current();
    if (!p) return;
    const sel = $("modelSel");
    const input = $("modelInput");
    if (sel.value === CUSTOM_MODEL) {
      input.hidden = false;
      input.focus();
      return;
    }
    input.hidden = true;
    state.byoModel = sel.value;
    chrome.storage.sync.set({ byoModel: state.byoModel });
  });

  $("modelInput").addEventListener("change", (e) => {
    state.byoModel = e.target.value.trim();
    chrome.storage.sync.set({ byoModel: state.byoModel });
  });

  $("baseUrl").addEventListener("change", (e) => {
    state.byoBaseUrl = e.target.value.trim();
    chrome.storage.sync.set({ byoBaseUrl: state.byoBaseUrl });
  });

  $("showKey").addEventListener("change", (e) => {
    $("key").type = e.target.checked ? "text" : "password";
  });

  $("keyClear").addEventListener("click", async () => {
    const p = current();
    if (!p) return;
    await saveKey(p.id, null);
    markVerified(p.id, false);
    paintKeyField(p);
    renderList();
    showMsg(t("byoKeyCleared", "已清除本机保存的 Key。"), null);
  });

  $("testBtn").addEventListener("click", () => {
    withSetup($("testBtn"), "byoTesting", "测试中…",
      (code) => showMsg(errText(code), "err"), runTest);
  });

  $("fetchModels").addEventListener("click", () => {
    withSetup($("fetchModels"), "optFetching", "拉取中…",
      (code) => showModelMsg(errText(code), "err"), runFetchModels, false);
  });
}

// ---- boot ------------------------------------------------------------------
// i18n first: the override (if any) must be loaded before any string paints.
self.YTDS_I18N.init().then(() => {
applyI18n();
$("feedbackLink").href = SITE_URL + "feedback.html?lang=" + uiLang() + "&src=options";
initAbout();
showSection(location.hash.slice(1));

// Wired BEFORE the storage reads: the buttons are in the DOM from the first
// frame, and a click landing in the gap between paint and boot used to do
// nothing at all — no message, no state change. Handlers work off `state`, which
// starts empty, so an early click reports "pick a provider" instead of dying.
wire();

chrome.storage.sync.get(
  { byoProvider: "", byoModel: "", byoBaseUrl: "", targetLang: "zh-CN", langShown: null,
    byoModelBy: {}, ttsProvider: "local-speech", ttsVoice: "" },
  (got) => {
    state = Object.assign(state, got || {});
    modelsBy = Object.assign(Object.create(null), (got && got.byoModelBy) || {});
    // The active provider's model is authoritative for it — older profiles have
    // byoModel but no byoModelBy yet.
    if (state.byoProvider && state.byoModel && !modelsBy[state.byoProvider]) {
      modelsBy[state.byoProvider] = state.byoModel;
    }
    langKept = (got && Array.isArray(got.langShown) && got.langShown.length)
      ? LANGS.shown(got.langShown) : null;
    renderLangs();
    initStartTarget();
    initReadaloud();
    // Open on whatever is in use; failing that, the first preset — an empty
    // page on first open would be worse. Either way nothing is switched.
    editing = state.byoProvider;
    if (!current()) {
      const first = providerList()[0];
      if (first) editing = first.id;
    }
    chrome.storage.local.get({ byoKeys: {} }, (loc) => {
      for (const id of Object.keys((loc && loc.byoKeys) || {})) storedKeys[id] = true;
      renderList();
      renderDetail();
    });
    // After the first paint: every control below holds a value to compare with.
    initCrossPageSync();
  }
);
});                                // ← self.YTDS_I18N.init() gate around boot
