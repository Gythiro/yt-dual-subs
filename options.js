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
              ttsProvider: "local-speech", ttsVoice: "", origFont: "system", transFont: "system" };
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
// Which platform each provider is set to. Mirrors modelsBy: read once at boot,
// written back whole on every change.
let siteBy = Object.create(null);
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
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    const s = t(el.dataset.i18nPh, "");
    if (s) el.setAttribute("placeholder", s);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const s = t(el.dataset.i18nTitle, "");
    if (s) el.setAttribute("title", s);
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
      // A provider whose key is gone cannot speak, and the popup has always
      // said so ("not set up · Configure…"). This list went on badging it "in
      // use", so the two pages told the reader different stories about the
      // same provider. Keyless ones (the browser's own voices) stay usable.
      usable: (p) => !!(ttsStored[p.id] || p.keyless),
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
    // Same story on this side; Ollama needs no key, so it stays usable.
    usable: (p) => !!(storedKeys[p.id] || p.noKey),
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
    if (p.id === mode.inUse() && mode.usable(p)) {
      const inUse = document.createElement("span");
      inUse.className = "pitem-inuse";
      inUse.textContent = t("optInUse", "使用中");
      btn.appendChild(inUse);
    } else if (mode.stored[p.id] || (p.noKey && verifiedOk[p.id])) {
      const ok = document.createElement("span");
      ok.className = "pitem-ok";
      // The same stroke family as the other icons, and a real accessible
      // name: a title on a span is a tooltip, not something a reader hears.
      ok.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      ok.setAttribute("role", "img");
      ok.setAttribute("aria-label", t("optConfigured", "已配置"));
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
  // A provider that wants something other than a model name says so with an
  // example rather than a sentence: Ark takes an endpoint id, and "model name"
  // sent people looking for one that does not exist.
  input.placeholder = p.modelPlaceholder || t("byoModelRequired", "必填：模型名");

  if (!choices.length) {
    // A provider with no key field must not be told to use one. The button
    // beside this line already switches label the same way.
    showModelMsg(p.noKey
      ? t("optNoModelsYetNoKey", "还没有模型列表——拉一份，或者直接手填。")
      : t("optNoModelsYet", "还没有模型列表——用你的 Key 拉一份，或者直接手填。"), null);
  }
}

