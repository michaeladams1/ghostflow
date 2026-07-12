import { fetchAllEndpoints } from "./quantDataClient.js";
import { buildBriefing, renderBriefing } from "./compress.js";

const bundle = await fetchAllEndpoints({
  ticker: "META", sessionDate: "2026-07-10",
  startDate: "2026-06-25", endDate: "2026-07-10",
});
const briefing = buildBriefing(bundle);
console.log(renderBriefing(briefing));
console.log(`\n\n[prompt size: ${renderBriefing(briefing).length} chars]`);
