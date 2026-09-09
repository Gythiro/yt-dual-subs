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

// Switched on for local model servers (issue #4): the manifest now declares
// the two loopback hosts, so http://localhost / http://127.0.0.1 endpoints are
// requestable; any other custom origin is unrequestable by design and runs
// under CORS instead (the server must allow this extension — Ollama's
// OLLAMA_ORIGINS, LM Studio's CORS toggle). Keep in step with popup.js.
const ALLOW_CUSTOM_ENDPOINT = true;

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
// providerId -> true once a Save-and-test passed (mirror of storage.local
// byoOk). For a keyless preset (Ollama) this is the only proof it is set up —
// keys alone left a tested Ollama with no ✓ in the list, ever.
const verifiedOk = Object.create(null);
const fetchedModels = Object.create(null);  // providerId -> [model ids]

// ---- fetched catalogues, kept across reloads -------------------------------
// A list pulled with the reader's own key used to live only as long as the
// page: closing the settings page or reloading it left the field empty again,
// with nothing to show for the round trip that had been paid for. It should
// still be there.
//
// storage.LOCAL, never sync: a custom endpoint can answer with a hundred model
// names, sync caps an item at 8KB and the whole area at 100KB, and a list is
// in any case a property of THIS machine's key and endpoint — the model the
// reader picked is what deserves to travel, and that already syncs.
//
// The cache key carries everything the list depends on: the provider, the
// endpoint it came from (a custom server swapped for another must not show the
// old server's models) and a fingerprint of the key (a key swapped for one with
// different permissions must not show what the old one could reach). The
// fingerprint is computed in the worker; this page never sees a key.
//
// No expiry. A model catalogue is not a price feed, and a list that vanished
// on a timer would be the same complaint again. The fetch button is the only
// thing that writes — which is also what stops us from spending someone's
// quota on a page load.
const CATALOG_STORE = "byoCatalogs";
let catalogs = Object.create(null);

// The key, the normalisation and the "which stored list belongs to the key and
// endpoint in force" decision all live in providers.js now — the popup reads
// these same entries to fill its model menu, and a key spelled differently on
// the two sides is a cache the reader can see on one page and not the other.
const catalogKey = (kind, providerId, forBase, forKey) =>
  self.YTDS_CATALOG.key(kind, providerId, forBase, forKey);

// Bring back what this provider's key and endpoint fetched last time. Asks
// the worker which endpoint and key are in force (as a fingerprint), then
// looks for a catalogue stored under exactly that combination — so a swapped
// server or a swapped key restores nothing rather than something misleading.
// Silent by design: a miss just means the fetch button is still there.
async function catalogRestore(kind, providerId, apply) {
  const tag = await sendToBackground({ type: "catalogTag",
    kind: kind === "m" ? "byo" : "tts", provider: providerId }).catch(() => null);
  if (!tag || !tag.ok) return false;
  const hit = catalogs[catalogKey(kind, providerId, tag.forBase, tag.forKey)];
  if (!hit || !hit.items || !hit.items.length) return false;
  apply(hit.items, hit.names || null);
  return true;
}

function catalogSave(kind, providerId, resp, items, names) {
  const key = catalogKey(kind, providerId, resp && resp.forBase, resp && resp.forKey);
  catalogs[key] = { items: items || [], names: names || null };
  // Failure here is not worth a message: the list is on screen either way, and
  // the only loss is having to fetch again next time.
  try { chrome.storage.local.set({ [CATALOG_STORE]: catalogs }); } catch (_e) { /* ignore */ }
}
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
  const title = t("optTitle", "翻译服务设置");
  if (title) document.title = title + " — " + t("extName", "Dual Subtitles for YouTube™");
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
// Which pane the list is serving. It began as the translation pane's own
// navigation; read-aloud had a dropdown for the same job, which meant the same
// question wore two shapes, and only one of them could show a key tick or say
// which provider is in use (asked for on 2026-08-30: "the provider choice in
// options should look the same as translation's").
let listSec = "setup";