function showModelMsg(text, kind) {
  const el = $("modelMsg");
  el.textContent = text || "";
  // "warn" is set by the retired-model notice below and was not in this list,
  // so the next message inherited its colour.
  el.classList.remove("ok", "err", "warn");
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

// The two rows are the same idea twice, so they are one function. `which`
// picks the pane: its row, its group, and where the choice is stored.
// A dropdown, like every other choice on this page, rather than a pair of
// buttons carrying bare hostnames. The hostname is the proof, not the label:
// what a reader knows is which website they signed up on, so that is what the
// option says, with the domain after it for the one who wants to be sure.
function renderSiteRow(p, which) {
  const row = $(which === "tts" ? "ttsSiteRow" : "siteRow");
  const sel = $(which === "tts" ? "ttsSiteSeg" : "siteSeg");
  if (!row || !sel) return;
  const sites = (p && p.sites) || null;
  row.hidden = !sites;
  sel.textContent = "";
  if (!sites) return;
  const chosen = (siteBy[p.id] || sites[0].host);
  for (const site of sites) {
    const o = document.createElement("option");
    o.value = site.host;
    // Written out rather than folded into one t() with a computed fallback:
    // the leak gate reads the literal form, and a fallback that only exists
    // inside a ternary is exactly the shape it is there to refuse.
    const siteName = site.nameKey === "byoSiteCn"
      ? t("byoSiteCn", "中国大陆")
      : t("byoSiteGlobal", "国际");
    o.textContent = siteName + "（" + site.host + "）";
    o.selected = site.host === chosen;
    sel.appendChild(o);
  }
  sel.onchange = () => pickSite(p, sel.value, which);
}

// Switching platform means the stored key belongs to the other account, so the
// tick it earned there is not evidence here. The key itself is left alone: a
// reader who switches back should not have to paste it again.
function pickSite(p, host, which) {
  if (siteBy[p.id] === host) return;
  siteBy[p.id] = host;
  chrome.storage.sync.set({ byoSiteBy: Object.assign({}, siteBy) });
  if (which !== "tts") markVerified(p.id, false);
  renderSiteRow(p, which);
  if (which === "tts") { paintTtsKeyField(p); paintTtsUse(); }
  else { renderDetail(); }
}

// Which providers are mid-replacement. A stored key is never written back into
// the box, so "there is a key" and "I am typing a new one" are two states, and
// the box belongs only to the second. Cleared when the provider changes.
const replacing = Object.create(null);

// Both panes hold a key the same way, so they paint it with one function.
// Before this, a saved key showed as an EMPTY password box whose placeholder
// read "saved ····1234", and a link called "Clear" beside it. Two readers in a
// row misread that — one of them the person who wrote it — because "clear"
// means "empty this box" and the box was already empty, while the action was
// "delete the key". A placeholder is also not in the accessibility tree: with
// a screen reader, a saved key and no key sounded identical.
function paintHeldKey(o) {
  const inp = $(o.input);
  const held = $(o.held);
  inp.value = "";
  inp.type = $(o.show).checked ? "text" : "password";
  paintShowKey(o.input, o.showWrap);
  inp.placeholder = o.placeholder;
  held.hidden = true;
  inp.hidden = false;
  inp.disabled = false;

  chrome.storage.local.get({ [o.store]: {} }, (got) => {
    const key = ((got && got[o.store]) || {})[o.id] || "";
    if (o.onKey) o.onKey(!!key);
    if (!key || replacing[o.id]) return;
    // Every DeepL Free key ends in ":fx", so masking to those four characters
    // would tell the user nothing — mask the last four before the suffix.
    const last4 = key.replace(/:fx$/, "").slice(-4);
    $(o.heldText).textContent = tsub("byoKeySaved", [last4], "已保存 ····" + last4);
    held.hidden = false;
    // Hidden is not enough: a password manager will happily fill a box it
    // cannot see, and the next Save would store whatever it put there.
    inp.hidden = true;
    inp.disabled = true;
    paintShowKey(o.input, o.showWrap);
    if (o.after) o.after();
  });
  if (o.after) o.after();
}

function paintKeyField(p) {
  // Ollama authenticates nothing — the worker sends no Authorization header for
  // it at all. An API-key box on that panel asks the reader for something that
  // does not exist, and anything typed into it would be stored and sent to
  // their own machine for no reason. The read-aloud pane has hidden this row
  // for the browser's built-in voices since it was built; this side had not.
  const keyField = $("key") && $("key").closest(".ofield");
  if (keyField) keyField.hidden = !!p.noKey;
  if (p.noKey) {
    // Still repaint the banner: it belongs to the provider on screen, and
    // returning without touching it left the previous provider's "No key yet"
    // hanging over a panel that has no key field at all. paintNeedBanner
    // already knows to hide itself for this kind of provider.
    paintNeedBanner(p, true);
    storedKeys[p.id] = false;
    paintModelGate(p);
    return;
  }
  paintHeldKey({
    id: p.id, store: "byoKeys",
    input: "key", show: "showKey", showWrap: "showKeyWrap",
    held: "keyHeld", heldText: "keyHeldText",
    placeholder: p.kind === "deepl" ? "xxxxxxxx-xxxx-…:fx" : "sk-…",
    onKey: (has) => {
      storedKeys[p.id] = has;
      paintNeedBanner(p, has);          // the one thing a first-time visitor must notice
    },
    after: () => paintModelGate(p)
  });
}

// The model row cannot do anything without a key: the list is fetched with it,
// and "List models with my key" says so in its own name. Leaving both live and
// refusing on click sent the reader a message about the OTHER button, printed
// above the field it was telling them to go and fill. Off is the honest state;
// the banner above already says why.
function paintModelGate(p) {
  // "List models with my key" names a key this provider does not have. Same
  // button, same act, minus the half that is not true here.
  const fetchBtn = $("fetchModels");
  if (fetchBtn) {
    fetchBtn.textContent = p.noKey
      ? t("optFetchModelsNoKey", "拉取可用模型")
      : t("optFetchModels", "用我的 Key 拉取模型");
  }
  const need = !p.custom && !p.noKey && !storedKeys[p.id] && !$("key").value.trim();
  for (const id of ["modelSel", "fetchModels", "modelInput"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = need;
    if (need) el.title = t("optNeedKey", "还没填 Key，这个服务商暂时用不了。");
    else el.removeAttribute("title");
  }
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

  // The console and the price list belong to the platform, not to the brand:
  // sending a reader on the global site to the China console is how this whole
  // thread started.
  const site = P.siteFor(p, siteBy[p.id]);
  const keyUrl = (site && site.keyUrl) || p.keyUrl;
  const pricingUrl = (site && site.pricingUrl) || p.pricingUrl;
  const keyLink = $("pKeyLink");
  keyLink.hidden = !keyUrl;
  if (keyUrl) keyLink.href = keyUrl;
  const priceLink = $("pPricingLink");
  priceLink.hidden = !pricingUrl;
  if (pricingUrl) priceLink.href = pricingUrl;
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

  renderSiteRow(p, "byo");
  renderModelField(p);
  paintKeyField(p);
  showMsg("", null);
}

// `detail` is the provider's own sentence, already redacted and capped in the
// worker. It goes on its own line under ours, in the muted colour, because it
// is evidence rather than instruction — and because it arrives in whatever
// language the provider answers in, which is not necessarily the reader's.
function showMsg(text, kind, detail) {
  const el = $("msg");
  el.textContent = text || "";
  el.classList.remove("ok", "err", "warn");
  if (kind) el.classList.add(kind);
  if (text && detail) {
    const line = document.createElement("span");
    line.className = "omsg-raw";
    line.textContent = detail;
    el.appendChild(line);
  }
  el.hidden = !text;
}

// The rate-limit sentence promises the extension is already retrying, which is
// true of the translation lane and false of a button the reader just pressed:
// nothing retries a probe. Same code, different room, different sentence.
function testErrText(code, provider) {
  if (code === "limited") {
    return t("byoErrLimitedTest", "服务商正在限流。等一会儿再按一次。");
  }
  return errText(code, provider);
}

function errText(code, provider) {
  // The address matters to the wording: the local advice (OLLAMA_ORIGINS, LM
  // Studio's CORS switch) is right for a server on this machine and misleading
  // for a public host someone typed into the custom field.
  const origin = provider && provider.custom ? (state.byoBaseUrl || "") : undefined;
  return t(P.errorKey(code, provider, origin), t("byoErrFailed", "连接失败，稍后再试。"));
}

// The same 401 means two different things depending on when it arrives.
// Saving a key: it is probably mistyped or not active yet — what byoErrAuth
// says. Fetching a LIST after the key already synthesised a sample: the key
// works, so the refusal is about what this key is allowed to read. ElevenLabs
// keys are per-endpoint (a key can hold "Text to Speech: Access" and "Voices:
// No Access", which is exactly the combination that produced this), OpenAI's
// are per-scope. Telling that user to check they copied the key in full sends
// them to re-paste a key that was never wrong.
// "This key isn't allowed to read the list" is only true of a key that WORKS.
// Said about a key that has never passed a test, it sends the reader hunting
// for a permission switch that would not have helped: the key is simply wrong.
function listErrText(code, provider) {
  const proven = provider && verifiedOk[provider.id];
  if ((code === "auth" || code === "noPerm") && !proven) {
    return errText(code, provider);
  }
  if (code === "auth" || code === "noPerm") {
    return t("byoErrListAuth",
      "这把 Key 没有读取清单的权限。去服务商后台给它加上，再拉一次。");
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
    if (P.urlCarriesSecret($("baseUrl").value)) return { error: "urlHasKey" };
    const parsed = P.parseCustomBase($("baseUrl").value);
    if (!parsed) return { error: "badBaseUrl" };
    baseUrl = parsed.baseUrl;
    origins = P.originsFor(p, parsed.origin);
  } else {
    origins = P.originsFor(p, null, siteBy[p.id]);
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
// Takes the busy label already resolved, not a key and a fallback as two loose
// arguments. That shape was only ever legal to the leak scanner by accident —
// it inherits legality from a t() still open in its lookback window, so adding
// an unrelated function nearby turned two long-standing strings into findings.
// A string that has to be near something else to be correct is not correct.
// What the extension is translating with at the moment Save-and-test is
// pressed. The configuration has to be written before the worker can probe it,
// so a refusal used to leave the reader pointed at the provider that just
// refused them — subtitles stop on the video they were watching, and nothing
// on screen connects the two. The read-aloud pane has put the engine back
// since it shipped; this is the same bargain on this side. The key stays
// saved either way: someone who switches back should not have to paste it.
let byoInUseBeforeTest = null;
function restoreByoAfterFailedTest(pl) {
  const before = byoInUseBeforeTest;
  byoInUseBeforeTest = null;
  if (!before || !before.provider) return;
  if (before.provider === pl.provider.id) return;      // it was already this one
  state.byoProvider = before.provider;
  state.byoModel = before.model;
  state.byoBaseUrl = before.baseUrl;
  chrome.storage.sync.set({
    byoProvider: before.provider,
    byoModel: before.model,
    byoBaseUrl: before.baseUrl
  });
  renderList();
}

function withSetup(btn, busyLabel, onError, run, adopt) {
  const pl = plan();
  if (pl.error) { onError(pl.error); return; }
  // A custom endpoint is allowed to have no key at all — Ollama and LM Studio
  // ignore auth; the worker sends no Authorization header for an empty key.
  if (!pl.typedKey && !storedKeys[pl.provider.id] &&
      !pl.provider.custom && !pl.provider.noKey) { onError("noKey"); return; }
  // A model name is required by every llm provider, and nine of the twelve ship
  // no default — so "no model yet" is the state most people land in. It used to
  // be caught in the worker, one round trip later, AFTER persist() had already
  // written byoProvider and stored the key: a test that could not pass left the
  // extension switched to a provider that cannot translate, wearing the "in
  // use" tick. Asking here costs nothing and changes nothing on the way out.
  // Guarded on adopt: fetching the model list is exactly the case where the
  // model is legitimately still empty.
  if (adopt !== false && pl.provider.kind === "llm" && !pl.model) {
    // Nine of the twelve ship no model list, so "choose one from the list"
    // points at a dropdown holding nothing but "Custom…". Name the door that
    // is actually there.
    const canPick = (pl.provider.models && pl.provider.models.length) ||
      (fetchedModels[pl.provider.id] || []).length;
    onError(canPick ? "noModel" : "noModelEmpty"); return;
  }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  const done = () => { btn.disabled = false; btn.textContent = label; };

  const proceed = () => {
    // Remembered before anything is written, and only when this press is the
    // kind that adopts a provider (asking for a model list is not).
    // Only a press that adopts a provider takes this snapshot. Asking for a
    // model list must not CLEAR one either: its button stays live while a test
    // is in flight, and clearing the snapshot there left a failed test with
    // nothing to put back.
    if (adopt !== false) {
      byoInUseBeforeTest = {
        provider: state.byoProvider, model: state.byoModel, baseUrl: state.byoBaseUrl
      };
    }
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
      byoInUseBeforeTest = null;          // it worked: this IS the one in use now
      renderList();
      showMsg(tsub("byoTestOk", [sample], "连接成功：" + sample), "ok");
      freshenModels(pl.provider);
    } else {
      markVerified(pl.provider.id, false);
      restoreByoAfterFailedTest(pl);
      showMsg(testErrText(resp && resp.code, pl.provider), "err", resp && resp.detail);
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
        ? listErrText(resp.code, pl.provider)
        : t("optModelsFailed", "拉取失败——可以直接手填模型名。"), "err");
    }
  } finally {
    paintKeyField(pl.provider);
  }
}

// The model names we ship go stale on their own: some are aliases that always
// point at the current model (deepseek-chat, gemini-flash-latest, qwen-flash)
// and cannot rot, but the rest carry a version in the name — qwen3.7-flash,
// deepseek-v4-flash, eleven_multilingual_v2 — and one day the provider retires
// them. Nothing here would ever notice.
//
// So after a test that PASSED, ask the provider what it actually offers. The
// key has just proved it works, which is the whole point of doing it here
// rather than when the key is saved: a refusal now cannot be mistaken for
// "the key is bad". And it is enrichment, never a gate — a key that is not
// allowed to read the list (byoErrListAuth exists for exactly that) still has
// a working default, so this failing must cost nothing and say nothing.
//
// Deleting the shipped defaults and forcing this instead would turn a soft
// failure into a hard one for those keys: no default, no list, no way forward
// but typing a name the reader does not know.
function freshenModels(p) {
  if (!p || p.kind !== "llm" || p.custom || p.noKey) return;
  sendToBackground({ type: "byoModels", provider: p.id })
    .then((resp) => {
      if (!resp || !resp.ok || !resp.models || !resp.models.length) return;   // silent
      if (current() !== p) return;                    // the reader moved on
      fetchedModels[p.id] = resp.models;
      catalogSave("m", p.id, resp, resp.models, null);
      const chosen = modelsBy[p.id] || p.defaultModel || "";
      renderModelField(p);
      // The one thing worth interrupting for: the model in force is not on the
      // provider's list any more. That is the shape a retired model takes.
      if (chosen && resp.models.indexOf(chosen) === -1) {
        showModelMsg(tsub("optModelRetired", [chosen],
          "「" + chosen + "」已经不在这家的清单里了——从上面重新选一个。"), "warn");
      }
    })
    .catch(() => { /* enrichment only */ });
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
// Built on first use, not at load: the interface-language override is only
// known once YTDS_I18N.init() has run, and this used to ask the browser at
// load time — so a German reader on an English Chrome got "Deutsch  German"
// down the whole list, the one column on the page that ignored their choice.
let displayNames;      // undefined = not tried; null = unavailable
function getDisplayNames() {
  if (displayNames !== undefined) return displayNames;
  try {
    const ui = (self.YTDS_I18N && self.YTDS_I18N.effectiveLang()) || "en";
    displayNames = new Intl.DisplayNames([ui], { type: "language" });
  } catch (_e) { displayNames = null; }
  return displayNames;
}

function localName(info) {
  const dn = getDisplayNames();
  if (dn) {
    try {
      const n = dn.of(info.code);
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
  fonts: { el: "secFonts", title: "optNavFonts", intro: "fontsIntro" },
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
  // The font list is read (and probed) only once someone opens this pane —
  // the probe measures every installed font, which is not free.
  if (sec === "fonts") wantFonts();
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

// ---- subtitle fonts ---------------------------------------------------------
// Same shape as the language list: what the popup shows (kept) and the rest,
// with + and ×. The names come from this computer (chrome.fontSettings through
// fonts.js) and the kept list lives in storage.local — per machine, because
// two computers share almost no fonts (the reference Mac and Windows had 22
// in common), so a synced list would be mostly grey on the other one.
// A row shows its name in its own font, and pressing the name previews it on
// the strip above at real subtitle size. The probe (fonts.js) says which of
// the fonts can draw the translation language; that drives the count line,
// the "only fonts that can draw…" switch, and the order of the rest (able
// first). Nothing here decides for a line — the popup does that per line.
let fontsInstalled = null;   // [{id, name}] or null while unread / unavailable
let fontImports = [];        // [{id, name, size, kind}] the reader imported (fonts.js)
let fontKept = null;         // ids; null = this computer's defaults
let fontCov = Object.create(null);  // lang -> {id: true|false|null}
let fontPreviewId = "";      // "" = system default
let fontsInit = 0;           // 0 not yet, 1 waiting for state, 2 running/done
let fontsWanted = false;
let fontLangsSeen = [];      // original languages of recent videos (content.js writes storage.local)
let fontCheckLang = "";      // the language this pane is looking at; "" = the translation language
let fontProbing = "";        // the language being measured right now
let fontProbingAll = false;  // …for the whole list (the switch), not one tried font
const fontProbeTries = Object.create(null);

function fontTargetLang() { return String(state.targetLang || "zh-CN"); }
function fontLangName(code) {
  const info = LANGS && LANGS.get(code);
  return info ? info.native : String(code || "");
}
// The pane looks at ONE language at a time — the dropdown under the mirror.
// It starts on the language of the videos the reader watches (the most
// recent original language; English when none is known), and the mirror's
// white line, the switch and the count all follow it. One control, one
// subject (settled 2026-09-07).
function recentLang() {
  const target = fontTargetLang();
  return fontLangsSeen.find((c) => c !== target && LANGS && LANGS.get(c)) || "";
}
function checkLang() { return fontCheckLang || recentLang() || "en"; }
function whiteLang() { return checkLang(); }

// Installed fonts, then the imported ones (tagged), in one list — the
// pickers do not care where a font came from, only that it is here.
// The installed list may be unavailable (the browser refused fontSettings):
// the pane then says so and still lists the reader's imports, which need
// no permission.
function allFonts() {
  if (!fontsInstalled && !fontImports.length) return null;
  return (fontsInstalled || []).concat(fontImports.map((f) => ({ id: f.id, name: f.name, imported: true, size: f.size })));
}

function keptFontIds() {
  const F = self.YTDS_FONTS;
  const fonts = allFonts();
  if (!F || !fonts) return [];
  const have = new Set(fonts.map((f) => f.id));
  let ids;
  if (Array.isArray(fontKept)) ids = fontKept.filter((id) => have.has(id));
  else {
    let ui = "";
    try { ui = self.YTDS_I18N.effectiveLang().replace("_", "-"); } catch (_e) { /* ignore */ }
    ids = fontsInstalled ? F.defaults(fontsInstalled, [fontTargetLang(), ui, "en"]) : [];
  }
  // An imported font is in the popup's list for as long as it exists —
  // whoever imported it meant to use it; taking it out is deleting it.
  for (const f of fontImports) if (ids.indexOf(f.id) < 0) ids.push(f.id);
  return ids;
}

function persistFonts() {
  try { chrome.storage.local.set({ fontKept }); } catch (_e) { /* ignore */ }
}

function showFontMsg(text, kind) {
  const el = $("fontMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

// Which fonts can draw `lang`. NOT run on entry: browsing, searching and
// + / × need no measurement, and the full list costs about a second on a
// Mac and five on Windows. It runs when the reader asks a question that
// needs it — ticks "only fonts that can draw…" or picks a language — in
// slices that hand the frame back, with the count line showing progress.
// Cached in storage.local under the list's signature, so the second time is
// free; a run the rulers could not serve (null) is not cached.
// One run at a time: a language picked while another is being measured
// waits its turn, so the progress in the heading is always the run it
// names, and two runs never race for the rulers.
let fontProbeChain = Promise.resolve();
function probeFontsFor(lang, only) {
  const run = fontProbeChain.then(() => probeFontsNow(lang, only));
  fontProbeChain = run.catch(() => {});
  return run;
}
async function probeFontsNow(lang, only) {
  const F = self.YTDS_FONTS;
  const fonts = allFonts();
  if (!F || !fonts || fontProbing === lang) return;
  const ids = fonts.map((f) => f.id);
  // A font's verdict for a language does not depend on what else is
  // installed, so verdicts are kept per id: a list that changed (an import
  // added or removed, a font installed) costs measuring the new ids only,
  // and the rows already judged keep their state meanwhile — no flash of
  // the whole list while one font is measured.
  const known = fontCov[lang] || Object.create(null);
  if (!fontCov[lang]) {
    const cached = await new Promise((res) => {
      try { chrome.storage.local.get({ fontCov: null }, (g) => res(g && g.fontCov)); }
      catch (_e) { res(null); }
    });
    const old = cached && cached.cov && cached.cov[lang];
    if (old) for (const id of ids) if (id in old && old[id] !== null) known[id] = old[id];
  }
  const todo = (only ? ids.filter((id) => only.indexOf(id) >= 0) : ids).filter((id) => !(id in known));
  if (!todo.length) { fontCov[lang] = known; return; }
  // An imported font has to be registered on this page before it can be
  // measured like the others.
  await Promise.all(fontImports.filter((f) => todo.indexOf(f.id) >= 0).map((f) => F.ensureImported(document, f.id)));
  fontProbing = lang;
  fontProbingAll = !only;
  fontProbeStep = null;
  if (!only) {
    paintFontCount(0, todo.length);
    renderFonts();   // the column shows "checking…" instead of the unjudged list
  }
  const r = await F.probe(todo, [lang], document, (done, total) => { if (fontProbingAll) paintFontCount(done, total); });
  fontProbing = "";
  fontProbingAll = false;
  fontProbeStep = null;
  let unknown = false;
  for (const id of todo) {
    const v = r[id] ? r[id][lang] : null;
    if (v === null) unknown = true; else known[id] = v;
  }
  if (unknown) {
    // The rulers were not there for this run (fonts.js says so with null):
    // not "0 fonts can draw it", just not measured yet. Try again shortly,
    // a few times, before giving up.
    fontProbeTries[lang] = (fontProbeTries[lang] || 0) + 1;
    if (fontProbeTries[lang] <= 4) setTimeout(() => probeFontsFor(lang).then(renderFonts), 600);
    paintFontCount();
    return;
  }
  fontCov[lang] = known;
  fontProbeTries[lang] = 0;   // the rulers are there: a later miss gets its retries again
  // Written back merged with whatever is there (the popup keeps the same
  // cache, other languages measured in earlier sessions too), pruned to
  // the ids that still exist.
  try {
    chrome.storage.local.get({ fontCov: null }, (g) => {
      const cov = Object.assign(Object.create(null), (g && g.fontCov && g.fontCov.cov) || {});
      for (const l of Object.keys(fontCov)) {
        const m = Object.create(null);
        for (const id of ids) if (id in fontCov[l]) m[id] = fontCov[l][id];
        cov[l] = m;
      }
      // No signature field: it was written here and in the popup and read
      // nowhere. What actually invalidates an entry is per id (an id that is
      // gone is pruned above, an unmeasured one is null), and a dead field
      // that looks like a checksum invites the next reader to trust it.
      chrome.storage.local.set({ fontCov: { cov } });
    });
  } catch (_e) { /* ignore */ }
}

function fontMatches(f, q) {
  q = String(q || "").trim().toLowerCase();
  return !q || f.name.toLowerCase().indexOf(q) >= 0 || f.id.toLowerCase().indexOf(q) >= 0;
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? Math.round(n / 1048576) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

// A row: the name in its own font (the list previews itself; the id is the
// CSS name, the label the display name — they differ on a Chinese Windows,
// and only the label is shown) and one control: + to keep, × to stop
// keeping, or, for a font the reader imported, delete (the copy goes with
// it). One shape for every row, as in the language list above.
function fontRow(f, kept) {
  const F = self.YTDS_FONTS;
  const li = document.createElement("li");
  li.className = "olang ofont" + (f.id === fontPreviewId ? " trying" : "");
  li.dataset.id = f.id;

  const name = document.createElement("button");
  name.type = "button";
  name.className = "ofont-try";
  name.style.fontFamily = F.css(F.valueOf(f.id));
  name.textContent = f.name;
  const tryLabel = t("fontsTryAria", "预览");
  name.setAttribute("aria-label", tryLabel + " " + f.name);
  name.setAttribute("aria-pressed", String(f.id === fontPreviewId));
  name.title = tryLabel;
  name.addEventListener("click", () => previewFont(f.id));
  li.appendChild(name);
  // Where a verdict matters and is known, it is said here in the popup's
  // words: on a kept row once the reader has asked (the switch), and on
  // the row being tried, whose mirror line would otherwise hide the miss
  // behind the system font's fallback glyphs.
  const note = document.createElement("span");
  note.className = "ofont-note";
  note.textContent = fontNoteFor(f.id, kept);
  note.title = note.textContent;   // the whole note, when the row is too narrow for it
  li.appendChild(note);

  const btn = document.createElement("button");
  btn.type = "button";
  if (f.imported) {
    // Same stroke system as the other icons (the spec bars emoji as icons).
    btn.className = "olang-btn drop";
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    const dl = t("fontsImportDelete", "删除导入的字体");
    btn.setAttribute("aria-label", dl + " " + f.name);
    btn.title = dl;
    btn.addEventListener("click", () => dropImport(f.id));
  } else {
    btn.className = "olang-btn" + (kept ? " remove" : " add");
    btn.textContent = kept ? "×" : "+";
    const label = kept ? t("langsRemoveAria", "移除") : t("langsAddAria", "添加");
    btn.setAttribute("aria-label", label + " " + f.name);
    btn.title = label;
    btn.addEventListener("click", () => (kept ? removeFont(f.id) : addFont(f.id)));
  }
  li.appendChild(btn);
  return li;
}

function renderFonts() {
  const keptEl = $("fontKept"), moreEl = $("fontMore");
  if (!keptEl || !moreEl) return;
  const F = self.YTDS_FONTS;
  const unavailable = !fontsInstalled;
  const un = $("fontUnavailable");
  if (un) un.hidden = !unavailable;
  // Whoever is on a button in these lists keeps their place across the
  // rebuild: the same column, the same row (or the last one), so a keyboard
  // user can press + or × down a list without being thrown back to the top.
  const focus = (() => {
    const a = document.activeElement;
    const li = a && a.closest && a.closest("#fontKept .olang, #fontMore .olang");
    if (!li) return null;
    const list = li.parentElement;
    return { list: list.id, index: [...list.children].indexOf(li), name: a.classList.contains("ofont-try") };
  })();
  keptEl.textContent = "";
  moreEl.textContent = "";
  if (unavailable && !fontImports.length) { paintFontCount(); return; }
  const lang = checkLang();
  const cov = fontCov[lang] || null;
  const onlyBox = $("fontOnly");
  const only = !!(onlyBox && onlyBox.checked);
  const q = $("fontSearch") ? $("fontSearch").value : "";
  const fonts = allFonts();
  // The switch is the question that needs the measurement. Until every
  // font has its verdict, the ones without one stay listed.
  // (a run that came back empty — no rulers — schedules its own retries,
  // a few; this only asks the first time, or again after a press)
  if (only && fonts.some((f) => !cov || !(f.id in cov)) && fontProbing !== lang && !(fontProbeTries[lang] > 0)) {
    probeFontsFor(lang).then(renderFonts);
  }
  const byId = new Map(fonts.map((f) => [f.id, f]));
  const kept = keptFontIds();
  // An imported face has to be registered on this page to draw its own
  // name in the list (once; ensureImported remembers).
  if (F) for (const f of fontImports) F.ensureImported(document, f.id);
  // The kept column is the popup's list, whole: the switch never thins it
  // (a kept row that cannot draw the language looked at says so instead,
  // in the popup's words). The search box looks here too.
  for (const id of kept) {
    const f = byId.get(id);
    if (f && fontMatches(f, q)) keptEl.appendChild(fontRow(f, true));
  }
  // Emptied to nothing is allowed (the popup still has System default);
  // say so, as the language list says "all added" on its side — unless it
  // is the search that left nothing.
  if (!keptEl.childElementCount) {
    const li = document.createElement("li");
    li.className = "olang-empty";
    li.textContent = (q && kept.length) ? t("fontsNoMatch", "没有匹配的字体。") : t("fontsKeptEmpty", "弹窗里只剩「系统默认」。");
    keptEl.appendChild(li);
  }
  const keptSet = new Set(kept);
  // Alphabetical, always: an order the reader cannot see the rule of reads
  // as broken. The switch narrows; it does not reorder.
  let rest = fonts.filter((f) => !keptSet.has(f.id) && fontMatches(f, q));
  // While the measurement runs, the switch shows what is known to be able
  // rather than the whole list pretending to be the answer.
  const measuring = only && fontProbing === lang && fontProbingAll;
  if (only) rest = rest.filter((f) => cov && (measuring ? cov[f.id] === true : cov[f.id] !== false));
  if (!rest.length) {
    const li = document.createElement("li");
    li.className = "olang-empty";
    // The switch is a filter like the search box: nothing left is "no
    // match", not "all added" — and nothing yet, while measuring.
    li.textContent = measuring ? t("fontsCounting", "检查中…")
      : (q || only) ? t("fontsNoMatch", "没有匹配的字体。") : t("fontsAllAdded", "全部字体都已加入。");
    moreEl.appendChild(li);
  }
  for (const f of rest) moreEl.appendChild(fontRow(f, false));
  fontMoreShown = rest.length;
  paintFontCount();
  // A font being tried whose row the switch or the search just took away
  // would leave the mirror on a font nobody can see or cancel: the try ends.
  if (fontPreviewId && !document.querySelector('#secFonts .olang[data-id="' + CSS.escape(fontPreviewId) + '"]')) previewFont("");
  // The row that just moved (added, removed) is brought into view.
  if (fontFlashId) {
    const li = document.querySelector('#secFonts .olang[data-id="' + CSS.escape(fontFlashId) + '"]');
    if (li && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
    fontFlashId = "";
  }
  if (focus) {
    const list = $(focus.list);
    const rows = list ? [...list.querySelectorAll(".olang")] : [];
    const row = rows[Math.min(focus.index, rows.length - 1)];
    const el = row ? row.querySelector(focus.name ? ".ofont-try" : ".olang-btn") : null;
    if (el) el.focus();
    else if (focus.list === "fontMore" && $("fontSearch")) $("fontSearch").focus();
    else if ($("fontImportBtn")) $("fontImportBtn").focus();
  }
}

// The one number on this pane, in the right column's heading: how many rows
// it shows; while measuring, the progress instead.
let fontMoreShown = 0;
let fontFlashId = "";        // the row a press just moved; scrolled into view on the next paint
let fontProbeStep = null;    // [done, total] of the run in progress, so a repaint keeps it
function fontNoteFor(id, kept) {
  const cov = fontCov[checkLang()] || null;
  if (!cov || cov[id] !== false) return "";
  const only = !!($("fontOnly") && $("fontOnly").checked);
  return ((kept && only) || id === fontPreviewId) ? "· " + t("fontNoGlyphs", "显示不了") : "";
}
function paintFontNotes() {
  document.querySelectorAll("#fontKept .olang[data-id], #fontMore .olang[data-id]").forEach((li) => {
    const n = li.querySelector(".ofont-note");
    if (n) { n.textContent = fontNoteFor(li.dataset.id, li.parentElement.id === "fontKept"); n.title = n.textContent; }
  });
}

function paintFontCount(done, total) {
  const el = $("fontMoreN");
  if (!el) return;
  if (!fontsInstalled) { el.textContent = ""; return; }
  if (fontProbing === checkLang() && fontProbingAll) {
    if (total) fontProbeStep = [done, total];
    const st = fontProbeStep;
    el.textContent = t("fontsCounting", "检查中…") + (st ? " " + st[0] + "/" + st[1] : "");
    return;
  }
  el.textContent = "(" + fontMoreShown + ")";
}

function paintFontOnlyLabel() { /* the switch's label is static now */ }

// The language dropdown: the translation language first, then the original
// languages of recently watched videos, then everything else. Names come
// from the language table — the same ones the popup shows.
function paintFontLangSel() {
  const sel = $("fontLang");
  if (!sel || !LANGS) return;
  const target = fontTargetLang();
  const recent = fontLangsSeen.filter((c) => c !== target && LANGS.get(c));
  sel.textContent = "";
  const add = (code, suffix) => {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = fontLangName(code) + (suffix ? " · " + suffix : "");
    sel.appendChild(o);
  };
  add(target, "");
  for (const c of recent) add(c, t("fontsLangRecent", "最近看过"));
  if (recent.length) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "──────";
    sel.appendChild(sep);
  }
  const seen = new Set([target].concat(recent));
  for (const info of LANGS.all()) if (!seen.has(info.code)) add(info.code, "");
  sel.value = checkLang();
  if (!sel.value) { fontCheckLang = ""; sel.value = checkLang(); }
}

function onFontLangChange() {
  const sel = $("fontLang");
  if (!sel) return;
  fontCheckLang = sel.value;
  paintFontOnlyLabel();
  paintFontSample();
  renderFonts();   // measures when the switch is on (renderFonts asks for it)
  if (fontPreviewId) probeFontsFor(checkLang(), [fontPreviewId]).then(paintFontNotes);
}

// Pressing a name tries it in the mirror — on the lines whose language is
// the one being looked at, and only those. The white line is always that
// language, so it always changes; the yellow line is the translation
// language, so it changes only when that is the language picked. A
// real-machine finding (2026-09-07): looking at Korean and pressing a
// Korean face changed the Chinese line too, which reads as wrong. When
// nothing is being tried, each line shows the font really in force for it
// (origFont / transFont from the popup). Pressing the tried row again
// puts the mirror back.
function previewFont(id) {
  const F = self.YTDS_FONTS;
  if (!F) return;
  fontPreviewId = (id && id !== fontPreviewId) ? id : "";
  paintMirrorFonts();
  document.querySelectorAll("#secFonts .olang[data-id]").forEach((li) => {
    const on = li.dataset.id === fontPreviewId;
    li.classList.toggle("trying", on);
    const b = li.querySelector(".ofont-try");
    if (b) b.setAttribute("aria-pressed", String(on));
  });
  paintFontNotes();
  paintFontPrevName();
  // The verdict for this one font in the language looked at, if not known
  // yet: one measurement, not the whole list.
  if (fontPreviewId) probeFontsFor(checkLang(), [fontPreviewId]).then(paintFontNotes);
}

function paintMirrorFonts() {
  const F = self.YTDS_FONTS;
  const o = $("fontPrevOrig"), tr = $("fontPrevTrans");
  if (!F || !o || !tr) return;
  const tried = fontPreviewId ? F.valueOf(fontPreviewId) : "";
  const white = tried || String(state.origFont || "system");
  const yellow = (tried && checkLang() === fontTargetLang()) ? tried : String(state.transFont || "system");
  o.style.fontFamily = F.css(white);
  tr.style.fontFamily = F.css(yellow);
  for (const v of [white, yellow]) {
    if (F.isFont(v) && F.isImport(F.idOf(v))) F.ensureImported(document, F.idOf(v));
  }
}

function paintFontPrevName() {
  const F = self.YTDS_FONTS;
  const nm = $("fontPrevName");
  if (!nm || !F) return;
  const id = fontPreviewId;
  if (!id) { nm.textContent = ""; return; }
  const name = F.label(F.valueOf(id), allFonts(), t);
  nm.textContent = tsub("fontsPreview", [name], "预览：" + name);
}

// Sample text in a language: this build's own sample for English, the
// packaged locale's sample where there is one, the language's own name
// otherwise (at least its script). No new sentences for fifty languages.
const SAMPLE_DIR = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", pt: "pt_BR" };
async function sampleFor(lang) {
  if (lang === "en") return t("sampleOrig", "The quick brown fox");
  let ui = "";
  try { ui = self.YTDS_I18N.effectiveLang().replace("_", "-"); } catch (_e) { /* ignore */ }
  if (ui.split("-")[0] === lang.split("-")[0] && ui !== "en") return t("sampleTrans", "敏捷的棕色狐狸");
  // Only a packaged locale is fetched: asking for a folder that is not
  // there is a file-not-found in the console for nothing.
  const dir = SAMPLE_DIR[lang] || lang;
  let packaged = false;
  try { packaged = !!self.YTDS_I18N.SELF_NAMES[dir]; } catch (_e) { /* ignore */ }
  if (!packaged) {
    const F = self.YTDS_FONTS;
    return (F && F.SAMPLE && F.SAMPLE[lang]) || fontLangName(lang);
  }
  try {
    const r = await fetch(chrome.runtime.getURL("_locales/" + dir + "/messages.json"));
    if (r.ok) {
      const j = await r.json();
      const text = j.sampleTrans && j.sampleTrans.message;
      if (text) return text;
    }
  } catch (_e) { /* not packaged for this language */ }
  return fontLangName(lang);
}

// The two preview lines: white = the original language being looked at,
// yellow = the translation language, each marked with its language so the
// browser picks that language's glyphs, as the overlay does.
async function paintFontSample() {
  const o = $("fontPrevOrig"), tr = $("fontPrevTrans");
  if (!o || !tr) return;
  const wl = whiteLang(), tl = fontTargetLang();
  o.setAttribute("lang", wl);
  tr.setAttribute("lang", tl);
  const [a, b] = await Promise.all([sampleFor(wl), sampleFor(tl)]);
  if (whiteLang() === wl) o.textContent = a;
  if (fontTargetLang() === tl) tr.textContent = b;
  paintMirrorFonts();
  paintFontPrevName();
}

function addFont(id) {
  const kept = keptFontIds().slice();
  if (kept.indexOf(id) >= 0) return;
  kept.push(id);
  fontKept = kept;
  persistFonts();
  fontFlashId = id;
  renderFonts();
  const F = self.YTDS_FONTS;
  const name = F ? F.label(F.valueOf(id), allFonts(), t) : id;
  showFontMsg(tsub("fontsAdded", [name], "已加入「" + name + "」"), "ok");
}

// ---- importing a font file ----
async function importFontFile(file) {
  const F = self.YTDS_FONTS;
  if (!F || !file) return;
  const r = await F.importFile(file);
  if (!r.ok) {
    const mb = String(Math.round(F.IMPORT_MAX / 1048576));
    showFontMsg(r.why === "size"
      ? tsub("fontsImportTooBig", [mb], "文件太大（上限 " + mb + " MB）。")
      : r.why === "store"
        ? t("fontsImportStore", "没能存进浏览器，请再试一次。")
        : t("fontsImportBad", "这不是能用的字体文件。"), "err");
    return;
  }
  fontImports = await F.imports();
  // Whoever imports a font means to use it: it is in the popup's list for
  // as long as it exists (keptFontIds), no second press. Only the new font
  // is measured when next asked (verdicts are per id). The popup reads
  // fontImports itself.
  renderFonts();
  showFontMsg(tsub("fontsImported", [r.name], "已导入「" + r.name + "」"), "ok");
  previewFont(r.id);
  if ($("fontOnly") && $("fontOnly").checked) probeFontsFor(checkLang()).then(renderFonts);
}

async function dropImport(id) {
  const F = self.YTDS_FONTS;
  if (!F) return;
  await F.importRemove(id);
  fontImports = await F.imports();
  if (Array.isArray(fontKept) && fontKept.indexOf(id) >= 0) {
    fontKept = fontKept.filter((c) => c !== id);
    persistFonts();
  }
  for (const l of Object.keys(fontCov)) delete fontCov[l][id];
  // A line that was set to it goes back to System default: the copy is gone.
  try {
    chrome.storage.sync.get({ origFont: "system", transFont: "system" }, (g) => {
      const upd = {};
      if (F.isFont(g.origFont) && F.idOf(g.origFont) === id) upd.origFont = "system";
      if (F.isFont(g.transFont) && F.idOf(g.transFont) === id) upd.transFont = "system";
      if (Object.keys(upd).length) chrome.storage.sync.set(upd);
    });
  } catch (_e) { /* ignore */ }
  if (fontPreviewId === id) previewFont("");
  renderFonts();
  showFontMsg("", null);
  if ($("fontOnly") && $("fontOnly").checked) probeFontsFor(checkLang()).then(renderFonts);
}

function removeFont(id) {
  const F0 = self.YTDS_FONTS;
  const removedName = F0 ? F0.label(F0.valueOf(id), allFonts(), t) : id;
  // The list may be empty: "System default" is always there, so the popup's
  // dropdown never runs dry. A font in use stays in force and the popup keeps
  // naming it — removing it here only stops offering it.
  fontKept = keptFontIds().filter((c) => c !== id);
  persistFonts();
  fontFlashId = id;
  renderFonts();
  showFontMsg(tsub("fontsRemoved", [removedName], "已移出「" + removedName + "」"), "ok");
}

// Another window wrote the per-machine font state — the subtitle layer
// noting a video's language, or this page open in a second tab — and this
// page follows it. Its own writes come back here too and are no-ops.
async function fontsLocalChanged(c) {
  const F = self.YTDS_FONTS;
  let repaint = false;
  if (c.fontLangsSeen) {
    const v = Array.isArray(c.fontLangsSeen.newValue) ? c.fontLangsSeen.newValue.filter((x) => typeof x === "string") : [];
    if (JSON.stringify(v) !== JSON.stringify(fontLangsSeen)) { fontLangsSeen = v; paintFontLangSel(); }
  }
  if (c.fontKept) {
    const v = Array.isArray(c.fontKept.newValue) ? c.fontKept.newValue : null;
    if (JSON.stringify(v) !== JSON.stringify(fontKept)) { fontKept = v; repaint = true; }
  }
  if (c.fontImports && F) {
    const v = await F.imports();
    if (JSON.stringify(v) !== JSON.stringify(fontImports)) { fontImports = v; repaint = true; }
  }
  if (repaint) renderFonts();
}

function wantFonts() {
  fontsWanted = true;
  if (fontsInit === 0 && stateLoaded) initFonts();
}

async function initFonts() {
  if (fontsInit) return;
  fontsInit = 2;
  const F = self.YTDS_FONTS;
  if (!F) return;
  fontsInstalled = await F.list();
  fontImports = await F.imports();
  const loc = await new Promise((res) => {
    try { chrome.storage.local.get({ fontKept: null, fontLangsSeen: [] }, (g) => res(g || {})); }
    catch (_e) { res({}); }
  });
  fontKept = Array.isArray(loc.fontKept) ? loc.fontKept : null;
  fontLangsSeen = Array.isArray(loc.fontLangsSeen) ? loc.fontLangsSeen.filter((c) => typeof c === "string") : [];
  paintFontLangSel();
  paintFontOnlyLabel();
  renderFonts();
  previewFont("");
  paintFontSample();
}

// The translation language changed (here or in the popup): the dropdown,
// the switch's label, the count and the sample all follow it.
function fontsTargetChanged() {
  if (fontsInit !== 2) return;
  paintFontLangSel();
  paintFontOnlyLabel();
  paintFontSample();
  renderFonts();
  if ($("fontOnly") && $("fontOnly").checked) probeFontsFor(checkLang()).then(renderFonts);
}

let stateLoaded = false;

// ---- diagnostics ---------------------------------------------------------
// The builder lives in diag.js and is shared with the popup; this page passes
// its own state (target language, provider, model, voice) and gets the text.
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

function showTtsMsg(text, kind, detail) {
  const el = $("ttsMsg");
  el.textContent = text || "";
  el.className = "omsg" + (kind ? " " + kind : "");
  // The provider's own sentence under ours, the same way showMsg does it on
  // the translate side — a refusal's specific half ("voice not found") is the
  // half that tells the reader what to change.
  if (text && detail) {
    const line = document.createElement("span");
    line.className = "omsg-raw";
    line.textContent = detail;
    el.appendChild(line);
  }
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
  paintHeldKey({
    id: p.id, store: "ttsKeys",
    input: "ttsKey", show: "ttsShowKey", showWrap: "ttsShowKeyWrap",
    held: "ttsKeyHeld", heldText: "ttsKeyHeldText",
    placeholder: p.keyHint != null ? p.keyHint : "sk-…",
    onKey: (has) => { ttsStored[p.id] = has; }
  });
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
    // The typed name is the choice, but it need not be a guess: whatever the
    // server answered on /v1/audio/voices becomes the suggestion list. This is
    // the one provider we ship no voices for, which made it the one where a
    // reader had nothing to go on.
    const dl = $("ttsVoiceList");
    if (dl) {
      dl.textContent = "";
      for (const v of (fetchedVoices[p.id] || [])) {
        const o = document.createElement("option");
        o.value = v;
        dl.appendChild(o);
      }
    }
    // state.ttsVoice is whatever the provider IN USE is speaking with, which
    // is only this server's voice when this server is the one in use. Filling
    // the box from it while looking at a different provider handed Azure's
    // "en-US-AvaMultilingualNeural" to a custom endpoint — and typing then
    // appended to it, so the name that went out was a splice of the two.
    if (typedInp && document.activeElement !== typedInp && !typedInp.value &&
        state.ttsProvider === p.id) {
      typedInp.value = state.ttsVoice || "";
    }
    showTtsVoiceMsg("", null);
    const preview = $("ttsPreview");
    if (preview) preview.disabled = false;
    const keyField = $("ttsKey");
    if (keyField) {
      const field = keyField.closest(".ofield");
      if (field) field.hidden = false;
    }
    const testBtn = $("ttsTestBtn");
    if (testBtn) testBtn.hidden = false;
    // Last, so nothing above can undo it. This branch returns before the code
    // that dresses the select, and the fetch row lives down there — so it is
    // decided here, and decided by the capability rather than set true and
    // forgotten. (A line further up used to hide this row unconditionally,
    // from the days when a custom server was assumed to publish no voices.)
    const fetchRow = $("ttsFetchRow");
    if (fetchRow) fetchRow.hidden = !p.listVoices;
    const fetchOne = $("ttsFetchVoices");
    if (fetchOne) fetchOne.hidden = !p.listVoices;
    const backOne = $("ttsBackToFamily");
    if (backOne) backOne.hidden = true;        // there is no family to go back to
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
    if (p.localVoices) {
      // A machine can have plenty of voices and none that read the language
      // being translated into. The list falls back to all of them so there is
      // still something to choose, but silence about it is how an English
      // voice ends up reading Swahili — chosen by us, unremarked by either
      // surface.
      let sameLang = true;
      try {
        const sp = P.tts.localVoiceSplit(window.speechSynthesis, state.targetLang);
        sameLang = !sp || sp.matched !== false;
      } catch (_e) { /* keep quiet rather than warn on a broken read */ }
      const info = LANGS.get(state.targetLang);
      showTtsVoiceMsg(sameLang ? "" : tsub("ttsNoVoiceForLang",
        [(info && info.native) || state.targetLang],
        "这台电脑没有能读$1$的音色。下面列的是别的语言的音色——选中它，念出来就是那个语言的口音。"),
        sameLang ? null : "warn");
    }
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
  if (want && choices.includes(want)) {
    sel.value = want;
  } else if (p.defaultVoice && choices.includes(p.defaultVoice)) {
    // A voice stored for ANOTHER provider is not a choice here, and letting
    // the select fall to whatever happens to be first put "Xiaoxiao ·
    // 中文（简体）" in front of a reader on an English interface reading
    // English. This provider's own default is the honest starting point.
    sel.value = p.defaultVoice;
  }
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
// The same thing the translation pane does, on this side. The lists shipped
// here carry versions in their names — qwen3-tts-flash, tts-1,
// eleven_multilingual_v2 — so one day each is retired and the dropdown would
// go on offering it with nothing to notice. After a test that PASSED, ask.
// Enrichment, never a gate: a key that may not read the list keeps its working
// default and hears nothing about it.
function freshenTtsModels(p) {
  if (!p || !p.listModels) return;
  sendToBackground({ type: "ttsModels", provider: p.id })
    .then((resp) => {
      if (!resp || !resp.ok || !resp.models || !resp.models.length) return;   // silent
      if (ttsProvider() !== p) return;                  // the reader moved on
      const known = (p.models || []).slice();
      const fresh = resp.models.filter((m) => known.indexOf(m) === -1);
      if (!fresh.length && resp.models.length >= known.length) return;
      ttsFetchedModels[p.id] = resp.models;
      paintTtsModel(p);
      const chosen = $("ttsModelSel") ? $("ttsModelSel").value : "";
      if (chosen && resp.models.indexOf(chosen) === -1) {
        showTtsMsg(tsub("optModelRetired", [chosen],
          "「" + chosen + "」已经不在这家的清单里了——从上面重新选一个。"), "warn");
      }
    })
    .catch(() => { /* enrichment only */ });
}

// Models this provider actually answered with, per provider id. Empty until a
// test passes; the shipped list is what shows before that.
const ttsFetchedModels = Object.create(null);

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
  for (const m of (ttsFetchedModels[p.id] || p.models)) {
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
    renderSiteRow(p, "tts");
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
        ttsStored[p.id] = false;
        replacing[p.id] = false;
        paintTtsKeyField(p);
        paintTtsUse();             // clearing the stored provider's key re-locks
        renderList();              // …and the "in use" badge goes with the key
        // …and say so. This pane deleted a key in silence while the translation
        // pane, one panel away, announced the same act through an aria-live
        // region. Same sentence, already translated.
        showTtsMsg(t("byoKeyCleared", "已删除这台电脑上保存的 Key。"), null);
      });
    });
  });
  // The local engine previews without a round trip — same sentence, same
  // language, spoken by the machine.
  function speakLocalSample(voiceName) {
    const synth = window.speechSynthesis;
    // The browser's own voices have no key and no Save-and-test button on this
    // pane, so the cloud providers' failure line sends the reader looking for
    // two things that are not there. What is actually wrong is that this
    // computer has nothing to speak with.
    if (!synth) { showTtsMsg(t("ttsNoSynth", "这台电脑没有可用的朗读音色。"), "err"); return; }
    try { synth.cancel(); } catch (_e) { /* ignore */ }
    // cancel() does not clear the paused flag — it lives on speechSynthesis
    // itself and outlives whoever set it (a content script torn down mid-pause
    // is the usual way). Without this the Preview button is silent, and
    // nothing on this page can explain why.
    try { synth.resume(); } catch (_e) { /* ignore */ }
    const lang = state.targetLang || "zh-CN";
    const u = new SpeechSynthesisUtterance(
      (LANGS && LANGS.sample ? LANGS.sample(lang) : "") || "Hello.");
    u.lang = lang;
    const v = (synth.getVoices() || []).find((x) => x && x.name === voiceName);
    if (v) u.voice = v;
    try { synth.speak(u); } catch (_e) {
      showTtsMsg(t("ttsNoSynth", "这台电脑没有可用的朗读音色。"), "err");
    }
  }

  // One player for both doors into it: Preview, and Save-and-test once it has
  // proved the key. The blob is released when the line finishes.
  let previewAudio = null;

  // Stopping the line that is playing BECAUSE a new one is starting is not a
  // failure — but play()'s promise cannot tell the two apart: pausing an
  // element mid-play rejects it with AbortError, exactly as a codec fault
  // would. So the second press of Preview (or of Save-and-test, which plays a
  // sample too) printed "couldn't play it — check the key" about the FIRST
  // line, over a key that had just passed the test. Mark the element we stop
  // on purpose and let its rejection go quietly.
  function stopPreview() {
    if (!previewAudio) return;
    previewAudio.ytdsSuperseded = true;
    try { previewAudio.pause(); } catch (_e) { /* ignore */ }
    previewAudio = null;
  }

  function playPreview(resp, after) {
    const done = () => { if (after) after(); };
    if (!resp || !resp.b64) { done(); return; }
    stopPreview();
    try {
      const bin = atob(resp.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: resp.mime || "audio/mpeg" }));
      const el = new Audio(url);
      previewAudio = el;
      // A superseded element hands nothing back to its caller either: the
      // press that replaced it owns the button now, and letting the old
      // `after` run would re-enable it under the new line.
      const finish = (quiet) => {
        try { URL.revokeObjectURL(url); } catch (_e) { /* ignore */ }
        if (previewAudio === el) previewAudio = null;
        if (!quiet) done();
      };
      const failed = () => {
        if (el.ytdsSuperseded) { finish(true); return; }
        showTtsMsg(t("ttsPreviewFail", "播不出来——检查 Key，或先「保存并测通」"), "err");
        finish(false);
      };
      el.addEventListener("ended", () => finish(false));
      el.addEventListener("error", failed);
      el.play().catch(failed);
    } catch (_e) { done(); }
  }

  // Preview: hear the SELECTED voice — saved or not — speak a line in the
  // language being read. Nothing is written; the audio comes back with the
  // probe the worker already had to run, so this costs one synthesis and no
  // extra plumbing. Permissions are not requested here: only a provider whose
  // key went through Save-and-test can be previewed, and that flow already
  // granted the host.

  // The translation pane fetches its list with the key that is in the box,
  // saving it first without adopting the provider. This side refused with
  // "enter an API key first" while the key sat right there, typed.
  $("ttsFetchVoices").addEventListener("click", () => {
    const p = ttsProvider();
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    const typedNow = ($("ttsKey") && $("ttsKey").value.trim()) || "";
    if (!typedNow && !ttsStored[p.id] && !p.keyless) {
      showTtsMsg(errText("noKey"), "err"); return;
    }
    const btn = $("ttsFetchVoices");
    const label = t("ttsFetchVoices", "用你的 Key 拉取这个语言的完整音色清单");
    btn.disabled = true;
    btn.textContent = t("ttsFetching", "拉取中…");
    const done = () => { btn.disabled = false; btn.textContent = label; };
    showTtsVoiceMsg("", null);
    // A key typed but not yet saved has to reach storage before the worker can
    // use it — the same bargain the translation pane's fetch strikes. It does
    // NOT adopt the provider: asking a provider what it offers is a question,
    // not a decision.
    const keyReady = typedNow
      ? new Promise((resolve) => chrome.storage.local.get({ ttsKeys: {} }, (got) => {
          const keys = Object.assign({}, (got && got.ttsKeys) || {});
          keys[p.id] = typedNow;
          chrome.storage.local.set({ ttsKeys: keys }, () => { ttsStored[p.id] = true; resolve(); });
        }))
      : Promise.resolve();
    // Which provider and which language, same as the two probe buttons: this
    // button had the same two races and got neither fix at the time.
    keyReady.then(() =>
      sendToBackground({ type: "ttsVoices", provider: p.id, targetLang: state.targetLang }))
      .then((resp) => {
        if (!resp || !resp.ok) {
          // Falling back to the built-in family is the honest failure: a voice
          // list is not something a user can type in by hand.
          showTtsVoiceMsg(listErrText(resp && resp.code, p), "err");
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
        if (p.custom) {
          // Not "for this language" and not "switch back": a custom server's
          // voices are neither language-scoped nor a second tier over a family.
          showTtsVoiceMsg(extra.length
            ? tsub("ttsVoicesSuggested", [String(extra.length)],
                "拉到 " + extra.length + " 个音色，已作为上面输入框的候选。")
            : t("ttsVoicesNone", "这家在这个语言下没有额外音色——内置的那些照样能用。"),
            extra.length ? "ok" : null);
          done();
          return;
        }
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
    stopPreview();
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
          showTtsMsg(testErrText(resp && resp.code, p), "err", resp && resp.detail);
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
        if (!resp.b64) { showTtsMsg(errText(resp.code), "err", resp && resp.detail); done(); return; }
        playPreview(resp, done);
      })
      .catch((err) => { showTtsMsg(errText((err && err.code) || "failed"), "err"); done(); });
  });

  $("ttsTestBtn").addEventListener("click", () => {
    const p = ttsProvider();
    // Which provider was actually speaking before this press. persistTts writes
    // ttsProvider BEFORE the probe runs, so a test that fails used to leave the
    // extension pointed at the provider that just refused — the pane showed it
    // as "in use" and every spoken line failed afterwards. Saving the key is
    // still right (the reader typed it, and the next thing they fix may be the
    // region or the voice); adopting a provider that could not answer is not.
    const spokeBefore = state.ttsProvider;
    if (!p) { showTtsMsg(errText("noProvider"), "err"); return; }
    const typed = $("ttsKey").value.trim();
    // An empty key is a valid custom configuration (no Authorization header)
    // — the same bargain the translation pane's custom entry strikes.
    if (!typed && !ttsStored[p.id] && !p.custom) { showTtsMsg(errText("noKey"), "err"); return; }
    // The address is read synchronously: permissions.request() below must be
    // reached inside the click gesture, so nothing may await before it.
    let customBase = null;
    if (p.custom) {
      if (P.urlCarriesSecret($("ttsBaseUrl").value)) { showTtsMsg(errText("urlHasKey"), "err"); return; }
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
            if (!resp || !resp.ok) {
              // Put the engine back where it was; the key stays saved.
              if (spokeBefore && spokeBefore !== p.id) {
                state.ttsProvider = spokeBefore;
                chrome.storage.sync.set({ ttsProvider: spokeBefore });
                renderList();
              }
            }
            if (resp && resp.ok) {
              freshenTtsModels(p);
              const kb = Math.max(1, Math.round((resp.bytes || 0) / 1024));
              showTtsMsg(tsub("ttsTestOk", [String(kb), voiceLabel(resp.voice || "")],
                "连接成功：试音 " + kb + " KB（" + (resp.voice || "") + "）"), "ok");
              // It already synthesized a real line; a byte count is a poor
              // substitute for hearing it.
              playPreview(resp);
            } else {
              showTtsMsg(testErrText(resp && resp.code, p), "err", resp && resp.detail);
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
        // The translate pane's copy of "which providers have a key" and "which
        // have proved one" is read once at boot, and the popup can empty both
        // from another window — Reset all settings does exactly that. Without
        // this the pane went on showing "saved ····1234" and a configured tick
        // for a key that is gone, and the next Save-and-test failed on a key
        // this page believed it still had. Same treatment the read-aloud half
        // has had since it shipped.
        if (changes.byoKeys || changes.byoOk) {
          if (changes.byoKeys) {
            const held = (changes.byoKeys.newValue) || {};
            for (const id of Object.keys(storedKeys)) delete storedKeys[id];
            for (const id of Object.keys(held)) storedKeys[id] = true;
          }
          if (changes.byoOk) {
            const ok = (changes.byoOk.newValue) || {};
            for (const id of Object.keys(verifiedOk)) delete verifiedOk[id];
            for (const id of Object.keys(ok)) verifiedOk[id] = true;
          }
          // A draft the reader is in the middle of typing is never repainted
          // away — the same bargain the read-aloud side strikes below.
          const cur = current();
          if (cur && $("key") && !$("key").value) paintKeyField(cur);
          if (listSec === "setup") renderList();
        }
        if (changes.ttsKeys) {
          paintTtsUse();                       // a key appearing/vanishing flips the lock
          const p = ttsProvider();
          if (p && $("ttsKey") && !$("ttsKey").value) paintTtsKeyField(p);
          ttsKeysRefresh();                    // …and a tick appears or goes
        }
        if (fontsInit === 2 && (changes.fontLangsSeen || changes.fontKept || changes.fontImports)) fontsLocalChanged(changes);
        return;
      }
      if (area !== "sync") return;
      const c = changes;
      // The per-provider model memory is read once at boot and written back on
      // every save. A reset from the popup removes the key; without this the
      // next save here restored every remembered model from a stale copy.
      if (c.byoModelBy) {
        const v = c.byoModelBy.newValue;
        modelsBy = Object.assign(Object.create(null), (v && typeof v === "object") ? v : {});
      }
      if (c.engine) {
        state.engine = String(c.engine.newValue || "");
        paintAfterSetupNote(state.engine);
      }
      if (c.origFont || c.transFont) {
        if (c.origFont) state.origFont = String(c.origFont.newValue || "system");
        if (c.transFont) state.transFont = String(c.transFont.newValue || "system");
        if (fontsInit === 2) paintMirrorFonts();
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
        fontsTargetChanged();
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
  $("fontSearch").addEventListener("input", () => renderFonts());
  $("fontOnly").addEventListener("change", () => { fontProbeTries[checkLang()] = 0; renderFonts(); });   // a press is a fresh ask
  $("fontLang").addEventListener("change", onFontLangChange);
  $("fontReset").addEventListener("click", () => {
    fontKept = null;
    persistFonts();
    if ($("fontSearch")) $("fontSearch").value = "";   // "no match" right after a reset would mislead
    renderFonts();
    showFontMsg(t("fontsResetDone", "已恢复默认列表。"), "ok");
  });
  $("fontImportBtn").addEventListener("click", () => $("fontImportFile").click());
  $("fontImportFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";                 // the same file again must re-trigger
    if (file) importFontFile(file);
  });
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
    // Refused before it reaches sync: an address with a key in it would be
    // copied to the browser account, which the key field never is.
    if (P.urlCarriesSecret(e.target.value)) {
      e.target.setAttribute("aria-invalid", "true");
      showMsg(errText("urlHasKey", current()), "err");
      return;
    }
    e.target.removeAttribute("aria-invalid");
    state.byoBaseUrl = e.target.value.trim();
    chrome.storage.sync.set({ byoBaseUrl: state.byoBaseUrl });
    const p = current();
    if (p && p.custom) paintNeedBanner(p, !!storedKeys[p.id]);
  });

  $("showKey").addEventListener("change", (e) => {
    $("key").type = e.target.checked ? "text" : "password";
  });
  $("key").addEventListener("input", () => {
    paintShowKey("key", "showKeyWrap");
    const p = current(); if (p) paintModelGate(p);   // typing a key unlocks the model row at once
  });
  $("ttsKey").addEventListener("input", () => paintShowKey("ttsKey", "ttsShowKeyWrap"));

  // "Replace" only swaps the clothes: the old key stays until a new one is
  // saved, so backing out costs nothing. Cancel puts the row back.
  $("keyReplace").addEventListener("click", () => {
    const p = current(); if (!p) return;
    replacing[p.id] = true;
    paintKeyField(p);
    const inp = $("key"); if (inp) { try { inp.focus(); } catch (_e) {} }
  });
  $("ttsKeyReplace").addEventListener("click", () => {
    const p = ttsProvider(); if (!p) return;
    replacing[p.id] = true;
    paintTtsKeyField(p);
    const inp = $("ttsKey"); if (inp) { try { inp.focus(); } catch (_e) {} }
  });
  // Deleting the key of the provider the extension is TRANSLATING with used to
  // change nothing except the key: this list went on calling it "in use", the
  // popup called it "not set up · Configure…", and a second provider with a
  // working key sat one row away, never offered — the popup's picker only
  // appears once two are set up. The translation-language pane has answered
  // this shape for a long time: take away the one in use and it moves to
  // another and says which. Same act, same answer.
  function successorFor(p) {
    // The same predicate this list uses for its ✓: a stored key, or — for the
    // one that needs none — a Save-and-test that actually answered. Without
    // that second half the handover walked people onto a local Ollama they may
    // never have run, which is a worse dead end than the one being fixed.
    const pool = providerList().filter((q) =>
      q.id !== p.id && (storedKeys[q.id] || (q.noKey && verifiedOk[q.id])));
    return pool.find((q) => verifiedOk[q.id]) || pool[0] || null;
  }

  $("keyClear").addEventListener("click", async () => {
    const p = current();
    if (!p) return;
    await saveKey(p.id, null);
    markVerified(p.id, false);
    replacing[p.id] = false;
    let moved = null;
    if (state.byoProvider === p.id) {
      moved = successorFor(p);
      if (moved) {
        state.byoProvider = moved.id;
        chrome.storage.sync.set({ byoProvider: moved.id });
      }
    }
    paintKeyField(p);
    renderList();
    // The red line under the model row belonged to the key that is now gone;
    // leaving it up puts two contradictory sentences on one screen.
    showModelMsg("", null);
    showMsg(moved
      ? tsub("byoKeyClearedMoved", [providerLabel(moved)],
          "已删除这台电脑上保存的 Key。原来用的是它，现在改用 $1$。")
      : t("byoKeyCleared", "已删除这台电脑上保存的 Key。"), null);
    // The button that was pressed leaves with the row it sat in, so focus has
    // to be put somewhere on purpose or it falls to the body and a keyboard
    // reader loses their place.
    const back = $("key");
    if (back && !back.hidden) { try { back.focus(); } catch (_e) { /* ignore */ } }
  });

  $("testBtn").addEventListener("click", () => {
    withSetup($("testBtn"), t("byoTesting", "测试中…"),
      (code) => showMsg(testErrText(code, current()), "err"), runTest);
  });

  $("fetchModels").addEventListener("click", () => {
    withSetup($("fetchModels"), t("optFetching", "拉取中…"),
      (code) => showModelMsg(listErrText(code, current()), "err"), runFetchModels, false);
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
    byoModelBy: {}, byoSiteBy: {},
    ttsProvider: "local-speech", ttsVoice: "", engine: "auto",
    origFont: "system", transFont: "system" },
  (got) => {
    state = Object.assign(state, got || {});
    paintAfterSetupNote(state.engine);
    modelsBy = Object.assign(Object.create(null), (got && got.byoModelBy) || {});
    siteBy = Object.assign(Object.create(null), (got && got.byoSiteBy) || {});
    // The active provider's model is authoritative for it — older profiles have
    // byoModel but no byoModelBy yet.
    if (state.byoProvider && state.byoModel && !modelsBy[state.byoProvider]) {
      modelsBy[state.byoProvider] = state.byoModel;
    }
    langKept = (got && Array.isArray(got.langShown) && got.langShown.length)
      ? LANGS.shown(got.langShown) : null;
    renderLangs();
    stateLoaded = true;
    if (fontsWanted) initFonts();
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
