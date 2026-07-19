// AI analyst client functions — Claude, GPT, Grok. Keys read from process.env
// only, never from the client. This is just the connection layer: sending a
// prompt and getting text back. The actual per-trade analysis prompts and
// structured-output parsing (the real "thesis engine" logic) is the next
// build step, not this one.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1";

const XAI_KEY = process.env.XAI_API_KEY;
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.3";

// Exported so callers (analysis.js) can record which exact model string was
// actually used on every analysis, in the database, permanently — not
// something to trust blindly. Whether an env var override took effect on a
// given deploy is a verifiable fact from here on, not a guess.
export const CONFIGURED_MODELS = { claude: ANTHROPIC_MODEL, gpt: OPENAI_MODEL, grok: XAI_MODEL };

// Model names above are current as of this writing but providers rename/retire
// models frequently. If a call fails with a "model not found" style error,
// check the provider's current model list and update the *_MODEL env var
// (no code change needed) rather than editing this file.

// TIMEOUT ON EVERY OUTBOUND CALL. Found after a real incident: a stalled
// connection to a data provider (accepted, never responded, no error) left
// a plain `await fetch()` hanging with NO possible resolution — no timeout
// meant no failure, which meant no retry, which meant the entire sequential
// background pipeline sat blocked for 9+ hours on one unlucky request. AI
// calls are the same shape of risk (network hiccup, provider-side stall), so
// every call below goes through this instead of a bare fetch(). 120s is
// generous — large system prompts + reasoning models are legitimately slow —
// but guarantees a call eventually FAILS (and gets logged, and the pipeline's
// existing per-model try/catch moves on) instead of hanging forever.
async function fetchWithTimeout(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callClaude(prompt, { system } = {}) {
  const res = await fetchAIWithRetry("Claude", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096, // bumped from 1024 — with a reasoning-heavy model, a small
      // budget can be entirely consumed before any final text is produced,
      // yielding an empty response rather than a truncated one.
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("");
  if (!text) {
    throw new Error(`Claude returned no text content (stop_reason: ${data.stop_reason}, blocks: ${data.content.map((b) => b.type).join(",")})`);
  }
  return text;
}

export async function callGPT(prompt, { system } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await fetchAIWithRetry("GPT", "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function callGrok(prompt, { system } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await fetchAIWithRetry("Grok", "https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: XAI_MODEL, messages }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

// ---------- Tool-calling versions ----------
// These let the model request additional data mid-analysis (e.g. Grok
// fetching QQQ on its own) rather than being limited to what we pre-fetched.
// MAX_TOOL_ITERATIONS is a circuit breaker against an infinite loop costing
// money indefinitely — not a limit on what the model can legitimately fetch;
// 8 rounds is generous headroom for a single trade's analysis.
const MAX_TOOL_ITERATIONS = 8;

// A full 29-feed review plus rule + falsification does not fit in 4096 tokens.
// Claude hit stop_reason: "max_tokens" and returned NOTHING (a reasoning model
// can burn its whole budget before emitting any text). 16k gives real headroom.
const MAX_TOKENS = 16000;

// These calls carry the large system prompt (29-feed review, full rule
// vocabulary, falsification instructions) and produce a long structured
// response — a real, legitimately slow call, not a stall. The first live
// run after adding timeouts actually hit the general 120s default here and
// got killed mid-response. 240s gives real reasoning room while still
// guaranteeing this can never again hang the multi-hour way the untimed
// version did.
const TOOL_CALL_TIMEOUT_MS = 240000;

// RETRY FOR THE MODEL CALLS THEMSELVES. The market-data client has always
// retried; the AI calls never did — one flaky response killed that analyst
// for the entire analysis. This is not hypothetical: OpenAI intermittently
// returned 401 "insufficient permissions" on identical requests with the
// same key that succeeded minutes before and after (NEXA, VSTS, MAN). 401
// is normally a permanent auth failure you should NOT retry, but here it is
// observably transient, so it earns a place next to 408/429/5xx. Permanent
// failures still fail — just after 3 attempts (~15s) instead of instantly.
const RETRYABLE_STATUS = new Set([401, 408, 429, 500, 502, 503, 529]);
const RETRY_DELAYS_MS = [2000, 5000, 10000];

async function fetchAIWithRetry(name, url, options, timeoutMs) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let retryable = true;
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;
      const text = await res.text();
      retryable = RETRYABLE_STATUS.has(res.status);
      lastErr = new Error(`${name} error ${res.status}: ${text}`);
    } catch (err) {
      lastErr = err; // network error / timeout — retryable
    }
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw lastErr;
    const delay = RETRY_DELAYS_MS[attempt];
    console.warn(`[aiProviders] ${name} transient failure (attempt ${attempt + 1}), retrying in ${delay}ms: ${String(lastErr.message).slice(0, 140)}`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastErr;
}

export async function callClaudeWithTools(system, userPrompt, tools, executeTool) {
  const claudeTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let messages = [{ role: "user", content: userPrompt }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { model: ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, system, messages };
    if (claudeTools.length) body.tools = claudeTools; // omit `tools` entirely when empty — an empty array is rejected

    const res = await fetchAIWithRetry("Claude", "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    }, TOOL_CALL_TIMEOUT_MS);
    const data = await res.json();

    const toolUses = data.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = data.content.map((b) => b.text || "").join("");
      if (!text) throw new Error(`Claude returned no text content (stop_reason: ${data.stop_reason})`);
      return text;
    }

    messages.push({ role: "assistant", content: data.content });
    const toolResults = [];
    for (const call of toolUses) {
      const result = await executeTool(call.input);
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }
  throw new Error(`Claude exceeded ${MAX_TOOL_ITERATIONS} tool-call rounds without a final answer`);
}

export async function callGPTWithTools(system, userPrompt, tools, executeTool) {
  const openaiTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  let messages = [{ role: "system", content: system }, { role: "user", content: userPrompt }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { model: OPENAI_MODEL, messages };
    if (openaiTools.length) body.tools = openaiTools;
    const res = await fetchAIWithRetry("GPT", "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, TOOL_CALL_TIMEOUT_MS);
    const data = await res.json();
    const msg = data.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) return msg.content;

    messages.push(msg);
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await executeTool(args);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`GPT exceeded ${MAX_TOOL_ITERATIONS} tool-call rounds without a final answer`);
}

export async function callGrokWithTools(system, userPrompt, tools, executeTool) {
  // xAI's endpoint is OpenAI-compatible, so this mirrors callGPTWithTools.
  const xaiTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  let messages = [{ role: "system", content: system }, { role: "user", content: userPrompt }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { model: XAI_MODEL, messages };
    if (xaiTools.length) body.tools = xaiTools;
    const res = await fetchAIWithRetry("Grok", "https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${XAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, TOOL_CALL_TIMEOUT_MS);
    const data = await res.json();
    const msg = data.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) return msg.content;

    messages.push(msg);
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await executeTool(args);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`Grok exceeded ${MAX_TOOL_ITERATIONS} tool-call rounds without a final answer`);
}
