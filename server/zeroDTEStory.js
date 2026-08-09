// THE STORY — turns the session's fires and simulated trades into plain
// English a human can read at 4pm and actually learn from. Deterministic:
// no AI, no invented detail. Every sentence traces to a computed value.
//
// "Nothing was setting up today" is a first-class ending here. The tool must
// never manufacture a trade to have something to say.

import { pickOtmStrike } from "./zeroDTE.js";

const money = (n) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const sizeToDollars = (s) => Number(String(s || "").replace(/[^0-9.]/g, "")) || 0;

// The playbook's own grading language, applied to what actually fired.
function gradeOf(fire) {
  if (fire.tier === "A+") return fire.mtfAligned ? "A+ (MTF aligned)" : "A+";
  if (fire.tier === "A") return "A-tier";
  return "RSI Extreme";
}

export function buildSessionStory({ symbol = "SPY", sessionDate, levels, gap, fires, bars }) {
  const lines = [];
  const open = bars.find((b) => b.inSession);
  const rth = bars.filter((b) => b.inSession);
  const close = rth[rth.length - 1];
  const dayHigh = Math.max(...rth.map((b) => b.high));
  const dayLow = Math.min(...rth.map((b) => b.low));

  // --- 1. What the day looked like before you traded it ---
  lines.push({
    heading: "The setup going in",
    body: `${symbol} opened at $${open?.open?.toFixed(2)} and closed at $${close?.close?.toFixed(2)}, ranging between $${dayLow.toFixed(2)} and $${dayHigh.toFixed(2)}. `
      + `Yesterday's high (PDH) was $${levels.pdh?.toFixed(2)} and yesterday's low (PDL) was $${levels.pdl?.toFixed(2)}. `
      + `Pre-market ran $${levels.pml?.toFixed(2)} to $${levels.pmh?.toFixed(2)}. `
      + `The opening 5-minute range was $${levels.orLow?.toFixed(2)}–$${levels.orHigh?.toFixed(2)}; the 15-minute range was $${levels.orb15Low?.toFixed(2)}–$${levels.orb15High?.toFixed(2)}.`,
  });

  // --- 2. Bias, per the playbook's own open-vs-PDH/PDL rule ---
  const openPx = open?.open;
  let bias = "NEUTRAL", biasWhy = "";
  if (openPx > levels.pdh) { bias = "BULLISH"; biasWhy = `${symbol} opened above yesterday's high, so the playbook's bias rule favors CALLS at support levels.`; }
  else if (openPx < levels.pdl) { bias = "BEARISH"; biasWhy = `${symbol} opened below yesterday's low, so the playbook's bias rule favors PUTS at resistance levels.`; }
  else { biasWhy = `${symbol} opened between yesterday's high and low, so the playbook says wait for the first clear directional move before committing to a side.`; }

  const gapNote = gap.isGapUp ? " A gap-up beyond 2x daily ATR blocked CALL signals for the whole session (gap protection)."
    : gap.isGapDn ? " A gap-down beyond 2x daily ATR blocked PUT signals for the whole session (gap protection)."
    : "";

  lines.push({ heading: `Your intraday bias: ${bias}`, body: biasWhy + gapNote });

  // --- 3. The trades themselves, in the playbook's own step order ---
  const tradeable = fires.filter((f) => f.level);
  const noLevel = fires.filter((f) => !f.level);

  if (!fires.length) {
    lines.push({
      heading: "What you should have done: nothing",
      body: `Not one setup cleared the bar today — no level touch ever lined up with an RSI extreme, confirmation, and the rest of the score. `
        + `That is a legitimate outcome, not a failure of the tool. A no-trade day costs you $0; a forced trade on a day like this is how the -$1,860 days happen.`,
    });
  } else if (!tradeable.length) {
    lines.push({
      heading: "What you should have done: stay out",
      body: `${fires.length} signal${fires.length === 1 ? "" : "s"} fired today, but every one was an RSI Extreme with no level touch. `
        + `The playbook anchors every strike to a level (1 strike OTM from it), so there was no defined contract to buy on any of them. `
        + `These are information, not instructions — the tool is telling you momentum got stretched, not that there was a trade.`,
    });
  }

  for (const f of tradeable) {
    const strike = pickOtmStrike({ level: f.level, direction: f.direction });
    const t = f.trade || {};
    const steps = [];

    steps.push(`**Identify the level** — $${f.level} came into play at ${f.clock}.`);
    steps.push(`**Check RSI** — 1-min RSI read ${f.rsi}${f.direction === "PUT" ? " (overbought at resistance → puts)" : " (oversold at support → calls)"}.`);
    if (f.swing != null) steps.push(`**Swing** — RSI had swung ${f.swing} points into that reading, which is what separates a real exhaustion from a drift.`);
    if (f.volPts != null) steps.push(`**Confirmation** — volume ${f.volPts}/2, speed of move ${f.speedPts}/2, wick rejection ${f.wickPts}/1.`);
    steps.push(`**Select the strike** — 1 strike OTM from the level: the **$${strike}${f.direction[0]}** expiring same day.`);

    if (t.ok) {
      const dollars = sizeToDollars(f.size) || 250;
      const contracts = Math.max(1, Math.floor(dollars / (t.entryPrice * 100)));
      const cost = contracts * t.entryPrice * 100;
      const pnl = contracts * (t.exitPrice - t.entryPrice) * 100;
      steps.push(`**Enter + bracket** — filled at $${t.entryPrice} at ${t.entryClock}. TP $${t.tpPrice} (+20%), SL $${t.slPrice} (-12.5%), both set immediately.`);
      steps.push(`**Size** — ${f.size || "FULL $250"} → ${contracts} contract${contracts === 1 ? "" : "s"} at ${money(cost)}.`);
      steps.push(`**Exit** — ${t.exitReason} at ${t.exitClock}, $${t.exitPrice}. Held ${t.holdMinutes} minute${t.holdMinutes === 1 ? "" : "s"}. **${t.pctReturn > 0 ? "+" : ""}${t.pctReturn}% → ${money(pnl)}**`);
    } else {
      steps.push(`**Outcome unavailable** — ${t.reason}`);
    }

    lines.push({
      heading: `${f.clock} · ${gradeOf(f)} ${f.direction} at $${f.level}${f.points ? ` · ${f.points}/20 pts` : ""}`,
      steps,
      fire: f,
    });
  }

  if (tradeable.length && noLevel.length) {
    lines.push({
      heading: `${noLevel.length} more signal${noLevel.length === 1 ? "" : "s"} fired — but weren't trades`,
      body: `RSI Extreme fired ${noLevel.length} time${noLevel.length === 1 ? "" : "s"} away from any level (${noLevel.map((f) => f.clock).join(", ")}). `
        + `Same visual as an A-tier dot on the chart, but with no level to anchor a strike to, the playbook gives you no contract to buy. Watch, don't trade.`,
    });
  }

  // --- 4. The bottom line ---
  const simmed = tradeable.filter((f) => f.trade?.ok);
  const wins = simmed.filter((f) => f.trade.pctReturn > 0).length;
  const totalPnl = simmed.reduce((sum, f) => {
    const dollars = sizeToDollars(f.size) || 250;
    const contracts = Math.max(1, Math.floor(dollars / (f.trade.entryPrice * 100)));
    return sum + contracts * (f.trade.exitPrice - f.trade.entryPrice) * 100;
  }, 0);

  if (simmed.length) {
    lines.push({
      heading: "Bottom line",
      body: `${simmed.length} tradeable setup${simmed.length === 1 ? "" : "s"}, ${wins} winner${wins === 1 ? "" : "s"}. `
        + `Following the rules exactly — right strike, bracket set on fill, no overrides — the day was **${money(totalPnl)}**. `
        + `The playbook caps you at 2 trades a day, so if more than two fired, only the first two count for real.`,
    });
  }

  return { lines, bias, dayHigh, dayLow, totalPnl, tradeableCount: tradeable.length, winCount: wins };
}