// What the list is a list OF, and what each row has to say about a provider:
// which ones can be set up, which have a key stored, which one is in use, and
// what a click on one means. Everything below is written once against this.
function listMode() {
  if (listSec === "readaloud") {
    return {
      items: P.tts.list,
      stored: ttsStored,
      inUse: () => state.ttsProvider,
      label: (p) => (p.nameKey ? t(p.nameKey, p.name) : p.name),
      open: () => ttsProvider(),
      // Same contract as the translation half: a click changes what you are
      // SETTING UP, never what is speaking. Save-and-test is what switches.
      pick: (p) => {
        const sel = $("ttsProviderSel");
        if (!sel || sel.value === p.id) return;
        sel.value = p.id;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
  }
  return {
    items: providerList(),
    stored: storedKeys,
    inUse: () => state.byoProvider,
    label: providerLabel,
    open: () => P.get(editing),
    pick: (p) => {
      if (editing === p.id) return;
      editing = p.id;                 // set it up; nothing switches yet
      showMsg("", null);
      showModelMsg("", null);
      renderList();
      renderDetail();
    }
  };
}

function renderList() {
  const ul = $("plist");
  ul.textContent = "";
  let openTabId = "";
  const mode = listMode();
  const openNow = mode.open();
  const openId = openNow ? openNow.id : "";
  for (const p of mode.items) {
    const li = document.createElement("li");
    // The <ul> is the tablist; a tablist owns tabs. Leaving the wrappers as
    // listitems puts a role that is not "tab" between the two, so the tabs
    // stop being owned and the "3 of 12" a reader announces comes from
    // nowhere. popup's #lineTabs has no wrappers at all; here the bullets are
    // load-bearing for layout, so they say they are scaffolding instead.
    li.setAttribute("role", "presentation");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pitem" + (p.id === openId ? " on" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(p.id === openId));
    // Same three-part pattern popup uses for #lineTabs: the tab has an id, it
    // names the panel it opens, and the panel names it back (below). Provider
    // ids are the ASCII slugs in providers.js, so they make legal id values.
    btn.id = "ptab-" + p.id;
    btn.setAttribute("aria-controls", "detail");
    if (p.id === openId) openTabId = btn.id;
    btn.appendChild(ICONS.iconFor(p));

    const name = document.createElement("span");
    name.className = "pitem-name";
    name.textContent = mode.label(p);
    btn.appendChild(name);

    // Which one the extension is actually translating with — the thing the
    // highlight used to imply and no longer does.
    if (p.id === mode.inUse()) {
      const inUse = document.createElement("span");
      inUse.className = "pitem-inuse";
      inUse.textContent = t("optInUse", "使用中");
      btn.appendChild(inUse);
    } else if (mode.stored[p.id] || (p.noKey && verifiedOk[p.id])) {
      const ok = document.createElement("span");
      ok.className = "pitem-ok";
      ok.textContent = "✓";
      ok.title = t("optConfigured", "已配置");
      btn.appendChild(ok);
    }

    btn.addEventListener("click", () => mode.pick(p));
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
    showModelMsg(t("optNoModelsYet", "还没有模型列表——用你的 Key 拉一份，或者直接手填。"), null);
  }
}

function showModelMsg(text, kind) {
  const el = $("modelMsg");
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

// The first-run nag names the thing actually missing: a key for the named
// providers, the endpoint address for the custom one — custom has no key to
// miss (Ollama / LM Studio ignore auth; resolveByo sends none), so nagging it
// about a key is false in both directions.
function paintNeedBanner(p, hasKey) {
  const el = $("needKey");
  if (p.noKey) {
    // Nothing to fill in: the address ships with the provider and the server
    // it points at does not authenticate. Saying "no key yet" here would be
    // telling the reader to go and find something that does not exist.
    el.hidden = true;
    return;
  }
  if (p.custom) {
    el.textContent = t("optNeedBase", "还没填接口地址，这个服务商暂时用不了。");
    el.hidden = !!(state.byoBaseUrl && state.byoBaseUrl.trim());
  } else {
    el.textContent = t("optNeedKey", "还没填 Key，这个服务商暂时用不了。");
    el.hidden = hasKey;
  }
}

// ---- key field -------------------------------------------------------------
// Both key fields, one rule: the "show" control belongs to a draft, not to a
// saved key. Called on every repaint and on every keystroke.
function paintShowKey(inputId, wrapId) {
  const inp = $(inputId);
  const wrap = $(wrapId);
  if (!inp || !wrap) return;
  const draft = !!inp.value;
  wrap.hidden = !draft;
  if (!draft) {
    const box = wrap.querySelector("input[type=\"checkbox\"]");
    if (box && box.checked) { box.checked = false; inp.type = "password"; }
  }
}

// "When you are done here, switch the popup's engine over" is a to-do. Once the
// popup IS on the own-key engine it has been done, and a permanent line under
// the primary button is telling the reader to do something they already did.
// Read only — writing `engine` from this page was ruled out (HCI audit §五).
function paintAfterSetupNote(engine) {
  const el = $("optAfterSetup");
  if (el) el.hidden = engine === "byo";
}

function paintKeyField(p) {
  const inp = $("key");
  const clear = $("keyClear");
  inp.value = "";
  inp.type = $("showKey").checked ? "text" : "password";
  // Nothing typed yet, and a saved key is never written back here — so there is
  // nothing "show" could reveal. It comes back the moment there is a draft.
  paintShowKey("key", "showKeyWrap");
  inp.placeholder = p.kind === "deepl" ? "xxxxxxxx-xxxx-…:fx" : "sk-…";
  clear.hidden = true;

  chrome.storage.local.get({ byoKeys: {} }, (got) => {
    const key = ((got && got.byoKeys) || {})[p.id] || "";
    storedKeys[p.id] = !!key;
    // The one thing a first-time visitor has to notice.
    paintNeedBanner(p, !!key);
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
  // The guide's sections are named after the provider, except the custom one:
  // there is no #custom section and never was, so choosing it and pressing
  // "see the guide" landed at the top of the page. What that reader wants is
  // the local-model walkthrough — which is what a custom endpoint is for in
  // nine cases out of ten, and which is where the CORS line everybody trips
  // over is written down.
  $("pGuideLink").href = SITE_URL + "guide.html?lang=" + uiLang() +
    "#" + (p.guideAnchor || (p.custom ? "local" : p.id));

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

function errText(code, provider) {
  return t(P.errorKey(code, provider), t("byoErrFailed", "连接失败，稍后再试。"));
}

// The same 401 means two different things depending on when it arrives.
// Saving a key: it is probably mistyped or not active yet — what byoErrAuth
// says. Fetching a LIST after the key already synthesised a sample: the key
// works, so the refusal is about what this key is allowed to read. ElevenLabs
// keys are per-endpoint (a key can hold "Text to Speech: Access" and "Voices:
// No Access", which is exactly the combination that produced this), OpenAI's
// are per-scope. Telling that user to check they copied the key in full sends
// them to re-paste a key that was never wrong.
function listErrText(code) {
  if (code === "auth" || code === "noPerm") {
    return t("byoErrListAuth",
      "这把 Key 没有「读取清单」的权限。去服务商后台给它加上，再拉一次。");
  }
  return errText(code);
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
  // Resolve only when the write has COMMITTED (the set callback), not when it
  // was fired. The probe that follows this promise reads storage in the
  // worker; a fire-and-forget set let that read land on yesterday's model —
  // the first Save-and-test after a switch failed, the second passed
  // (reported 2026-09-01 with an Ollama 404).
  return new Promise((resolve) =>
    chrome.storage.sync.set({ byoModelBy: Object.assign({}, modelsBy) }, resolve)
  ).then(() => (pl.typedKey ? saveKey(pl.provider.id, pl.typedKey) : undefined));
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
  // One set() so content.js re-cues once instead of three times — and awaited
  // to its callback, so the caller's .then() means "on disk", not "requested"
  // (same commit-before-probe bargain as persistForProvider above).
  return new Promise((resolve) =>
    chrome.storage.sync.set({
      byoProvider: state.byoProvider,
      byoModel: state.byoModel,
      byoBaseUrl: state.byoBaseUrl,
      byoModelBy: Object.assign({}, modelsBy)
    }, resolve)
  ).then(() => (pl.typedKey ? saveKey(pl.provider.id, pl.typedKey) : undefined));
}

// Which providers have answered a real request, so the popup can say which of
// the saved keys is known to work rather than just "saved".
function markVerified(id, ok) {
  // The in-page mirror first: for a keyless preset the list's ✓ hangs on this
  // (storedKeys never lights for it), so the row must not wait on storage.
  if (ok) verifiedOk[id] = true; else delete verifiedOk[id];
  renderList();
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
  // A custom endpoint is allowed to have no key at all — Ollama and LM Studio
  // ignore auth; the worker sends no Authorization header for an empty key.
  if (!pl.typedKey && !storedKeys[pl.provider.id] &&
      !pl.provider.custom && !pl.provider.noKey) { onError("noKey"); return; }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t(busyKey, busyFallback);
  const done = () => { btn.disabled = false; btn.textContent = label; };

  const proceed = () => {
    (adopt === false ? persistForProvider(pl) : persist(pl))
      .then(() => run(pl))
      // A rejection here would otherwise be swallowed and read as a no-op.
      .catch((err) => onError((err && err.code) || "failed"))
      .then(done, done);
  };

  // A custom origin outside the manifest's declared list (a tunnel domain)
  // cannot be granted, ever — Chrome refuses the request, sometimes by
  // throwing before the callback exists. That must not dead-end the flow: the
  // worker will still try the fetch under CORS (the server's own consent).
  // Loopback origins ARE declared, so a named provider's refusal still counts.
  try {
    chrome.permissions.request({ origins: pl.origins }, (granted) => {
      if ((chrome.runtime.lastError || !granted) && !pl.provider.custom) {
        done(); onError("noPerm"); return;
      }
      proceed();
    });
  } catch (_e) {
    if (pl.provider.custom) { proceed(); return; }
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
      showMsg(errText(resp && resp.code, pl.provider), "err");
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
      catalogSave("m", pl.provider.id, resp, resp.models, null);
      renderModelField(pl.provider);
      showModelMsg(tsub("optModelsFetched", [String(resp.models.length)],
        "拉到 " + resp.models.length + " 个模型"), "ok");
    } else {
      showModelMsg(resp && resp.code
        ? listErrText(resp.code)
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
  // The list serves both panes that choose a provider — it is their
  // navigation, not the page's, so the other three panes still hide it.
  listSec = sec;
  $("plistWrap").hidden = sec !== "setup" && sec !== "readaloud";
  if (!$("plistWrap").hidden) renderList();
  if (sec === "readaloud") ttsKeysRefresh();
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
  if (heading) document.title = heading + " — " + t("extName", "Dual Subtitles for YouTube™");
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

// Chrome's own shortcuts page. A plain <a href> to a chrome:// URL is refused
// by the browser, so the door has to be a button that asks tabs.create — and
// because that route is the browser's to allow, the button says so when it is
// turned away instead of looking like a dead control. Nothing else on this
// page can open it, so the address is spelled out in that message: it is the
// one place a viewer can still get there by hand.
const SHORTCUTS_URL = "chrome://extensions/shortcuts";

function openShortcutsPage() {
  const fail = $("optShortcutsFail");
  const refused = () => { if (fail) fail.hidden = false; };
  if (fail) fail.hidden = true;
  try {
    chrome.tabs.create({ url: SHORTCUTS_URL }, () => {
      // lastError must be read inside the callback or Chrome logs it as
      // unchecked; it is also the only signal that the tab was refused.
      if (chrome.runtime.lastError) refused();
    });
  } catch (_e) {
    refused();
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
  const keys = $("optShortcuts");
  if (keys) keys.addEventListener("click", openShortcutsPage);
}

// ---- wiring ----------------------------------------------------------------
// ---- read-aloud (TTS) setup -------------------------------------------------
// The pipeline's user half: pick a provider, store a key (masked ever after),
// pick a voice, save-and-test. Mirrors the translation setup's discipline —
// permissions.request is the FIRST thing in the click handler (any await ahead
// of it silently spends the user gesture), the key never rides back into the
// DOM, and the test exercises the stored configuration, not the draft.
const ttsStored = Object.create(null);      // providerId -> true (never the key)

// Every read-aloud provider's key state in one read. paintTtsKeyField only
// ever learned about the provider it was painting, so the list's ticks
// appeared one at a time as rows were clicked — a list that tells you what is
// configured only after you have visited each row tells you nothing.
function ttsKeysRefresh() {
  chrome.storage.local.get({ ttsKeys: {} }, (got) => {
    const keys = (got && got.ttsKeys) || {};
    for (const p of P.tts.list) ttsStored[p.id] = !!keys[p.id];
    // The custom entry is configured by its ADDRESS, not a key — read it after
    // the loop above so the key sweep cannot clobber the answer.
    chrome.storage.sync.get({ ttsBaseUrl: "" }, (sy) => {
      ttsStored["custom-speech"] = ttsStored["custom-speech"] ||
        !!P.parseCustomBase((sy && sy.ttsBaseUrl) || "");
      if (listSec === "readaloud") renderList();
    });
    if (listSec === "readaloud") renderList();
  });
}

function ttsProvider() {
  return P.tts.get($("ttsProviderSel").value) || null;
}

function showTtsMsg(text, kind) {
  const el = $("ttsMsg");
  el.textContent = text || "";
  el.className = "omsg" + (kind ? " " + kind : "");
  el.hidden = !text;
}

// Whose page this is, and where its key comes from — the same three answers
// the translation pane puts at the top of its column.
function paintTtsHead(p) {
  const slot = $("ttsIcon");
  if (slot) {
    slot.textContent = "";
    if (self.YTDS_ICONS && p) slot.appendChild(ICONS.iconFor(p));
  }
  const name = $("ttsPName");
  if (name && p) name.textContent = (p.nameKey ? t(p.nameKey, p.name) : p.name);
  const keyLink = $("ttsKeyLink");
  if (keyLink) {
    keyLink.hidden = !(p && p.keyUrl);
    if (p && p.keyUrl) keyLink.href = p.keyUrl;
  }
  const priceLink = $("ttsPricingLink");
  if (priceLink) {
    priceLink.hidden = !(p && p.pricingUrl);
    if (p && p.pricingUrl) priceLink.href = p.pricingUrl;
  }
  // The guide has one read-aloud section, not one per provider.
  const guide = $("ttsGuideLink");
  if (guide) guide.href = SITE_URL + "guide.html?lang=" + uiLang() + "&src=options#readaloud";
}

function paintTtsKeyField(p) {
  const inp = $("ttsKey");
  const clear = $("ttsKeyClear");
  inp.value = "";
  inp.type = $("ttsShowKey").checked ? "text" : "password";
  paintShowKey("ttsKey", "ttsShowKeyWrap");
  inp.placeholder = p.keyHint != null ? p.keyHint : "sk-…";
  clear.hidden = true;
  // Azure's key is bound to a region that becomes the request host; only a
  // provider that says so gets the field.
  const regionRow = $("ttsRegionRow");
  if (regionRow) regionRow.hidden = !p.needsRegion;
  // The custom server's address, in the same seat the translation pane gives
  // its sibling. The draft in the field survives repaints (same guard the
  // region field uses: never yank what the user is typing).
  const urlRow = $("ttsBaseUrlRow");
  if (urlRow) {
    urlRow.hidden = !p.custom;
    const urlInp = $("ttsBaseUrl");
    if (p.custom && urlInp && document.activeElement !== urlInp && !urlInp.value) {
      chrome.storage.sync.get({ ttsBaseUrl: "" }, (got) => {
        if (document.activeElement !== urlInp && !urlInp.value) {
          urlInp.value = (got && got.ttsBaseUrl) || "";
        }
      });
    }
  }
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
// Names a provider gave us for ids that carry none of their own. ElevenLabs
// ids are twenty opaque characters; the service knows them as Rachel and Josh,
// and it says so in the same reply that lists them. Session-scoped like
// fetchedVoices: the built-in family is the durable answer.
const fetchedVoiceNames = Object.create(null);

function voiceLabel(v) {
  if (fetchedVoiceNames[v]) return fetchedVoiceNames[v];
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

// Retries for an empty local list, cleared whenever one paints non-empty.
let localVoiceRetry = 0;
let localVoiceTimer = 0;

// Hoisted out of initReadaloud: the voice painter needs it too, and it closes
// over nothing.
function showTtsVoiceMsg(text, kind) {
  const el = $("ttsVoiceMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "ohint" + (kind ? " " + kind : "");
  el.hidden = !text;
}

function paintTtsVoices(p) {
  const sel = $("ttsVoiceSel");
  sel.textContent = "";
  // A custom server rarely publishes a voice list, so the menu gives way to a
  // typed name — the user's word is the authority there (ttsVoiceOwned says
  // the same). The select never paints for it, and everything below that
  // dresses the select is skipped.
  const typedInp = $("ttsVoiceInput");
  if (typedInp) typedInp.hidden = !p.custom;
  sel.hidden = !!p.custom;
  if (p.custom) {
    if (typedInp && document.activeElement !== typedInp && !typedInp.value) {
      typedInp.value = state.ttsVoice || "";
    }
    showTtsVoiceMsg("", null);
    const preview = $("ttsPreview");
    if (preview) preview.disabled = false;
    const row = $("ttsFetchRow");
    if (row) row.hidden = true;
    const keyField = $("ttsKey");
    if (keyField) {
      const field = keyField.closest(".ofield");
      if (field) field.hidden = false;
    }
    const testBtn = $("ttsTestBtn");
    if (testBtn) testBtn.hidden = false;
    return;
  }
  const choices = p.localVoices
    ? localVoicesFor(state.targetLang) : ttsVoiceChoices(p);
  // An empty list for the browser's own voices is almost never the truth. It
  // means Chrome has not built its voice table YET: getVoices() answers with
  // an empty array until it has, and announces it with voiceschanged — but
  // only if the table was not ALREADY built when we asked. Open this page with
  // the default provider selected and the event never comes: measured on a
  // real machine, 0 voices at load and 199 a moment later, with the menu still
  // empty because nothing repainted. Reported as "the browser built-in one
  // cannot be chosen at all".
  //
  // So the painter heals itself rather than trusting one event or one poll at
  // startup: whenever it draws an empty local list, it tries again shortly.
  // That covers the cold page, a provider switched while still cold, and a
  // voice pack that finishes installing later.
  // Whether this machine, after every retry, really has nothing to speak with.
  // Until the retries are spent an empty list means "not built yet", which is
  // why this cannot simply be `!choices.length`.
  if (p.localVoices && choices.length && localVoicesGone) {
    localVoicesGone = false;
    paintTtsUse();
  }
  if (p.localVoices && !choices.length && localVoiceRetry < 8) {
    localVoiceRetry++;
    clearTimeout(localVoiceTimer);
    localVoiceTimer = setTimeout(() => {
      const now = ttsProvider();
      if (now && now.localVoices) paintTtsVoices(now);
    }, 120 * localVoiceRetry);
    // …and say so. An empty dropdown on the engine that needs no key at all is
    // read as "this is broken" — the comment above says as much, and until now
    // nothing on screen said otherwise.
    showTtsVoiceMsg(t("ttsVoicesLoading", "正在读取这台电脑的音色…"), null);
  } else if (p.localVoices && !choices.length) {
    // Out of tries: this machine really has none. Do NOT let Preview run into
    // its own failure text, which talks about keys this engine never had — and
    // do not leave the switch below looking ready, because turning it on would
    // buy silence with no explanation.
    showTtsVoiceMsg(t("ttsNoSynth", "这台电脑没有可用的朗读音色。"), "warn");
    if (!localVoicesGone) { localVoicesGone = true; paintTtsUse(); }
  } else if (choices.length) {
    localVoiceRetry = 0;
    if (p.localVoices) showTtsVoiceMsg("", null);
  }
  const preview = $("ttsPreview");
  if (preview) preview.disabled = p.localVoices && !choices.length;
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
      const tier = P.tts.voiceTier(v, p);       // "" for providers whose ids carry none
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
  } else if (p.localVoices) {
    // Ordinary voices in the open, the machine packs at the bottom under
    // their own heading — the maintainer's call; single source in providers.js so the
    // popup renders the identical shape.
    const split = P.tts.localVoiceSplit(window.speechSynthesis, state.targetLang);
    split.normal.forEach((v) => add(sel, v));
    if (split.machine.length) {
      const g = document.createElement("optgroup");
      g.label = t("ttsRobotVoices", "机器音");
      split.machine.forEach((v) => add(g, v));
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
  // The typed name IS the choice for a custom server — there is no menu to
  // disagree with it.
  if (p && p.custom) {
    const inp = $("ttsVoiceInput");
    return inp ? inp.value.trim() : (state.ttsVoice || "");
  }
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
// Not a boolean any more: three different things lock this half, and the banner
// above it was telling all three "no key yet" — including Azure, where the key
// IS there and the region is not, and the browser's own engine, where there is
// no key field to fill in the first place. Returns "" when nothing is wrong.
// Set by the voice painter once its retries are spent on an empty machine, and
// cleared the moment voices do arrive. ttsLock cannot work this out itself: the
// table is built asynchronously and is empty for the first few hundred
// milliseconds of every cold page.
let localVoicesGone = false;

function ttsLock() {
  const p = P.tts.get(state.ttsProvider || "");
  if (!p) return Promise.resolve("noKey");
  // Mirrors popup.js ttsUsable: a browser without speechSynthesis cannot be
  // offered the engine that depends on it — and a browser that has it but no
  // voices installed cannot either.
  if (p.localVoices) {
    if (typeof speechSynthesis === "undefined") return Promise.resolve("noSynth");
    return Promise.resolve(localVoicesGone ? "noSynth" : "");
  }
  return new Promise((res) => {
    chrome.storage.sync.get({ ttsRegion: "" }, (sy) => {
      // Azure's key is bound to a region that becomes the request host, and the
      // key is stored before the test runs — so "has a key" can still mean
      // "cannot speak a single line". That is the case the banner used to
      // answer with "no key yet".
      if (p.needsRegion &&
          !TTS_REGION_OK.test(String((sy && sy.ttsRegion) || "").trim().toLowerCase())) {
        return res("noRegion");
      }
      if (p.keyless) return res("");
      // The custom server unlocks on its ADDRESS: an empty key is a valid
      // configuration there (no Authorization header), so the key check below
      // must never be the thing that keeps the switch locked.
      if (p.custom) {
        return chrome.storage.sync.get({ ttsBaseUrl: "" }, (g2) => {
          res(P.parseCustomBase((g2 && g2.ttsBaseUrl) || "") ? "" : "noUrl");
        });
      }
      chrome.storage.local.get({ ttsKeys: {} }, (got) => {
        res(((got && got.ttsKeys) || {})[p.id] ? "" : "noKey");
      });
    });
  });
}

const TTS_LOCK_KEYS = {
  noKey: ["optNeedKey", "还没填 Key，这个服务商暂时用不了。"],
  noUrl: ["optTtsNeedUrl", "还没填接口地址，这个服务商暂时用不了。"],
  noRegion: ["ttsErrNoRegion", "先填你 Azure Key 所在的服务区域（如 eastus）再测通。"],
  noSynth: ["ttsNoSynth", "这台电脑没有可用的朗读音色。"]
};

// Which paint is the latest. ttsLock reads storage twice, so two quick
// switches (or a popup write arriving mid-read) can resolve out of order and
// leave the older answer on screen — a ready provider shown as locked, or the
// other way round.
let ttsUseGen = 0;

function paintTtsUse() {
  const use = $("ttsUse");
  if (!use) return;
  const gen = ++ttsUseGen;
  ttsLock().then((why) => {
    if (gen !== ttsUseGen) return;
    const ready = !why;
    const banner = $("ttsNeedKey");
    if (banner) {
      banner.hidden = ready;
      // Say which of the three it is. Whatever is missing, this names it — the
      // reader was previously sent looking for a key field that either already
      // held a key or did not exist.
      if (!ready) {
        const pair = TTS_LOCK_KEYS[why] || TTS_LOCK_KEYS.noKey;
        banner.textContent = t(pair[0], pair[1]);
      }
    }
    use.classList.toggle("locked", !ready);
    for (const id of ["ttsEnabled", "ttsVolume", "ttsDuckPct"]) {
      const el = $(id);
      if (el) el.disabled = !ready;
    }
  });
}

// The read-aloud model picker: shown only for providers that document more
// than one speech model. The stored override lives per provider (ttsModelBy,
// the byoModelBy shape) so switching providers never bleeds a model across.
function paintTtsModel(p) {
  const row = $("ttsModelRow");
  if (!row) return;
  // The custom entry documents no models but its servers still read the
  // field, so it gets the free entry (defaulting to the OpenAI-compat "tts-1").
  const has = !!(p && ((p.models && p.models.length) || p.custom));
  row.hidden = !has;
  if (!has) return;
  const sel = $("ttsModelSel"), inp = $("ttsModelInput");
  sel.textContent = "";
  for (const m of p.models) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL;
  customOpt.textContent = t("optModelCustom", "自定义…");
  sel.appendChild(customOpt);
  chrome.storage.sync.get({ ttsModelBy: {} }, (got) => {
    const m = ((got && got.ttsModelBy) || {})[p.id] || p.defaultModel || "";
    if (p.models.indexOf(m) >= 0) { sel.value = m; inp.hidden = true; inp.value = ""; }
    else { sel.value = CUSTOM_MODEL; inp.hidden = false; inp.value = m; }
  });
}
function writeTtsModel(p, m) {
  chrome.storage.sync.get({ ttsModelBy: {} }, (got) => {
    const map = Object.assign({}, (got && got.ttsModelBy) || {});
    const v = String(m || "").trim();
    // The default needs no entry — an empty map is the "never touched" state,
    // and stale overrides are what this delete is for.
    if (!v || v === p.defaultModel) delete map[p.id];
    else map[p.id] = v;
    chrome.storage.sync.set({ ttsModelBy: map });
  });
}

function initReadaloud() {
  const sel = $("ttsProviderSel");
  if (!sel) return;
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
  const complete = $("ttsComplete");
  if (complete) {
    chrome.storage.sync.get({ ttsComplete: false }, (got) => {
      complete.checked = !!(got && got.ttsComplete);
    });
    complete.addEventListener("change", () => {
      chrome.storage.sync.set({ ttsComplete: complete.checked });
    });
  }
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
    // The one voice family Chinese listeners rate above the global engines
    // says so — but only when Chinese is what is being READ (the target
    // language, never the UI locale: an English UI reading zh still wants it).
    o.textContent = (p.id === "qwen-tts" && /^zh\b/i.test(state.targetLang || ""))
      ? p.name + " · " + t("provTtsZhReco", "中文推荐")
      : p.name;
    sel.appendChild(o);
  }
  const cur = P.tts.get(state.ttsProvider) || P.tts.list[0];
  sel.value = cur.id;
  paintTtsHead(cur);
  paintTtsKeyField(cur);
  paintTtsVoices(cur);
  paintTtsModel(cur);
  paintTtsUse();
  ttsKeysRefresh();

  // Put back the language catalogue this key fetched last time, if it was for
  // the language in force now. The built-in family paints first and stays if
  // there is nothing stored — so this can only ever add, never blank a list.
  // (The machine's own voices are excluded on purpose: they come from the OS
  // and are asked for fresh every time, being both free to read and liable to
  // change under us.)
  if (!cur.localVoices) {
    catalogRestore("v " + (state.targetLang || ""), cur.id, (items, names) => {
      const now = P.tts.get(state.ttsProvider) || P.tts.list[0];
      if (!now || now.id !== cur.id) return;      // moved on while we asked
      for (const k in (names || {})) fetchedVoiceNames[k] = names[k];
      fetchedVoices[cur.id] = items;
      voiceCatalogue = "language";
      paintTtsVoices(cur);
    });
  }

  // The machine's voice table is not ready when this page paints: the first
  // synchronous getVoices() returns an empty array in every Chrome, and the
  // list announces itself afterwards. Painting once left the DEFAULT engine
  // with an empty picker — the one screen where "no voices" reads as "this
  // feature is broken" rather than "this provider has none".
  const synth = window.speechSynthesis;
  // Listening is not enough. Chrome answers getVoices() with an empty array
  // until its table is built and announces it with voiceschanged — but ONLY if
  // the table was not already built when we asked. Open this page a second
  // time, or open it after anything else has warmed the engine, and the event
  // never comes: the picker for the engine everybody starts on stays empty and
  // there is nothing to select. Reported from a real machine as "the browser
  // built-in one cannot be chosen at all". So ask again, a few times, briefly.
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
    paintTtsHead(p);
    paintTtsKeyField(p);
    paintTtsVoices(p);
    paintTtsModel(p);
    renderList();          // the highlight on the left follows the draft
  });
  $("ttsModelSel").addEventListener("change", () => {
    const p = ttsProvider();
    if (!p) return;
    const inp = $("ttsModelInput");
    if ($("ttsModelSel").value === CUSTOM_MODEL) {
      inp.hidden = false;
      inp.focus();
      return;                        // stored when the typed name lands below
    }
    inp.hidden = true;
    writeTtsModel(p, $("ttsModelSel").value);
  });
  $("ttsModelInput").addEventListener("change", () => {
    const p = ttsProvider();
    if (p) writeTtsModel(p, $("ttsModelInput").value);
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
    if (!synth) { showTtsMsg(t("ttsPreviewFail", "播不出来——检查 Key，或先「保存并测通」"), "err"); return; }
    try { synth.cancel(); } catch (_e) { /* ignore */ }
    const lang = state.targetLang || "zh-CN";
    const u = new SpeechSynthesisUtterance(
      (LANGS && LANGS.sample ? LANGS.sample(lang) : "") || "Hello.");
    u.lang = lang;
    const v = (synth.getVoices() || []).find((x) => x && x.name === voiceName);
    if (v) u.voice = v;
    try { synth.speak(u); } catch (_e) {
      showTtsMsg(t("ttsPreviewFail", "播不出来——检查 Key，或先「保存并测通」"), "err");
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
        showTtsMsg(t("ttsPreviewFail", "播不出来——检查 Key，或先「保存并测通」"), "err");
        cleanup();
      });
      previewAudio.play().catch(() => {
        showTtsMsg(t("ttsPreviewFail", "播不出来——检查 Key，或先「保存并测通」"), "err");
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

  $("ttsFetchVoices").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    if (!ttsStored[p.id] && !p.keyless) { showTtsMsg(errText("noKey"), "err"); return; }
    const btn = $("ttsFetchVoices");
    const label = t("ttsFetchVoices", "用你的 Key 拉取这个语言的完整音色清单");
    btn.disabled = true;
    btn.textContent = t("ttsFetching", "拉取中…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsVoiceMsg("", null);
    // Which provider and which language, same as the two probe buttons: this
    // button had the same two races and got neither fix at the time.
    sendToBackground({ type: "ttsVoices", provider: p.id, targetLang: state.targetLang })
      .then((resp) => {
        if (!resp || !resp.ok) {
          // Falling back to the built-in family is the honest failure: a voice
          // list is not something a user can type in by hand.
          showTtsVoiceMsg(listErrText(resp && resp.code), "err");
          done();
          return;
        }
        // Exact-string filtering kept "cmn-CN-Chirp3-HD-Achernar" alongside the
        // "Achernar" already on offer — the same voice twice, thirty times over.
        const extra = P.tts.mergeFetched(p, resp.voices);
        for (const k in (resp.names || {})) fetchedVoiceNames[k] = resp.names[k];
        fetchedVoices[p.id] = extra;
        // Pinned to the LANGUAGE it was fetched for, so that rides in the key
        // too — a Chinese catalogue must not be handed back for Japanese.
        catalogSave("v " + (state.targetLang || ""), p.id, resp, extra, resp.names);
        if (extra.length) voiceCatalogue = "language";
        paintTtsVoices(p);
        // Say what changed and what it costs, not "more". These voices work for
        // the language they were fetched for and no other.
        showTtsVoiceMsg(extra.length
          ? tsub("ttsVoicesSwitched", [String(extra.length)],
            "这是你的 Key 在当前语言下的全部 " + extra.length + " 个音色,只对这个语言生效;点上面那行换回常用音色。")
          : t("ttsVoicesNone", "这家在这个语言下没有额外音色——内置的那些照样能用。"), extra.length ? "ok" : null);
        done();
      })
      .catch((err) => { showTtsVoiceMsg(listErrText((err && err.code) || "failed"), "err"); done(); });
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
    // Say WHICH provider and WHICH language, rather than letting the worker
    // read them back out of storage. The provider dropdown does not write on
    // change at all, and the language one writes on a different async path
    // from this message — so the worker used to answer about a provider that
    // was not the one on screen. When that was the browser's own engine its
    // honest "nothing to synthesize" arrived here as a bare no-audio reply and
    // was painted "connection failed", for a request that never left the
    // machine. Reproduced 2026-08-24 with the storage row to prove it.
    sendToBackground({ type: "ttsTest", voice: $("ttsVoiceSel").value,
      provider: p.id, targetLang: state.targetLang })
      .then((resp) => {
        if (!resp || !resp.ok) {
          showTtsMsg(errText(resp && resp.code), "err");
          done();
          return;
        }
        if (resp.local) {
          // Unreachable today, kept as a stated fallback: the localVoices
          // branch above returns before any message is sent, and the worker
          // resolves the provider this page names — so a local answer cannot
          // come back on this path unless one of those two facts changes.
          // If it ever does, speaking the sample here is still the right
          // behaviour, and cheaper than rediscovering the "connection failed"
          // lie this block was written against.
          // Nothing failed and nothing was fetched: the resolved provider has
          // no endpoint. Speak it here, which is what this button means for
          // that engine — never an error message about a network that was
          // never asked.
          speakLocalSample($("ttsVoiceSel").value);
          done();
          return;
        }
        if (!resp.b64) { showTtsMsg(errText(resp.code), "err"); done(); return; }
        playPreview(resp, done);
      })
      .catch((err) => { showTtsMsg(errText((err && err.code) || "failed"), "err"); done(); });
  });

  $("ttsTestBtn").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    const typed = $("ttsKey").value.trim();
    // An empty key is a valid custom configuration (no Authorization header)
    // — the same bargain the translation pane's custom entry strikes.
    if (!typed && !ttsStored[p.id] && !p.custom) { showTtsMsg(errText("noKey"), "err"); return; }
    // The address is read synchronously: permissions.request() below must be
    // reached inside the click gesture, so nothing may await before it.
    let customBase = null;
    if (p.custom) {
      customBase = P.parseCustomBase($("ttsBaseUrl").value);
      if (!customBase) { showTtsMsg(errText("badBaseUrl"), "err"); return; }
    }
    const btn = $("ttsTestBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("byoTesting", "测试中…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsMsg("", null);
    try {
      // First statement inside the gesture — see the header comment. A custom
      // origin may be unrequestable by design (a tunnel domain the manifest
      // cannot name); refusal there downgrades to "let CORS decide", exactly
      // as the translation pane's custom flow does.
      const askOrigins = customBase ? [customBase.origin + "/*"] : [p.origin + "/*"];
      chrome.permissions.request({ origins: askOrigins }, (granted) => {
        if ((chrome.runtime.lastError || !granted) && !p.custom) { done(); showTtsMsg(errText("noPerm"), "err"); return; }
        const writeUrl = customBase
          ? new Promise((r) => chrome.storage.sync.set(
              { ttsBaseUrl: $("ttsBaseUrl").value.trim() }, r))
          : Promise.resolve();
        writeUrl.then(() => persistTts(p, typed))
          // Named here too. persistTts resolves when the WRITE lands; the
          // worker's cfg is refreshed by a storage.onChanged listener, which
          // is a separate async path — so "save, then test" could still be
          // tested against the previous provider.
          // …and the voice. cfg.ttsVoice refreshes on the same other path,
          // so "save, then test" could sample the PREVIOUS provider's voice —
          // voiceOwned then fails and the probe quietly plays the new
          // family's default instead of the one on the menu.
          .then(() => sendToBackground({ type: "ttsTest", provider: p.id,
            targetLang: state.targetLang,
            voice: p.custom ? voiceToSave(p) : $("ttsVoiceSel").value }))
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
          ttsKeysRefresh();                    // …and a tick appears or goes
        }
        return;
      }
      if (area !== "sync") return;
      const c = changes;
      if (c.engine) {
        state.engine = String(c.engine.newValue || "");
        paintAfterSetupNote(state.engine);
      }
      if (c.ttsEnabled) {
        const en = $("ttsEnabled");
        const v = !!c.ttsEnabled.newValue;
        if (en && en.checked !== v) en.checked = v;
      }
      if (c.ttsComplete) {
        const cm = $("ttsComplete");
        const v = !!c.ttsComplete.newValue;
        if (cm && cm.checked !== v) cm.checked = v;
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
      if (c.ttsBaseUrl) {
        const urlInp = $("ttsBaseUrl");
        const v = String(c.ttsBaseUrl.newValue || "");
        if (urlInp && urlInp.value !== v && document.activeElement !== urlInp) {
          urlInp.value = v;
        }
        paintTtsUse();               // the address is what unlocks custom
        ttsKeysRefresh();            // …and what earns its tick on the left
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
        if (listSec === "readaloud") renderList();   // 使用中 moved
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
        // The fetched catalogue is pinned to the language it was fetched FOR
        // — the message under the menu says so. Keeping it on screen across a
        // language change made the menu lie: long ids the engine would now
        // refuse, listed as if choosable. Back to the family, which is the
        // catalogue that follows the reader; fetching again is one click.
        if (voiceCatalogue === "language") {
          voiceCatalogue = "family";
          for (const k in fetchedVoices) delete fetchedVoices[k];
          // The message element directly — showTtsVoiceMsg is a local of the
          // wiring function, not reachable from this listener. Calling it
          // here threw a ReferenceError that the listener swallowed, the
          // repaint below never ran, and the voided catalogue stayed on
          // screen looking exactly as if this branch did not exist. (The
          // worklog's "node --check passes ≠ the scope is right", again.)
          const vm = $("ttsVoiceMsg");
          if (vm) { vm.textContent = ""; vm.hidden = true; }
        }
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
    const p = current();
    if (p && p.custom) paintNeedBanner(p, !!storedKeys[p.id]);
  });

  $("showKey").addEventListener("change", (e) => {
    $("key").type = e.target.checked ? "text" : "password";
  });
  $("key").addEventListener("input", () => paintShowKey("key", "showKeyWrap"));
  $("ttsKey").addEventListener("input", () => paintShowKey("ttsKey", "ttsShowKeyWrap"));

  $("keyClear").addEventListener("click", async () => {
    const p = current();
    if (!p) return;
    await saveKey(p.id, null);
    markVerified(p.id, false);
    paintKeyField(p);
    renderList();
    showMsg(t("byoKeyCleared", "已清除这台电脑上保存的 Key。"), null);
  });

  $("testBtn").addEventListener("click", () => {
    withSetup($("testBtn"), "byoTesting", "测试中…",
      (code) => showMsg(errText(code), "err"), runTest);
  });

  $("fetchModels").addEventListener("click", () => {
    withSetup($("fetchModels"), "optFetching", "拉取中…",
      (code) => showModelMsg(listErrText(code), "err"), runFetchModels, false);
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
    byoModelBy: {}, ttsProvider: "local-speech", ttsVoice: "", engine: "auto" },
  (got) => {
    state = Object.assign(state, got || {});
    paintAfterSetupNote(state.engine);
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
    chrome.storage.local.get({ byoKeys: {}, byoOk: {}, [CATALOG_STORE]: {} }, (loc) => {
      for (const id of Object.keys((loc && loc.byoKeys) || {})) storedKeys[id] = true;
      for (const id of Object.keys((loc && loc.byoOk) || {})) verifiedOk[id] = true;
      catalogs = Object.assign(Object.create(null), (loc && loc[CATALOG_STORE]) || {});
      renderList();
      renderDetail();
      // Then put back what this provider's key last fetched. After the paint,
      // not before it: the field is on screen either way, and a list that has
      // to wait on the worker must not hold up the page it belongs to.
      const p0 = current();
      if (p0) {
        catalogRestore("m", p0.id, (items) => {
          fetchedModels[p0.id] = items;
          if (current() && current().id === p0.id) renderModelField(current());
        });
      }
    });
    // After the first paint: every control below holds a value to compare with.
    initCrossPageSync();
  }
);
});                                // ← self.YTDS_I18N.init() gate around boot
