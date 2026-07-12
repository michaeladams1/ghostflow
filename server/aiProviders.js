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

// Model names above are current as of this writing but providers rename/retire
// models frequently. If a call fails with a "model not found" style error,
// check the provider's current model list and update the *_MODEL env var
// (no code change needed) rather than editing this file.

export async function callClaude(prompt, { system } = {}) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
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
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });
  if (!res.ok) throw new Error(`GPT error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function callGrok(prompt, { system } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: XAI_MODEL, messages }),
  });
  if (!res.ok) throw new Error(`Grok error ${res.status}: ${await res.text()}`);
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

export async function callClaudeWithTools(system, userPrompt, tools, executeTool) {
  const claudeTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let messages = [{ role: "user", content: userPrompt }];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { model: ANTHROPIC_MODEL, max_tokens: MAX_TOKENS, system, messages };
    if (claudeTools.length) body.tools = claudeTools; // omit `tools` entirely when empty — an empty array is rejected

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
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
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GPT error ${res.status}: ${await res.text()}`);
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
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${XAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Grok error ${res.status}: ${await res.text()}`);
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
