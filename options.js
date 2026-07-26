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

const t = (k, fb) => {
  try { return (chrome.i18n && chrome.i18n.getMessage(k)) || fb; }
  catch (_e) { return fb; }
};
const tsub = (k, subs, fb) => {
  try { return (chrome.i18n && chrome.i18n.getMessage(k, subs)) || fb; }
  catch (_e) { return fb; }
};

function uiLang() {
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
    if (ui.toLowerCase().indexOf("zh") === 0) return "zh";
  } catch (_e) { /* ignore */ }
  return "en";
}

let state = { byoProvider: "", byoModel: "", byoBaseUrl: "", targetLang: "zh-CN" };
const storedKeys = Object.create(null);     // providerId -> true (never the value)
const fetchedModels = Object.create(null);  // providerId -> [model ids]

const CUSTOM_MODEL = "__custom__";

// ---- i18n for static markup ------------------------------------------------
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const s = t(el.dataset.i18n, "");
    if (s) el.textContent = s;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const s = t(el.dataset.i18nAria, "");
    if (s) el.setAttribute("aria-label", s);
  });
  const title = t("optTitle", "");
  if (title) document.title = title + " — Dual Subtitles for YouTube";
}

// ---- provider helpers ------------------------------------------------------
function providerList() {
  return P.list.filter((p) => ALLOW_CUSTOM_ENDPOINT || !p.custom);
}

function current() {
  const p = P.get(state.byoProvider);
  if (!p) return null;
  return (ALLOW_CUSTOM_ENDPOINT || !p.custom) ? p : null;
}

function providerLabel(p) {
  return p.custom ? t("byoCustom", "自定义（OpenAI 兼容）") : p.name;
}

// ---- list ------------------------------------------------------------------
function renderList() {
  const ul = $("plist");
  ul.textContent = "";
  for (const p of providerList()) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pitem" + (p.id === state.byoProvider ? " on" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(p.id === state.byoProvider));
    btn.appendChild(ICONS.iconFor(p));

    const name = document.createElement("span");
    name.className = "pitem-name";
    name.textContent = providerLabel(p);
    btn.appendChild(name);

    if (storedKeys[p.id]) {
      const ok = document.createElement("span");
      ok.className = "pitem-ok";
      ok.textContent = "✓";
      ok.title = t("optConfigured", "已配置");
      btn.appendChild(ok);
    }

    btn.addEventListener("click", () => {
      if (state.byoProvider === p.id) return;
      state.byoProvider = p.id;
      state.byoModel = "";            // the new provider's own default applies
      chrome.storage.sync.set({ byoProvider: p.id, byoModel: "" });
      showMsg("", null);
      showModelMsg("", null);
      renderList();
      renderDetail();
    });
    li.appendChild(btn);
    ul.appendChild(li);
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
  add(state.byoModel);
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

  const saved = state.byoModel || p.defaultModel;
  const known = saved && choices.includes(saved);
  sel.value = known ? saved : CUSTOM_MODEL;
  sel.hidden = false;

  const typing = sel.value === CUSTOM_MODEL;
  input.hidden = !typing;
  input.value = typing ? (state.byoModel || "") : "";
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

function persist(pl) {
  state.byoProvider = pl.provider.id;
  state.byoModel = pl.model;
  state.byoBaseUrl = pl.baseUrl;
  // One set() so content.js re-cues once instead of three times.
  chrome.storage.sync.set({
    byoProvider: state.byoProvider,
    byoModel: state.byoModel,
    byoBaseUrl: state.byoBaseUrl
  });
  return pl.typedKey ? saveKey(pl.provider.id, pl.typedKey) : Promise.resolve();
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
function withSetup(btn, busyKey, busyFallback, onError, run) {
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
      persist(pl)
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
      showMsg(tsub("byoTestOk", [sample], "连接成功：" + sample), "ok");
    } else {
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
    const resp = await sendToBackground({ type: "byoModels" });
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
  if (location.hash.slice(1) !== sec) {
    // replace, not push: the section switch is not somewhere "back" should go.
    history.replaceState(null, "", "#" + sec);
  }
}

function initAbout() {
  const lang = uiLang();
  let ver = "";
  try { ver = chrome.runtime.getManifest().version; } catch (_e) { /* ignore */ }
  $("aboutVer").textContent = ver || "—";
  const set = (id, href) => { const el = $(id); if (el) el.href = href; };
  set("aboutSite", SITE_URL + "?src=options&lang=" + lang);
  set("aboutGithub", "https://github.com/Gythiro/yt-dual-subs");
  set("aboutChangelog", SITE_URL + "updated.html?lang=" + lang + "&src=options");
  set("aboutFeedback", SITE_URL + "feedback.html?lang=" + lang + "&src=options");
}

// ---- wiring ----------------------------------------------------------------
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
      (code) => showModelMsg(errText(code), "err"), runFetchModels);
  });
}

// ---- boot ------------------------------------------------------------------
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
  { byoProvider: "", byoModel: "", byoBaseUrl: "", targetLang: "zh-CN", langShown: null },
  (got) => {
    state = Object.assign(state, got || {});
    langKept = (got && Array.isArray(got.langShown) && got.langShown.length)
      ? LANGS.shown(got.langShown) : null;
    renderLangs();
    // Land on the first preset rather than an empty page on first open.
    if (!current()) {
      const first = providerList()[0];
      if (first) state.byoProvider = first.id;
    }
    chrome.storage.local.get({ byoKeys: {} }, (loc) => {
      for (const id of Object.keys((loc && loc.byoKeys) || {})) storedKeys[id] = true;
      renderList();
      renderDetail();
    });
  }
);
