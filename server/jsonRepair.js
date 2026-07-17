// ROBUST JSON EXTRACTION FROM MODEL OUTPUT.
//
// WHY THIS EXISTS:
// Claude returned a 29-feed review — thousands of words of free-text notes —
// and ONE malformed character at position 10753 threw the entire response away.
// The model had done the work, the API call cost real money, and the analysis
// was discarded over punctuation. Then the model got excluded from the vote and
// the UI just said "Analysis failed".
//
// That is a terrible trade. A parse error is not a reasoning error. So instead
// of giving up we:
//   1. Try a plain parse.
//   2. Try mechanical repairs for the failure modes models actually produce
//      (trailing commas, unescaped control characters, smart quotes, code fences).
//   3. If it still won't parse, hand the model its own broken output and the
//      exact parser error, and ask it to return valid JSON. This preserves the
//      reasoning instead of throwing it away.
//
// Only after all three fail is the model genuinely excluded.

function stripFences(text) {
  return String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
}

function sliceToObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Mechanical repairs for the ways LLMs actually break JSON. Deliberately
// conservative — each fix targets a specific, common failure and none of them
// can change the MEANING of valid JSON.
function repairJson(raw) {
  let s = raw;

  // Smart quotes from prose leaking into string values.
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");

  // Literal newlines/tabs inside string values (a very common model slip —
  // JSON requires them escaped). Walk the string and escape control chars that
  // appear while we're inside a quoted value.
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\") { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      // Other control characters are illegal inside JSON strings.
      if (ch.charCodeAt(0) < 0x20) { continue; }
    }
    out += ch;
  }
  s = out;

  // ILLEGAL ESCAPE SEQUENCES — a backslash followed by anything other than
  // the 9 characters JSON allows to be escaped ( " \ / b f n r t u ). Models
  // do this constantly with things like "\sigma", "\theta", or a Windows path
  // pasted into a note — none of those are valid JSON escapes, and
  // JSON.parse rejects the ENTIRE document over one stray backslash ("Bad
  // escaped character"). The model meant a literal backslash, so we escape
  // the backslash itself (\X -> \\X), turning it into a legal escaped-
  // backslash followed by an ordinary character — this cannot change the
  // meaning of any ALREADY-valid escape sequence, since those are left alone.
  {
    const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
    let out2 = "";
    let inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) { out2 += ch; esc = false; continue; }
      if (ch === "\\") {
        if (inStr && !VALID_ESCAPES.has(s[i + 1])) {
          out2 += "\\\\"; // treat as a literal backslash, not an escape
          continue;
        }
        out2 += ch; esc = true; continue;
      }
      if (ch === '"') { inStr = !inStr; out2 += ch; continue; }
      out2 += ch;
    }
    s = out2;
  }

  // Trailing commas before a closing brace/bracket.
  s = s.replace(/,\s*([}\]])/g, "$1");

  // MISSING COMMA BETWEEN ARRAY ELEMENTS — this is the exact failure that killed
  // a full 29-feed Claude analysis ("Expected ',' or ']' after array element").
  // With 29 objects in a row, the model dropped one separator. `}{` and `]["`
  // are never valid JSON in any context, so inserting the comma is safe and
  // cannot change the meaning of a well-formed document.
  //
  // Applied OUTSIDE strings only — a literal "}{" inside a note would otherwise
  // get corrupted.
  {
    let out = "";
    let inString = false, escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = !inString; out += ch; continue; }

      if (!inString && (ch === "}" || ch === "]")) {
        // Look ahead past whitespace for the start of another element.
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === "{" || s[j] === "[") {
          out += ch + ",";
          continue;
        }
      }
      out += ch;
    }
    s = out;
  }

  return s;
}

// Attempts a parse, returning { ok, value, error }.
function tryParse(text) {
  const sliced = sliceToObject(stripFences(text));
  if (!sliced) return { ok: false, error: "No JSON object found in the response." };

  try {
    return { ok: true, value: JSON.parse(sliced) };
  } catch (e1) {
    try {
      return { ok: true, value: JSON.parse(repairJson(sliced)), repaired: true };
    } catch (e2) {
      return { ok: false, error: e2.message, raw: sliced };
    }
  }
}

// The full pipeline: parse -> repair -> ask the model to fix its own JSON.
// `callModel(system, user)` should be a bound provider call.
export async function extractJsonWithRepair(rawText, { callModel, modelId } = {}) {
  const first = tryParse(rawText);
  if (first.ok) {
    if (first.repaired) console.log(`[json] ${modelId}: repaired malformed JSON mechanically`);
    return first.value;
  }

  if (!callModel) {
    throw new Error(`Could not parse JSON: ${first.error}`);
  }

  // LAST RESORT: give the model its own broken output plus the parser's exact
  // complaint. The reasoning is already done and paid for — this recovers it
  // rather than discarding a full 29-feed analysis over a stray character.
  console.log(`[json] ${modelId}: JSON invalid (${first.error}) — asking model to repair its own output`);

  const system = `You produce ONLY valid, parseable JSON. No prose, no markdown, no code fences. Nothing before or after the JSON object.`;
  const user = `The JSON below is malformed. A strict JSON parser rejected it with this error:

  ${first.error}

Return the SAME content — every field, every array element, every note, with the same meaning — but as VALID JSON. Do not summarise, shorten, or drop anything. Do not add commentary. Fix only the syntax.

Common causes to check: an unescaped double-quote inside a string value, a literal newline inside a string, a trailing comma, or a missing comma between array elements.

BROKEN JSON:
${first.raw}`;

  const repairedText = await callModel(system, user);
  const second = tryParse(repairedText);
  if (second.ok) {
    console.log(`[json] ${modelId}: model successfully repaired its own JSON`);
    return second.value;
  }

  throw new Error(`JSON unparseable even after repair attempt: ${second.error}`);
}
