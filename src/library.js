// Voice library: every line the bot can say about the squad, generated in advance.
// For each situation of phrases.json, each of its lines is filled with every possible cast:
//   - our players: the spoken names of config.json → players (we only play within the squad)
//   - the opponent: each formula of opponentNames ("l'adversaire"…)
//   - numbers: every plausible value (balls given away in a match)
// The text comes out exactly as during a match (same code), so the voice found in the cache is the right one.

const fs = require("fs");
const path = require("path");
const { readConfig } = require("./config");
const { estimateCost } = require("./tts");
const { LABELS } = require("./feedback");
const { OPPONENT_NAMES } = require("./phrases");
const { ruleEnabled } = require("./rules");

// Variables that name an opponent (all the others name one of our players)
const OPPONENT_VARS = {
  "giveaway.shot": ["opponent"],
  "giveaway.saved": ["opponent"],
  "giveaway.goal": ["opponent"],
};
// Variables that name a player of either team (the MVP: the second may be ours while the MVP is an opponent)
const EITHER_VARS = { mvp: ["mvp"] };
// Values a number can take in a spoken line
const NUMBERS = { count: [3, 4, 5, 6, 7, 8, 9, 10] };

// Every situation with its own lines (aliases like "backward": "giveaway.shot" are skipped: same lines)
function situations(node, prefix = "") {
  if (node.phrases) return [prefix];
  return Object.entries(node).filter(([k, v]) => typeof v === "object" && !k.startsWith("_"))
    .flatMap(([k, v]) => situations(v, prefix ? `${prefix}.${k}` : k));
}

// Every way to give each variable a value. ours: a different player of the squad for each; either: one more
// player of the squad, or the opponent.
function casts(ours, opponents, numbers, either, { players, opponentNames }) {
  let result = [{ values: {}, used: [] }];
  const squad = (c) => Object.keys(players).filter((p) => !c.used.includes(p));
  for (const v of ours) {
    result = result.flatMap((c) => squad(c).map((p) => ({ values: { ...c.values, [v]: p }, used: [...c.used, p] })));
  }
  for (const v of either) {
    result = result.flatMap((c) => [...squad(c).map((p) => ({ values: { ...c.values, [v]: p }, used: [...c.used, p] })), ...each(v, c, opponentNames)]);
  }
  for (const v of opponents) result = result.flatMap((c) => each(v, c, opponentNames));
  for (const v of numbers) result = result.flatMap((c) => each(v, c, NUMBERS[v]));
  return result.map((c) => c.values);
}
const each = (v, c, list) => list.map((x) => ({ ...c, values: { ...c.values, [v]: x } }));

// All the lines of the library: [{ key, text }], without duplicates
function lines(phrases) {
  const all = phrases.all();
  const { players = {}, pronunciation = {}, opponentNames = OPPONENT_NAMES, rules } = readConfig();
  const people = { players, opponentNames };
  const seen = new Set();
  const out = [];
  for (const key of situations(all)) {
    if (!ruleEnabled(rules, key)) continue;
    const node = phrases.node(key, all);
    const declared = [...(node._variables || "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const opponents = declared.filter((v) => (OPPONENT_VARS[key] || []).includes(v));
    const numbers = declared.filter((v) => NUMBERS[v]);
    const either = declared.filter((v) => (EITHER_VARS[key] || []).includes(v));
    const ours = declared.filter((v) => !opponents.includes(v) && !numbers.includes(v) && !either.includes(v));
    for (const line of node.phrases) {
      const used = new Set([...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      // Only the variables of this line: a line without {count} is not repeated for every count
      const cast = casts(ours.filter((v) => used.has(v)), opponents.filter((v) => used.has(v)), numbers.filter((v) => used.has(v)), either.filter((v) => used.has(v)), people);
      for (const values of cast) {
        const text = phrases.render(line, (v) => values[v], pronunciation);
        if (seen.has(text)) continue;
        seen.add(text);
        out.push({ key, text });
      }
    }
  }
  return out;
}

// Where each line is, and which ones are missing
function status(phrases, tts) {
  const s = tts.settings();
  const entries = lines(phrases).map((l) => ({ ...l, ...tts.locate(l.text, s) }));
  const missing = entries.filter((e) => !fs.existsSync(e.file));
  const chars = missing.reduce((n, e) => n + e.text.length, 0);
  return { settings: s, entries, missing, chars, cost: estimateCost(chars, s) };
}

// Generates the missing lines, a few at a time. onProgress(done, total) after each one.
async function generate(tts, missing, { parallel = 4, onProgress = () => {} } = {}) {
  let next = 0;
  let done = 0;
  const errors = [];
  const worker = async () => {
    while (next < missing.length) {
      const e = missing[next++];
      try {
        await tts.synth(e.text, e.voice);
      } catch (err) {
        errors.push(`${e.key}: ${err.message}`);
        // A refused key or an empty account: no point in going on
        if (/OpenAI (401|429)|no API key/.test(err.message)) next = missing.length;
      }
      onProgress(++done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return errors;
}

// Removes the generated voices that no line of the library uses any more (live lines are regenerated when needed)
function prune(cacheDir, entries) {
  const keep = new Set(entries.map((e) => path.basename(e.file)));
  let removed = 0;
  for (const f of fs.readdirSync(cacheDir)) {
    if (/^[0-9a-f]{40}\.mp3$/.test(f) && !keep.has(f)) {
      fs.unlinkSync(path.join(cacheDir, f));
      removed++;
    }
  }
  return removed;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A local page to listen to the whole library, situation by situation
function writePage(file, entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.key)) groups.set(e.key, []);
    groups.get(e.key).push(e);
  }
  const sections = [...groups].map(([key, list]) => `
<details><summary>${escapeHtml(LABELS[key] || key)} <small>(${list.length})</small></summary>
${list.map((e) => `<div class="line"><audio controls preload="none" src="${escapeHtml(path.relative(path.dirname(file), e.file).split(path.sep).join("/"))}"></audio><span>${escapeHtml(e.text)} <small>${escapeHtml(e.voice)}</small></span></div>`).join("\n")}
</details>`).join("\n");
  fs.writeFileSync(file, `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phrases du commentateur</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #777; --line: #e3e3e3; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; --muted: #999; --line: #2c2c2c; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 900px; padding: 16px; }
summary { cursor: pointer; font-weight: 600; padding: 8px 0; border-bottom: 1px solid var(--line); }
small { color: var(--muted); font-weight: normal; }
.line { display: flex; gap: 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
audio { flex: none; width: 220px; height: 32px; }
</style></head><body>
<h1>Phrases du commentateur</h1>
<p><small>${entries.length} phrases. Une voix par phrase, toujours la même.</small></p>
${sections}
</body></html>
`);
}

module.exports = { lines, status, generate, prune, writePage };
