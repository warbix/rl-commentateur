// Reads the squad's votes and suggests thresholds.
//   npm run calibrate             → report and suggestions
//   npm run calibrate -- --apply  → also writes the suggested thresholds into config.json
//
// For each measure of a rule (e.g. tap-in distance), look at where the approved triggers (✅, or 👍 on a
// near miss) and the rejected ones (❌, or 👎 on a near miss) fall, and search for the threshold that
// separates them best. A rule often has several measures: a rejection can come from another measure,
// so these are suggestions to review, not truths. Measure names are in French, as shown in Discord.

const fs = require("fs");
const path = require("path");
const { Feedback, valueText } = require("./feedback");

const MIN_VOTES = 4; // below that, nothing is suggested for a measure

// Verdict of a trigger: true = "it should be said", false = "no", null = undecided
function verdict(v) {
  if (!v || v.for.length === v.against.length) return null;
  return v.for.length > v.against.length;
}

// Best threshold to separate the points { value, say }; direction "max": said when value ≤ threshold
function bestThreshold(points, direction, current) {
  const fits = (s) => points.filter((p) => (direction === "max" ? p.value <= s : p.value >= s) === p.say).length;
  const values = [...new Set(points.map((p) => p.value))].sort((a, b) => a - b);
  const candidates = [current, ...values, ...values.slice(1).map((v, i) => (v + values[i]) / 2)];
  let best = current, bestFit = fits(current);
  for (const c of candidates) {
    const f = fits(c);
    if (f > bestFit || (f === bestFit && Math.abs(c - current) < Math.abs(best - current))) { best = c; bestFit = f; }
  }
  return { threshold: best, respected: bestFit, respectedNow: fits(current) };
}

// Readable rounding depending on the unit
function roundFor(v, unit) {
  if (unit === "uu") return Math.round(v / 10) * 10;
  if (unit === "ms") return Math.round(v / 100) * 100;
  if (unit === "kmh") return Math.round(v);
  return Math.round(v * 100) / 100;
}

function calibrate(feedback, thresholds) {
  const rules = new Map(); // family → { votes, notes, measures: Map(key → { name, direction, unit, points }) }
  for (const e of feedback.entries.values()) {
    if (!e.key) continue;
    const family = e.key.split(".")[0];
    if (!rules.has(family)) rules.set(family, { for: 0, against: 0, nearFor: 0, nearAgainst: 0, notes: [], measures: new Map() });
    const r = rules.get(family);
    const v = feedback.votes[e.id];
    for (const n of (v && v.notes) || []) r.notes.push(`#${e.id} ${n.by} : ${n.text}`);
    const say = verdict(v);
    if (say === null) continue;
    if (e.type === "nearMiss") say ? r.nearFor++ : r.nearAgainst++;
    else say ? r.for++ : r.against++;
    for (const m of e.measures || []) {
      if (!m.key || typeof m.value !== "number" || !m.direction) continue;
      if (!r.measures.has(m.key)) r.measures.set(m.key, { name: m.name, direction: m.direction, unit: m.unit, points: [] });
      r.measures.get(m.key).points.push({ value: m.value, say, id: e.id });
    }
  }

  const suggestions = {};
  const lines = [];
  for (const [family, r] of rules) {
    const total = r.for + r.against + r.nearFor + r.nearAgainst;
    lines.push(`\n■ ${family} — ✅ ${r.for} / ❌ ${r.against} · near misses 👍 ${r.nearFor} / 👎 ${r.nearAgainst}${total ? "" : " (no votes yet)"}`);
    for (const [key, m] of r.measures) {
      const current = thresholds[key];
      if (current === undefined) continue;
      const pts = m.points.map((p) => `${p.say ? "✓" : "✗"}${valueText(p.value, m.unit)}`).join(" ");
      if (m.points.length < MIN_VOTES) {
        lines.push(`  ${m.name} (${key} = ${valueText(current, m.unit)}) : ${m.points.length} vote(s), not enough to conclude · ${pts}`);
        continue;
      }
      const b = bestThreshold(m.points, m.direction, current);
      const proposed = roundFor(b.threshold, m.unit);
      if (b.respected > b.respectedNow && proposed !== current) {
        suggestions[key] = proposed;
        lines.push(`  ${m.name} : ${key} ${valueText(current, m.unit)} → ${valueText(proposed, m.unit)} suggested (${b.respectedNow}/${m.points.length} → ${b.respected}/${m.points.length} votes respected) · ${pts}`);
      } else {
        lines.push(`  ${m.name} : ${key} = ${valueText(current, m.unit)}, keep (${b.respectedNow}/${m.points.length} votes respected) · ${pts}`);
      }
    }
    for (const n of r.notes) lines.push(`  💬 ${n}`);
  }
  return { suggestions, report: lines.join("\n") };
}

// Replaces the values in config.json without touching the rest of the file
function apply(configFile, suggestions) {
  let text = fs.readFileSync(configFile, "utf8");
  for (const [key, v] of Object.entries(suggestions)) {
    const re = new RegExp(`("${key}"\\s*:\\s*)[-0-9.]+`);
    if (re.test(text)) text = text.replace(re, `$1${v}`);
    else console.log(`(${key} missing from config.json → thresholds, not changed)`);
  }
  JSON.parse(text);
  fs.writeFileSync(configFile, text);
}

module.exports = { calibrate, bestThreshold, apply };

if (require.main === module) {
  const { readConfig, CONFIG_FILE } = require("./config");
  const { THRESHOLDS } = require("./detector");
  const ROOT = path.join(__dirname, "..");
  const feedback = new Feedback(path.join(ROOT, "feedback"));
  const thresholds = { ...THRESHOLDS, ...(readConfig().thresholds || {}) };
  const { suggestions, report } = calibrate(feedback, thresholds);
  console.log(`${feedback.entries.size} triggers, ${Object.keys(feedback.votes).length} with votes or notes`);
  console.log(report);
  const ideas = feedback.ideas();
  if (ideas.length) {
    console.log("\n■ ideas");
    for (const i of ideas) console.log(`  💡 ${i.by}${i.clock ? ` (match of ${new Date(i.match.start).toLocaleString()}, clock ${i.clock.overtime ? "+" : ""}${Math.round(i.clock.seconds)} s)` : ""}: ${i.text}`);
  }
  const n = Object.keys(suggestions).length;
  if (!n) console.log("\nNo threshold to change for now.");
  else if (process.argv.includes("--apply")) {
    apply(CONFIG_FILE, suggestions);
    console.log(`\n${n} threshold(s) written to config.json (applied right away by the bot).`);
  } else {
    console.log(`\n${n} threshold(s) suggested. To apply them: npm run calibrate -- --apply`);
  }
}
