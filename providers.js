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
      id: "glm", name: "智谱 GLM", short: "GLM", kind: "llm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      origin: "https://open.bigmodel.cn",
      defaultModel: "",
      models: [],
      keyUrl: "https://bigmodel.cn/usercenter/apikeys",
      pricingUrl: "https://bigmodel.cn/pricing",
      tint: "#3859FF", initials: "智"
    },
    {
      id: "qwen", name: "Alibaba 百炼 (Qwen / DeepSeek)", short: "百炼", kind: "llm",
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
      id: "doubao", name: "豆包 (火山方舟)", short: "豆包", kind: "llm",
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
      id: "siliconflow", name: "SiliconFlow 硅基流动", short: "SiliconFlow", kind: "llm",
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
      id: "custom", name: "Custom (OpenAI-compatible)", kind: "llm",
      custom: true,
      baseUrl: "",
      origin: "",
      defaultModel: "",
      models: [],
      keyUrl: "",
      pricingUrl: "",
      tint: "#5A5A5A", initials: "…"
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

  // https only, no credentials in the URL, no trailing slash. Returns
  // { baseUrl, origin } or null — the single gate for user-supplied endpoints.
  //
  // Accepts EITHER a base URL or a full endpoint. Provider docs hand out the
  // full ".../v1/chat/completions" form as often as the base, and pasting that
  // into a base-URL field would otherwise produce
  // ".../chat/completions/chat/completions" and a 404 the user cannot explain.
  function parseCustomBase(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch (_e) { return null; }
    if (u.protocol !== "https:") return null;
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
    unsupportedTarget: "byoErrUnsupportedTarget"
  };

  function errorKey(code) {
    return ERROR_KEYS[code] || "byoErrFailed";
  }

  root.YTDS_PROVIDERS = {
    list: PROVIDERS,
    get,
    allOrigins,
    originsFor,
    parseCustomBase,
    endpointFor,
    usableModels,
    errorKey
  };
})(typeof self !== "undefined" ? self : this);
