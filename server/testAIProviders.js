// Connectivity test for all 3 AI providers. Run locally with:
//   node --env-file=.env server/testAIProviders.js
// Sends one trivial prompt to each so you know the keys work before we build
// the real per-trade analysis logic on top.

import { callClaude, callGPT, callGrok } from "./aiProviders.js";

async function tryOne(name, fn) {
  console.log(`--- ${name} ---`);
  try {
    const reply = await fn("Reply with exactly one short sentence confirming you're working.");
    console.log("Connected:", reply.trim());
  } catch (err) {
    console.error(`${name} connection failed:`, err.message);
  }
  console.log("");
}

async function main() {
  await tryOne("Claude", callClaude);
  await tryOne("GPT", callGPT);
  await tryOne("Grok", callGrok);
}

main();
