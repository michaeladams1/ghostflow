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
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((b) => b.text || "").join("");
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
