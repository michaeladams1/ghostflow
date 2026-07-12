// Tests the JSON repair pipeline against the failure modes models actually
// produce — including the one that killed Claude's 29-feed analysis.

import { extractJsonWithRepair } from "./jsonRepair.js";

const CASES = [
  ["clean JSON", '{"verdict":"tradeable","endpointReview":[{"id":"net_drift","used":true}]}'],

  ["wrapped in code fences", '```json\n{"verdict":"tradeable","confidence":80}\n```'],

  ["prose before and after", 'Here is my analysis:\n{"verdict":"noise"}\nHope that helps!'],

  ["trailing comma in array", '{"endpointReview":[{"id":"a"},{"id":"b"},]}'],

  ["trailing comma in object", '{"verdict":"tradeable","confidence":80,}'],

  ["literal newline inside a string value (very common model slip)",
    '{"notes":"GEX was positive.\nBut price ran anyway.","verdict":"noise"}'],

  ["tab inside a string",
    '{"notes":"volume\tspiked at 10:00","verdict":"noise"}'],

  ["smart quotes from prose",
    '{"notes":\u201Cthe move was not knowable\u201D,"verdict":"noise"}'],

  ["missing comma between array elements (Claude's actual failure shape)",
    '{"endpointReview":[{"id":"net_drift","used":true,"notes":"fired at 13:43"}{"id":"net_flow","used":false,"notes":"nothing"}]}'],
];

let pass = 0, fail = 0;

for (const [label, input] of CASES) {
  try {
    const out = await extractJsonWithRepair(input, { modelId: "test" }); // no callModel = mechanical repair only
    console.log(`OK    ${label}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${label}`);
    console.log(`        -> ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} repaired mechanically, ${fail} would need a model round-trip.`);
console.log(`(Anything in the second group still gets recovered in production — the model is`);
console.log(` handed its own broken output plus the parser error and asked to fix the syntax.)`);
