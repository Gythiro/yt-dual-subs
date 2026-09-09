// providers.js — BYO-key translation providers (shared by the service worker,
// the popup and the options page). Loaded via importScripts() in background.js
// and plain <script> tags elsewhere, so it must stay dependency-free and assign
// onto the global.
//
// "kind" picks the adapter:
//   "llm"   -> OpenAI-compatible /chat/completions (numbered-line batch protocol)
//   "deepl" -> DeepL v2 REST (natively batched, free/pro endpoint from the key)
//
// origin is what we ask for at runtime (chrome.permissions.request); it MUST be
// declared in manifest.optional_host_permissions or the request is rejected.
//
// extraHeaders / extraBody are per-provider request additions. extraBody exists
// for one reason: several Chinese endpoints default their "flash" models into
// chain-of-thought mode, which triples latency and can return an empty content
// field. DashScope takes enable_thinking:false to turn it off — measured on
// deepseek-v4-flash: 7.2s -> 1.8s for the same six-line batch, identical output
// (R3-S3, 2026-07-25). Never send it to a provider that has not been checked:
// OpenAI rejects unknown body params outright.
//
// models[] is a SHORT curated list for the dropdown, and only for providers we
// have actually run. Everything else ships empty on purpose: the options page
// fills the list from the user's own key via GET /models, which cannot go stale
// the way a hard-coded default does (gemini-2.0-flash was already answering 429
// on free keys by the time we tested it).
//
// tint/initials drive the placeholder monogram tile in the options list until a
// real brand mark is added in provider-icons.js.

