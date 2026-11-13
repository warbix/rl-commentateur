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
${list.map((e) => `<div class="line"><audio controls preload="none" src="${escapeHtml(path.relative(path.dirname(file), e.file).split(path.sep).join("/"))}"></audio><span>${escapeHtml(e.text)} <small>${escapeHtml(e.voice.label)}</small></span></div>`).join("\n")}
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
.test { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 16px 0 24px; }
.test h2 { font-size: 17px; margin: 0 0 8px; }
.test textarea, .test input, .test select, .test button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.test textarea { width: 100%; box-sizing: border-box; min-height: 64px; }
.test button { cursor: pointer; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
.row input[type=text] { flex: 1 1 140px; min-width: 0; }
#spoken, #status { color: var(--muted); }
#fixes-list span { display: inline-block; margin: 2px 8px 2px 0; }
@media (max-width: 600px) { .line { flex-direction: column; align-items: flex-start; } audio { width: 100%; } }
</style></head><body>
<h1>Phrases du commentateur</h1>
<p><small>${entries.length} phrases. Une voix par phrase, toujours la même.</small></p>
<section class="test" id="test">
<h2>Tester une phrase</h2>
<p><small>Fonctionne avec <code>npm run library</code> (pas en ouvrant le fichier directement).</small></p>
<textarea id="text">Arracheur, tu as le droit d'avoir le seum.</textarea>
<div class="row">
<select id="voice"></select>
<label><input type="checkbox" id="fixes" checked> avec les corrections de prononciation</label>
<button id="play">Écouter</button>
</div>
<div id="spoken"></div>
<audio id="player" controls></audio>
<h2>Corrections de prononciation</h2>
<p><small>Le mot est remplacé juste avant la voix, dans toutes les phrases (ex. « MVP » dit « aime vie pie »). Essaie une orthographe dans le texte ci-dessus, puis enregistre-la.</small></p>
<div class="row">
<input type="text" id="word" placeholder="Mot (ex. seum)">
<input type="text" id="said" placeholder="Dit comme (ex. sœum)">
<button id="try">Essayer</button>
<button id="save">Enregistrer</button>
</div>
<div id="status"></div>
<div id="fixes-list"></div>
</section>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = function (url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      if (r.status === 404) throw new Error("le serveur de la page est une ancienne version : relance npm run library");
      return r;
    });
  };
  function showFixes(p) {
    var list = Object.keys(p).map(function (w) { return "<span><b>" + esc(w) + "</b> → " + esc(p[w]) + "</span>"; });
    $("fixes-list").innerHTML = list.length ? list.join("") : "<small>Aucune correction.</small>";
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function say(text, fixes, extra) {
    $("spoken").textContent = "Génération…";
    return api("api/preview", { text: text, voice: $("voice").value, fixes: fixes, extra: extra || {} }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error); });
      $("spoken").textContent = "Texte lu : " + decodeURIComponent(r.headers.get("X-Spoken-Text") || "");
      return r.blob();
    }).then(function (b) {
      $("player").src = URL.createObjectURL(b);
      $("player").play();
    }).catch(function (e) { $("spoken").textContent = "Erreur : " + e.message; });
  }
  fetch("api/info").then(function (r) { return r.json(); }).then(function (d) {
    $("voice").innerHTML = d.voices.map(function (v, i) { return "<option value='" + i + "'>" + esc(v) + "</option>"; }).join("");
    showFixes(d.pronunciation);
  }).catch(function () {
    $("test").querySelector("p small").textContent = "Indisponible : lance npm run library et ouvre la page par son adresse.";
  });
  $("play").onclick = function () { say($("text").value, $("fixes").checked); };
  // The fix being tried is applied by the server, with the saved ones
  $("try").onclick = function () {
    var w = $("word").value.trim(), s = $("said").value.trim();
    if (!w || !s) return;
    var extra = {};
    extra[w] = s;
    say($("text").value, true, extra);
  };
  $("save").onclick = function () {
    api("api/pronunciation", { word: $("word").value, said: $("said").value }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      showFixes(d.pronunciation);
      $("status").textContent = "Enregistré dans config.json. Les phrases concernées seront regénérées au prochain lancement du bot.";
    }).catch(function (e) { $("status").textContent = "Erreur : " + e.message; });
  };
})();
</script>
${sections}
</body></html>
`);
}

module.exports = { lines, status, generate, prune, writePage };