(function (root) {
  "use strict";

  const PROVIDERS = [
    {
      id: "deepseek", name: "DeepSeek", short: "DeepSeek", kind: "llm",
      baseUrl: "https://api.deepseek.com/v1",
      origin: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
      models: [],
      keyUrl: "https://platform.deepseek.com/api_keys",
      pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      tint: "#4D6BFE", initials: "DS"
    },
    {
      id: "openai", name: "OpenAI", short: "OpenAI", kind: "llm",
      baseUrl: "https://api.openai.com/v1",
      origin: "https://api.openai.com",
      // Deliberately blank: the GPT line moves fast and a stale default reads as
      // a broken extension. The options page pulls the live list instead.
      defaultModel: "",
      models: [],
      keyUrl: "https://platform.openai.com/api-keys",
      pricingUrl: "https://openai.com/api/pricing/",
      tint: "#10A37F", initials: "AI"
    },
    {
      id: "gemini", name: "Google Gemini", short: "Gemini", kind: "llm",
      // Gemini speaks OpenAI's shape on this sub-path only.
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      origin: "https://generativelanguage.googleapis.com",
      // "…-latest" tracks the current flash model. Pinning a version is how the
      // default goes stale: gemini-2.0-flash answers 429 "quota exceeded" on a
      // free key (verified R3-S3), which reads to the user as a broken add-on.
      defaultModel: "gemini-flash-latest",
      models: ["gemini-flash-latest", "gemini-flash-lite-latest"],
      keyUrl: "https://aistudio.google.com/apikey",
      pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
      tint: "#4285F4", initials: "G"
    },
    {
      id: "claude", name: "Anthropic Claude", short: "Claude", kind: "llm",
      baseUrl: "https://api.anthropic.com/v1",
      origin: "https://api.anthropic.com",
      defaultModel: "",
      models: [],
      keyUrl: "https://platform.claude.com/settings/keys",
      pricingUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
      // Anthropic blocks browser-originated calls unless this opt-in is present.
      // UNVERIFIED — no key on hand; see 01-S3实测结果.md §3.
      extraHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
      tint: "#D97757", initials: "C"
    },
    {
      id: "grok", name: "xAI Grok", short: "Grok", kind: "llm",
      baseUrl: "https://api.x.ai/v1",
      origin: "https://api.x.ai",
      defaultModel: "",
      models: [],
      keyUrl: "https://console.x.ai/",
      pricingUrl: "https://docs.x.ai/developers/pricing",
      tint: "#5A5A5A", initials: "X"
    },
    {
      id: "kimi", name: "Kimi (Moonshot)", short: "Kimi", kind: "llm",
      baseUrl: "https://api.moonshot.cn/v1",
      origin: "https://api.moonshot.cn",
      defaultModel: "",
      models: [],
      keyUrl: "https://platform.kimi.com/console/api-keys",
      pricingUrl: "https://platform.kimi.com/docs/pricing/chat",
      tint: "#1F2937", initials: "K"
    },
    {
      id: "glm", name: "智谱 GLM", nameKey: "provGlm", short: "GLM", kind: "llm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      origin: "https://open.bigmodel.cn",
      defaultModel: "",
      models: [],
      keyUrl: "https://bigmodel.cn/usercenter/apikeys",
      pricingUrl: "https://bigmodel.cn/pricing",
      tint: "#3859FF", initials: "智"
    },
    {
      id: "qwen", name: "Alibaba 百炼 (Qwen / DeepSeek)", nameKey: "provQwen",
      short: "百炼", shortKey: "provQwenShort", kind: "llm",
      // The generic host serves workspace-scoped ("sk-ws-…") Bailian keys too,
      // verified R3-S3 — so users never need the custom-endpoint path for it.
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      origin: "https://dashscope.aliyuncs.com",
      defaultModel: "qwen-flash",
      // Verified working on this endpoint (R3-S3). deepseek-v4-flash only keeps
      // its 1.8s figure because of extraBody below.
      models: ["qwen-flash", "deepseek-v4-flash", "qwen3.7-flash"],
      keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
      pricingUrl: "https://help.aliyun.com/zh/model-studio/model-pricing",
      extraBody: { enable_thinking: false },
      tint: "#FF6A00", initials: "百"
    },
    {
      id: "doubao", name: "豆包 (火山方舟)", nameKey: "provDoubao",
      short: "豆包", shortKey: "provDoubaoShort", kind: "llm",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      origin: "https://ark.cn-beijing.volces.com",
      // Ark takes an endpoint id (ep-...) rather than a public model name.
      defaultModel: "",
      models: [],
      keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apikey",
      pricingUrl: "https://www.volcengine.com/docs/82379/1544106",
      tint: "#1664FF", initials: "豆"
    },
    {
      id: "siliconflow", name: "SiliconFlow 硅基流动", nameKey: "provSiliconflow", short: "SiliconFlow", kind: "llm",
      baseUrl: "https://api.siliconflow.cn/v1",
      origin: "https://api.siliconflow.cn",
      defaultModel: "",
      models: [],
      keyUrl: "https://cloud.siliconflow.cn/account/ak",
      pricingUrl: "https://siliconflow.cn/pricing",
      tint: "#6E56CF", initials: "SF"
    },
    {
      id: "openrouter", name: "OpenRouter", short: "OpenRouter", kind: "llm",
      baseUrl: "https://openrouter.ai/api/v1",
      origin: "https://openrouter.ai",
      defaultModel: "",
      models: [],
      keyUrl: "https://openrouter.ai/keys",
      pricingUrl: "https://openrouter.ai/pricing",
      tint: "#6467F2", initials: "OR"
    },
    {
      id: "deepl", name: "DeepL", short: "DeepL", kind: "deepl",
      // Endpoint is picked from the key itself (":fx" suffix = Free tier), so
      // both origins ship in the whitelist and baseUrl is informational.
      baseUrl: "https://api-free.deepl.com",
      origin: "https://api-free.deepl.com",
      altOrigins: ["https://api.deepl.com"],
      defaultModel: "",
      models: [],
      keyUrl: "https://www.deepl.com/pro-api",
      pricingUrl: "https://www.deepl.com/pro",
      tint: "#0F2B46", initials: "DL"
    },
    {
      id: "custom", name: "Custom (OpenAI-compatible)", nameKey: "byoCustom",
      kind: "llm",
      custom: true,
      short: "Custom", shortKey: "byoCustom",
      baseUrl: "",
      origin: "",
      defaultModel: "",
      models: [],
      keyUrl: "",
      pricingUrl: "",
      // Slate, not the plain grey it shared with Grok — the two sat in the
      // list as the same colourless tile (the icon review, 2026-08-28).
      tint: "#5C6B7A", initials: "…"
    }
  ];

  const BY_ID = Object.create(null);
  for (const p of PROVIDERS) BY_ID[p.id] = p;

  function get(id) { return BY_ID[id] || null; }

  // Every origin we may ever ask for, for the manifest whitelist + audits.
  function allOrigins() {
    const out = [];
    for (const p of PROVIDERS) {
      if (p.origin) out.push(p.origin);
      if (p.altOrigins) out.push(...p.altOrigins);
    }
    return out;
  }

  // Everything we would request for one provider, as match patterns. DeepL gets
  // both hosts at once: the free/pro split follows the key, and prompting again
  // after a plan change would read as a bug.
  function originsFor(provider, customOrigin) {
    if (!provider) return [];
    if (provider.custom) return customOrigin ? [customOrigin + "/*"] : [];
    return [provider.origin + "/*"].concat((provider.altOrigins || []).map((o) => o + "/*"));
  }

  // https only — with one carved-out exception — no credentials in the URL,
  // no trailing slash. Returns { baseUrl, origin } or null — the single gate
  // for user-supplied endpoints.
  //
  // The exception: plain http is allowed for the loopback hosts (localhost /
  // 127.0.0.1 / [::1]) and nothing else. The https rule exists to keep API
  // keys off cleartext networks; loopback traffic never reaches a network, so
  // the rule has nothing to protect there — and refusing it is what kept
  // local model servers (Ollama on 11434, LM Studio on 1234) unusable
  // (issue #4). "localhost." with a trailing dot and lookalike subdomains
  // (localhost.evil.com) resolve elsewhere and stay refused.
  //
  // Accepts EITHER a base URL or a full endpoint. Provider docs hand out the
  // full ".../v1/chat/completions" form as often as the base, and pasting that
  // into a base-URL field would otherwise produce
  // ".../chat/completions/chat/completions" and a 404 the user cannot explain.
  function isLoopbackHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }
  function parseCustomBase(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch (_e) { return null; }
    if (u.protocol !== "https:" &&
        !(u.protocol === "http:" && isLoopbackHost(u.hostname))) return null;
    if (u.username || u.password) return null;
    const path = u.pathname
      .replace(/\/+$/, "")
      .replace(/\/chat\/completions$/, "")
      .replace(/\/completions$/, "");
    return { baseUrl: u.origin + path, origin: u.origin };
  }

  // Endpoint for a resolved config. DeepL Free keys end in ":fx".
  function endpointFor(provider, cfg) {
    if (!provider) return "";
    if (provider.kind === "deepl") {
      const free = /:fx$/.test(String((cfg && cfg.key) || ""));
      return (free ? "https://api-free.deepl.com" : "https://api.deepl.com") + "/v2";
    }
    const base = (cfg && cfg.baseUrl) || provider.baseUrl || "";
    return base.replace(/\/+$/, "");
  }

  // Model ids worth offering for subtitle translation. Gemini returns them
  // prefixed with "models/", and every provider mixes in things that cannot
  // translate a line of text (embeddings, TTS, image, rerank) or that would be
  // far too slow (reasoning/thinking variants — see the reasoning error code).
  const MODEL_REJECT =
    /embed|rerank|tts|audio|speech|image|vision|ocr|video|guard|moderation|whisper|search|live|realtime|codex|thinking|reasoner|-r1\b/i;

  function usableModels(ids) {
    const seen = new Set();
    const out = [];
    for (const raw of ids || []) {
      const id = String(raw || "").replace(/^models\//, "");
      if (!id || MODEL_REJECT.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.sort();
  }

  // Error code (from background.js) -> i18n key. Lives here so the popup and
  // the options page cannot drift apart on what a code means.
  // A voice id is not a name. "zh-CN-XiaoxiaoMultilingualNeural" tells a user
  // nothing they can act on, and a dropdown of thirteen of them is a wall.
  // Azure bakes the two facts that matter into the id — who the voice is, and
  // which language it grew up speaking, which is the accent it carries into
  // every other one — so the label is parsed rather than kept in a table that
  // would drift from the list above. Providers whose ids are already words
  // (alloy, Kore) are left alone.
  // A provider locale ("zh-CN", "en-US") onto one of our fifty target-language
  // codes, so the label can borrow the language's own name from languages.js
  // instead of keeping a second list of them here.
  const VOICE_LOCALE_LANG = {
    "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "en-GB": "en",
    "en-AU": "en", "ja-JP": "ja", "ko-KR": "ko", "de-DE": "de", "fr-FR": "fr",
    "fr-CA": "fr", "es-ES": "es", "es-MX": "es", "it-IT": "it",
    "pt-BR": "pt", "pt-PT": "pt", "ru-RU": "ru", "nl-NL": "nl", "pl-PL": "pl",
    "tr-TR": "tr", "sv-SE": "sv", "th-TH": "th", "vi-VN": "vi", "id-ID": "id",
    "ar-SA": "ar", "hi-IN": "hi", "uk-UA": "uk"
  };

  // Chirp 3 HD ships the same thirty names across every locale it supports, and
  // the gender belongs to the voice, not to the locale. Checked against
  // Google's own voices.list for cmn-CN and en-US (2026-08-22): thirty names in
  // both, zero disagreements — so one table answers for all fifty target
  // languages. Google publishes this; nothing here is invented. It is the one
  // understandable thing about a menu of star names, and the cheapest possible
  // equivalent of what Azure's ids already carry.
  const CHIRP3_GENDER = {
    Achernar: "f", Achird: "m", Algenib: "m", Algieba: "m", Alnilam: "m",
    Aoede: "f", Autonoe: "f", Callirrhoe: "f", Charon: "m", Despina: "f",
    Enceladus: "m", Erinome: "f", Fenrir: "m", Gacrux: "f", Iapetus: "m",
    Kore: "f", Laomedeia: "f", Leda: "f", Orus: "m", Puck: "m",
    Pulcherrima: "f", Rasalgethi: "m", Sadachbia: "m", Sadaltager: "m",
    Schedar: "m", Sulafat: "f", Umbriel: "m", Vindemiatrix: "f",
    Zephyr: "f", Zubenelgenubi: "m"
  };

  // Which engine generation a fetched Google id belongs to. The id carries it,
  // so the menu can group by it instead of listing four families as one wall.
  // The provider is optional and only matters for the one case where the id
  // carries no tier but the voice still belongs to one: a Google family short
  // name ("Achernar") IS a Chirp 3 HD voice — the worker builds the full id
  // from it. Without this the collapsed names from mergeFetched land in the
  // untiered bucket and Google's best tier is the one group with no heading.
  function ttsVoiceTier(voiceId, p) {
    const m = /^[a-z]{2,3}-[A-Z]{2}-(Chirp3-HD|Neural2|Wavenet|Standard|Studio|Polyglot)-/
      .exec(String(voiceId || ""));
    if (m) return m[1];
    if (p && p.kind === "google-tts" && (p.voices || []).indexOf(voiceId) >= 0) return "Chirp3-HD";
    return "";
  }

  // A fetched id and a built-in short name are often the SAME voice under two
  // spellings: Google answers "cmn-CN-Chirp3-HD-Achernar" for the "Achernar"
  // already in the family list, and an exact-string merge kept both. Measured
  // against the live list on 2026-08-22: of the 38 voices cmn-CN returns, 30
  // were that, so the button's real yield is eight and the menu it produced was
  // 44% echo. Keeping the SHORT name is the deliberate half of this: the short
  // one follows the reader across all fifty languages, the full one is pinned
  // to the language it was fetched for.
  //
  // What the first version got wrong: it DROPPED the echo, and the language
  // catalogue then showed only what was left. Those thirty were not noise —
  // they are Chirp 3 HD, the best tier Google sells and the one the default
  // (Kore) lives in, and the fetch answering with them is positive proof they
  // work in this language. So pressing "fetch" made the thirty best voices,
  // and the default among them, vanish from the menu until you pressed the way
  // back. Reported on a real machine as "拉取音色后变成这样了".
  // So: the echo is COLLAPSED onto the short name, not dropped. Same one-entry-
  // per-voice result, same short spelling that follows the reader — but the
  // voice stays on the menu. Confirmed names come first: they are the better
  // tier, and the family default is among them.
  function ttsMergeFetched(p, fetched) {
    const family = (p && p.voices) || [];
    const seen = new Set();
    const confirmed = [];
    const fresh = [];
    for (const id of fetched || []) {
      if (!id) continue;
      const echoOf = family.find((b) => id === b || id.slice(-(b.length + 1)) === "-" + b);
      const keep = echoOf || id;
      if (seen.has(keep)) continue;
      seen.add(keep);
      (echoOf ? confirmed : fresh).push(keep);
    }
    return confirmed.concat(fresh);
  }

  // Turn an id into something a person can choose between. Three shapes reach
  // here and each carries a different useful fact:
  //   Azure       — who the voice is, and the accent its home locale gives it
  //   Chirp 3     — a star name, which says nothing, plus a published gender
  //   Google full — the engine generation, which is the real difference between
  //                 cmn-CN-Wavenet-A and cmn-CN-Standard-A
  // Anything else is returned untouched rather than mangled into a guess.
  // The nine ElevenLabs ids this extension ships are that service's own
  // long-standing defaults, and every one of them has a name people know it
  // by. Without this the menu is nine twenty-character tokens — measured on a
  // real machine and reported as "the voices are all garbled", which is
  // exactly what an opaque id looks like when the row beside it says Achernar.
  const ELEVEN_NAMES = {
    "21m00Tcm4TlvDq8ikWAM": ["Rachel", "f"],
    "AZnzlk1XvdvUeBnXmlld": ["Domi", "f"],
    "EXAVITQu4vr4xnSDxMaL": ["Bella", "f"],
    "ErXwobaYiN019PkySvjV": ["Antoni", "m"],
    "MF3mGyEYCl7XYWbV9V6O": ["Elli", "f"],
    "TxGEqnHWrfWFTfGW9XjX": ["Josh", "m"],
    "VR6AewLTigWG4xSOukaG": ["Arnold", "m"],
    "pNInz6obpgDQGcFmaJgB": ["Adam", "m"],
    "yoZ06aMxZJJ28mfd3POQ": ["Sam", "m"]
  };

  function ttsVoiceLabel(voiceId, langNativeName, genderWord) {
    const id = String(voiceId || "");
    const el = ELEVEN_NAMES[id];
    if (el) {
      const g = genderWord ? genderWord(el[1]) : "";
      return g ? el[0] + " · " + g : el[0];
    }
    // Azure numbers its revisions inside the name — Xiaoxiao2, JennyV2 — so the
    // name part has to admit digits here exactly as the shape check does, or a
    // voice that is accepted for speaking is still shown as a raw id.
    // Match the whole middle rather than trying to spell Azure's taxonomy in
    // one pattern: it stacks decorations (Multilingual, Turbo, Dialects) and
    // then numbers the revision after them — JennyMultilingualV2Neural. A
    // pattern that guesses the order drops the names it does not predict back
    // to a raw id, which is the failure this is here to prevent.
    const az = /^([a-z]{2,3})-([A-Z]{2})-(.+)Neural$/.exec(id);
    if (az) {
      const person = az[3].replace(/(?:Multilingual|Turbo|Dialects)(?:V\d+)?$/, "") || az[3];
      const code = VOICE_LOCALE_LANG[az[1] + "-" + az[2]];
      const home = code && langNativeName ? langNativeName(code) : "";
      return home ? person + " · " + home : person;
    }
    const tier = ttsVoiceTier(id);
    if (tier) {
      const rest = id.slice(id.indexOf(tier) + tier.length + 1);
      // A Chirp 3 full id is the same voice as the short name we already ship;
      // label it the same way so the two spellings never read as two voices.
      if (tier === "Chirp3-HD") return ttsVoiceLabel(rest, langNativeName, genderWord);
      return tier + " · " + rest;
    }
    const g = CHIRP3_GENDER[id];
    if (g) {
      const word = genderWord ? genderWord(g) : "";
      return word ? id + " · " + word : id;
    }
    return id;
  }

  // The machine's own voices, narrowed to the language being read. Chrome
  // fills this table asynchronously and the first synchronous call is empty,
  // so every caller also has to repaint on "voiceschanged" — this decides only
  // WHICH of the arrived voices belong to the language. Both surfaces read it
  // from here rather than each keeping its own copy: the popup and the
  // settings page disagreeing about what is on offer is how the picker starts
  // naming a voice that is not the one speaking. Falling back to the whole set
  // when nothing matches beats an empty menu — some systems tag a voice with
  // the base language only.
  // Apple ships two packs of machine voices with every Mac — Eloquence (the
  // eight names below, each cloned per language) and the Effects novelties.
  // Measured on a real profile: 111 of 199 voices were these. They are
  // accessibility voices, not junk, so they stay choosable — but at the
  // BOTTOM, under their own heading (the maintainer's call, 2026-08-24),
  // burying the usable ones. Matched by the base name before the bracket;
  // macOS localises voice names on non-English systems, in which case the
  // match simply misses and the voice stays in the main list — degraded, not
  // wrong. Windows has neither pack, so the group never appears there.
  const MAC_MACHINE_VOICES = new Set([
    // Eloquence
    "Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley",
    // Effects
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
    "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper",
    "Wobble", "Zarvox"
  ]);
  function ttsLocalVoiceIsMachine(name) {
    const base = String(name || "").split(" (")[0];
    return MAC_MACHINE_VOICES.has(base);
  }

  // The one list both surfaces render, split so both can head the machine
  // voices the same way. localVoiceNames stays the flat answer — ordinary
  // voices first, machine voices last — so every existing caller gets the
  // ordering for free.
  function ttsLocalVoiceSplit(synth, lang) {
    if (!synth) return { normal: [], machine: [] };
    let all = [];
    try { all = synth.getVoices() || []; } catch (_e) { return { normal: [], machine: [] }; }
    const base = String(lang || "").split("-")[0].toLowerCase();
    const hit = all.filter(
      (v) => String(v.lang || "").toLowerCase().split("-")[0] === base);
    const names = (hit.length ? hit : all).map((v) => v.name);
    return {
      normal: names.filter((n) => !ttsLocalVoiceIsMachine(n)),
      machine: names.filter(ttsLocalVoiceIsMachine)
    };
  }

  function ttsLocalVoiceNames(synth, lang) {
    const s = ttsLocalVoiceSplit(synth, lang);
    return s.normal.concat(s.machine);
  }

  // A fetched voice is not in the built-in table, so it is recognised by shape:
  // Azure ships "<lang>-<REGION>-<Name>Neural", Google full names that already
  // carry their locale and family. Anything else is not this provider's and is
  // refused rather than spliced into a request that cannot work.
  function ttsVoiceShapeOk(p, voice) {
    // The name part carries digits in Azure's own catalogue — Xiaoxiao2Neural,
    // JennyMultilingualV2Neural are how it numbers revisions. Spelling it
    // [A-Za-z]+ refused every one of them, so a voice the settings page had
    // just fetched and offered was replaced by the default without a word.
    // Still alphanumeric and still anchored to the -Neural suffix, so nothing
    // that could rewrite a request gets through.
    if (p.kind === "azure-speech") return /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(voice);
    if (p.kind === "google-tts") {
      // The family segment is not enumerated. Google has shipped Journey, News,
      // Casual and Chirp-HD since this line was written, and a list of family
      // names refuses a voice the user has just FETCHED FROM GOOGLE — the one
      // kind of name that is certainly real — so the family default spoke
      // instead. Unlike Azure and ElevenLabs, this value goes into a JSON field
      // rather than a URL, so what has to be excluded is a separator, not an
      // unfamiliar word: locale prefix, then hyphen-joined alphanumerics only.
      return /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(voice);
    }
    // ElevenLabs ids are opaque 20-character tokens; anything else did not come
    // from its list and must not be pasted into a URL path.
    if (p.kind === "elevenlabs") return /^[A-Za-z0-9]{16,32}$/.test(voice);
    return false;
  }

  // "Does this voice belong to this provider" — the one question the engine and
  // both pickers have to answer the same way. They did not: the worker counted
  // the built-in family PLUS anything shaped like this provider's (which is
  // what fetching a language's voices hands back), while the popup counted the
  // family alone. So a fetched voice was drawn as the family default and the
  // menu named Kore while the engine spoke cmn-CN-Neural2-C. Same disease as
  // the usability predicate that had to be pulled together in 1bf5ee4.
  function ttsVoiceOwned(p, voice) {
    if (!p || !voice) return false;
    // The local engine's voices are whatever this machine has; the page that
    // enumerated them is the only authority, so nothing here can vet them.
    if (p.localVoices) return true;
    if ((p.voices || []).includes(voice)) return true;
    return !!p.listVoices && ttsVoiceShapeOk(p, voice);
  }

  // Which locale each provider speaks a target language in. These live here
  // rather than in the worker because both pickers need the same answer: a
  // voice fetched for one language must not be NAMED by a menu when the
  // engine will not use it for the language being read now.
  // Chirp 3 HD locales, per Google's published list (untested against a live
  // key — the machine-check clause of the read-aloud test drive covers this).
  // A target language that is not in the family is an honest unsupportedTarget,
  // never an English voice mangling someone else's language.
  const GOOGLE_TTS_LANG = {
    "en": "en-US", "de": "de-DE", "es": "es-ES", "fr": "fr-FR", "it": "it-IT",
    "ja": "ja-JP", "ko": "ko-KR", "nl": "nl-NL", "pl": "pl-PL", "pt": "pt-BR",
    "ru": "ru-RU", "th": "th-TH", "tr": "tr-TR", "vi": "vi-VN", "id": "id-ID",
    "hi": "hi-IN", "ar": "ar-XA", "uk": "uk-UA", "sw": "sw-KE", "bn": "bn-IN",
    "mr": "mr-IN", "ta": "ta-IN", "te": "te-IN", "ur": "ur-IN",
    // Chirp 3 grew from 29 locales to 57 between the 2026-01 snapshot this table
    // was written from and 2026-08. Everything below was being told "this
    // provider does not support your language" while Google supported it all
    // along — a wrong answer, not a missing feature.
    "sv": "sv-SE", "da": "da-DK", "no": "nb-NO", "fi": "fi-FI", "cs": "cs-CZ",
    "el": "el-GR", "hu": "hu-HU", "ro": "ro-RO", "bg": "bg-BG", "sk": "sk-SK",
    "sl": "sl-SI", "hr": "hr-HR", "sr": "sr-RS", "lt": "lt-LT", "lv": "lv-LV",
    "et": "et-EE", "iw": "he-IL",
    // Traditional Chinese has no Chirp 3 locale of its own; mainland Mandarin is
    // the closest voice Google offers, and saying nothing at all would be worse.
    "zh-CN": "cmn-CN", "zh-TW": "cmn-CN"
    // Still genuinely absent from Chirp 3, and correctly reported as such:
    // fa, ms, fil, af, ca, eu, is.
  };

  // Our fifty target codes onto the Azure locale whose voices speak them. Only
  // needed to narrow the "list every voice" response — synthesis itself needs no
  // locale, because the multilingual family follows the text.
  const AZURE_TTS_LOCALE = {
    "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en": "en-US", "ja": "ja-JP",
    "ko": "ko-KR", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "ru": "ru-RU",
    "pt": "pt-BR", "it": "it-IT", "ar": "ar-SA", "hi": "hi-IN", "id": "id-ID",
    "th": "th-TH", "vi": "vi-VN", "nl": "nl-NL", "pl": "pl-PL", "tr": "tr-TR",
    "uk": "uk-UA", "sv": "sv-SE", "da": "da-DK", "no": "nb-NO", "fi": "fi-FI",
    "cs": "cs-CZ", "el": "el-GR", "hu": "hu-HU", "ro": "ro-RO", "bg": "bg-BG",
    "sk": "sk-SK", "sl": "sl-SI", "hr": "hr-HR", "sr": "sr-RS", "lt": "lt-LT",
    "lv": "lv-LV", "et": "et-EE", "iw": "he-IL", "fa": "fa-IR", "bn": "bn-IN",
    "ta": "ta-IN", "te": "te-IN", "mr": "mr-IN", "ur": "ur-PK", "ms": "ms-MY",
    "fil": "fil-PH", "sw": "sw-KE", "af": "af-ZA", "ca": "ca-ES", "eu": "eu-ES",
    "is": "is-IS"
  };

  // Does this voice apply to the language being read RIGHT NOW? A short family
  // name always does — that is what "follows the reader" means. A fetched name
  // carries the locale it was fetched for, and outside that locale the engine
  // falls back to the family default. A menu that keeps naming it there is the
  // same lie as naming a voice from another provider.
  function ttsVoiceAppliesTo(p, voice, targetLang) {
    if (!p || !voice) return false;
    // The family this extension SHIPS is cross-language by construction — that
    // is the whole reason those twelve Azure entries are the Multilingual ones.
    // Their ids carry a locale because that is where the accent comes from, not
    // where the voice may be used, and reading the prefix as a restriction
    // threw the family out: measured 10 of 12 refused while reading Chinese and
    // 12 of 12 reading Taiwanese Chinese, the default among them. Only a voice
    // from OUTSIDE this list — one the user fetched for a particular language —
    // is pinned to it.
    if ((p.voices || []).indexOf(voice) >= 0) return true;
    const carried = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice);
    if (!carried) return true;
    const want = p.kind === "google-tts" ? GOOGLE_TTS_LANG[targetLang || ""]
      : p.kind === "azure-speech" ? AZURE_TTS_LOCALE[targetLang || ""] : "";
    return !want || carried[1] === want;
  }

  const ERROR_KEYS = {
    noProvider: "byoErrNoProvider",
    noKey: "byoErrNoKey",
    noModel: "byoErrNoModel",
    badBaseUrl: "byoErrBadBaseUrl",
    noPerm: "byoErrNoPerm",
    auth: "byoErrAuth",
    limited: "byoErrLimited",
    quota: "byoErrQuota",
    badRequest: "byoErrBadRequest",
    badShape: "byoErrBadShape",
    reasoning: "byoErrReasoning",
    netfail: "byoErrNetfail",
    unsupportedTarget: "byoErrUnsupportedTarget",
    noRegion: "ttsErrNoRegion",
    // Read-aloud's own "the provider said no": byoErrBadRequest names a model
    // name and a base URL, and the read-aloud card has neither field.
    refused: "ttsErrRefused",
    // …and its own "nothing came back to play": badShape asks for a
    // non-thinking model, which is a sentence about translation.
    noAudio: "ttsErrNoAudio"
  };

  function errorKey(code) {
    return ERROR_KEYS[code] || "byoErrFailed";
  }

  // ---- read-aloud (TTS) providers ----------------------------------------
  // A separate registry: synthesis is not translation, and the two feed
  // different pickers with different lifecycles. The voices listed for Azure
  // and Google are their MULTILINGUAL families on purpose: the text being
  // spoken is the translation, which can be any of the 50 target languages,
  // so a voice pinned to one language would be wrong the moment the user
  // switches targets. Their two hosts ship in optional_host_permissions
  // together with the PRIVACY paragraph and the store justification (§7.5C —
  // the same change or nothing).
  const TTS_PROVIDERS = [
    {
      id: "openai-tts", name: "OpenAI TTS", short: "OpenAI", kind: "openai-speech",
      baseUrl: "https://api.openai.com/v1",
      origin: "https://api.openai.com",
      defaultModel: "gpt-4o-mini-tts",
      // The documented speech models. gpt-4o-mini-tts is the default (the
      // newer voices need it); tts-1/-hd stay for anyone matching older docs.
      models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
      // The speech voices are a fixed, documented set — no list endpoint to ask.
      // The documented set, all of them cross-language. ballad/verse/marin/cedar
      // arrived after the first cut and need gpt-4o-mini-tts, which is the
      // default model above.
      voices: ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
               "marin", "nova", "onyx", "sage", "shimmer", "verse"],
      defaultVoice: "alloy",
      keyHint: "sk-…",
      keyUrl: "https://platform.openai.com/api-keys",
      pricingUrl: "https://openai.com/api/pricing/",
      tint: "#10A37F", initials: "AI"
    },
    {
      id: "google-tts", name: "Google Cloud TTS", short: "Google", kind: "google-tts",
      baseUrl: "https://texttospeech.googleapis.com",
      origin: "https://texttospeech.googleapis.com",
      defaultModel: "",
      // Chirp 3 HD short names; the worker builds "<locale>-Chirp3-HD-<name>"
      // from the CURRENT target language (see GOOGLE_TTS_LANG in background.js),
      // so one picked voice follows the user across languages.
      // The full documented Chirp 3 set. Eight was a cut made when there was
      // no way to hear one before choosing it; Preview makes the rest useful
      // rather than a wall of names.
      voices: [
        "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede",
        "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome",
        "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus",
        "Pulcherrima", "Puck", "Rasalgethi", "Sadachbia", "Sadaltager",
        "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr",
        "Zubenelgenubi"
      ],
      defaultVoice: "Kore",
      // Google can be asked for the voices of ONE language; the built-in list
      // above stays as the offline answer and as the cross-language family.
      listVoices: true,
      keyHint: "AIza…",
      keyUrl: "https://console.cloud.google.com/apis/credentials",
      pricingUrl: "https://cloud.google.com/text-to-speech/pricing",
      tint: "#4285F4", initials: "G"
    },
    {
      // The only one that asks for nothing. Chrome already ships voices; this
      // is the entry that lets someone hear the feature at all before deciding
      // whether it is worth an API key — and the answer to "read-aloud needs a
      // paid account" being the first thing a new user meets. Quality is
      // whatever the operating system has, and it speaks locally, so nothing
      // here can reach a network: no key, no host, no request.
      id: "local-speech", name: "浏览器内置（免费）", nameKey: "provLocalSpeech",
      short: "浏览器", kind: "local-speech",
      baseUrl: "", origin: "",
      keyless: true,
      // The machine decides. The settings page fills this from
      // speechSynthesis.getVoices() for the language being read.
      voices: [], defaultVoice: "",
      localVoices: true,
      keyHint: "",
      tint: "#5f6368", initials: "◎"
    },
    {
      // The one provider whose key many users already have: 百炼 is a
      // translation provider here too, and its host is already declared. Its
      // reason to exist next to the others is what none of them offer —
      // Chinese regional voices (Beijing, Shanghai, Sichuan, Cantonese…) —
      // and Mandarin that Chinese listeners rate above the global engines.
      id: "qwen-tts", name: "阿里云百炼 Qwen-TTS", nameKey: "provQwenTts",
      short: "Qwen-TTS", kind: "qwen-tts",
      baseUrl: "https://dashscope.aliyuncs.com",
      origin: "https://dashscope.aliyuncs.com",
      defaultModel: "qwen3-tts-flash",
      // The documented sisters on the same endpoint; the console lists more
      // (dated snapshots, realtime) that the picker's free-entry can reach.
      models: ["qwen3-tts-flash", "qwen3-tts-instruct-flash", "qwen-tts"],
      // A spread rather than all forty-eight (a wall of names helps nobody):
      // Mandarin personas of both genders, the international-flavoured ones,
      // and the dialects — which are the reason to pick this provider at all.
      // Widened 12→22 on the maintainer's "阿里这个音色特别好" (2026-08-28);
      // the full documented list stays in the official voice-list page.
      voices: [
        "Cherry", "Serena", "Ethan", "Chelsie", "Momo", "Vivian", "Moon",
        "Kai", "Neil", "Seren", "Nofish",
        "Jennifer", "Ryan", "Katerina",
        "Dylan", "Jada", "Sunny", "Eric", "Rocky", "Kiki", "Li", "Peter"
      ],
      defaultVoice: "Cherry",
      keyHint: "sk-…",
      keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
      pricingUrl: "https://help.aliyun.com/zh/model-studio/models",
      tint: "#FF6A00", initials: "百"
    },
    {
      // The one to reach for when the language is not Chinese: a voice library
      // an order of magnitude larger than anyone else's, cross-language like
      // OpenAI's, and its own cloned voices if the user has made any. Plain
      // binary mp3, which is the cleanest shape any of these providers has.
      id: "elevenlabs", name: "ElevenLabs", nameKey: "provElevenlabs", short: "ElevenLabs", kind: "elevenlabs",
      baseUrl: "https://api.elevenlabs.io",
      origin: "https://api.elevenlabs.io",
      // Multilingual v2 is the default on purpose: v3 speaks more languages
      // but is not the model a new key reaches first, and the store copy must
      // describe what people actually get.
      defaultModel: "eleven_multilingual_v2",
      // The current API model family: v2 is the safe default, the 2.5 pair is
      // cheaper/faster, v3 is the newest and the reason this picker exists.
      models: ["eleven_multilingual_v2", "eleven_turbo_v2_5",
               "eleven_flash_v2_5", "eleven_v3"],
      // Voice ids, not names — ElevenLabs identifies by id and the label comes
      // from the list endpoint. These are the documented stock voices.
      voices: [
        "21m00Tcm4TlvDq8ikWAM", "AZnzlk1XvdvUeBnXmlld", "EXAVITQu4vr4xnSDxMaL",
        "ErXwobaYiN019PkySvjV", "MF3mGyEYCl7XYWbV9V6O", "TxGEqnHWrfWFTfGW9XjX",
        "VR6AewLTigWG4xSOukaG", "pNInz6obpgDQGcFmaJgB", "yoZ06aMxZJJ28mfd3POQ"
      ],
      defaultVoice: "21m00Tcm4TlvDq8ikWAM",
      listVoices: true,
      keyHint: "sk_…",
      keyUrl: "https://elevenlabs.io/app/settings/api-keys",
      pricingUrl: "https://elevenlabs.io/pricing",
      tint: "#000000", initials: "11"
    },
    {
      id: "azure-speech", name: "Azure Speech", short: "Azure", kind: "azure-speech",
      // The real endpoint is region-scoped: https://<region>.tts.speech…;
      // the region comes from settings (needsRegion below), baseUrl is unused.
      baseUrl: "",
      origin: "https://*.tts.speech.microsoft.com",
      needsRegion: true,
      defaultModel: "",
      // The Multilingual neural family switches language by itself — the only
      // kind that can follow a translation whose language the user may change.
      // Multilingual voices only — one voice follows the user across all fifty
      // target languages (the strategy decided 2026-08-20). The home locale is
      // still audible in the accent, so the list covers the flavours our users
      // actually read in rather than only American English: Chinese first,
      // since "the Chinese voices are better elsewhere" is what prompted this.
      voices: [
        "zh-CN-XiaoxiaoMultilingualNeural", "zh-CN-YunfanMultilingualNeural",
        "ja-JP-MasaruMultilingualNeural", "ko-KR-HyunsuMultilingualNeural",
        "en-US-AvaMultilingualNeural", "en-US-AndrewMultilingualNeural",
        "en-US-EmmaMultilingualNeural", "en-US-BrianMultilingualNeural",
        "de-DE-SeraphinaMultilingualNeural", "fr-FR-VivienneMultilingualNeural",
        "es-ES-ArabellaMultilingualNeural", "it-IT-IsabellaMultilingualNeural"
      ],
      defaultVoice: "en-US-AvaMultilingualNeural",
      // Azure lists every voice it has, with no language filter — the worker
      // narrows it to the language being read before anything reaches a menu.
      listVoices: true,
      keyHint: "",
      keyUrl: "https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices",
      pricingUrl: "https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/",
      tint: "#0078D4", initials: "Az"
    }
  ];
  const TTS_BY_ID = Object.create(null);
  for (const p of TTS_PROVIDERS) TTS_BY_ID[p.id] = p;

  root.YTDS_PROVIDERS = {
    list: PROVIDERS,
    get,
    allOrigins,
    originsFor,
    parseCustomBase,
    endpointFor,
    usableModels,
    errorKey,
    tts: {
      list: TTS_PROVIDERS,
      get: (id) => TTS_BY_ID[id] || null,
      voiceLabel: ttsVoiceLabel,
      localVoiceNames: ttsLocalVoiceNames,
      localVoiceSplit: ttsLocalVoiceSplit,
      voiceShapeOk: ttsVoiceShapeOk,
      voiceOwned: ttsVoiceOwned,
      voiceTier: ttsVoiceTier,
      mergeFetched: ttsMergeFetched,
      voiceAppliesTo: ttsVoiceAppliesTo,
      localeFor: { google: GOOGLE_TTS_LANG, azure: AZURE_TTS_LOCALE }
    }
  };
})(typeof self !== "undefined" ? self : this);
