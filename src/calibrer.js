// Lit les votes de la bande et propose des seuils.
//   npm run calibrer               → rapport et propositions
//   npm run calibrer -- --appliquer → écrit aussi les seuils proposés dans config.json
//
// Pour chaque mesure d'une règle (ex. distance du tap-in), on regarde où tombent les déclenchements
// validés (✅, ou 👍 sur un « presque ») et rejetés (❌, ou 👎 sur un « presque »), et on cherche le seuil
// qui les sépare le mieux. Une règle a souvent plusieurs mesures : un rejet peut venir d'une autre mesure,
// donc ce sont des propositions à relire, pas des vérités.

const fs = require("fs");
const path = require("path");
const { Retours, valeur } = require("./retours");

const MIN_VOTES = 4; // en dessous, on ne propose rien pour une mesure

// Verdict d'un déclenchement : true = « il fallait le dire », false = « non », null = pas tranché
function verdict(e, v) {
  if (!v || v.pour.length === v.contre.length) return null;
  return v.pour.length > v.contre.length;
}

// Meilleur seuil pour séparer les points { valeur, dire } ; sens "max" : on dit si valeur ≤ seuil
function bestThreshold(points, sens, current) {
  const fits = (s) => points.filter((p) => (sens === "max" ? p.valeur <= s : p.valeur >= s) === p.dire).length;
  const values = [...new Set(points.map((p) => p.valeur))].sort((a, b) => a - b);
  const candidates = [current, ...values, ...values.slice(1).map((v, i) => (v + values[i]) / 2)];
  let best = current, bestFit = fits(current);
  for (const c of candidates) {
    const f = fits(c);
    if (f > bestFit || (f === bestFit && Math.abs(c - current) < Math.abs(best - current))) { best = c; bestFit = f; }
  }
  return { seuil: best, justes: bestFit, actuels: fits(current) };
}

// Arrondi lisible selon l'unité
function roundFor(v, unite) {
  if (unite === "uu") return Math.round(v / 10) * 10;
  if (unite === "ms") return Math.round(v / 100) * 100;
  if (unite === "kmh") return Math.round(v);
  return Math.round(v * 100) / 100;
}

function calibrate(retours, seuils) {
  const rules = new Map(); // famille → { votes, avis, mesures: Map(cle → { nom, sens, unite, points }) }
  for (const e of retours.entries.values()) {
    if (!e.key) continue;
    const fam = e.key.split(".")[0];
    if (!rules.has(fam)) rules.set(fam, { pour: 0, contre: 0, presquePour: 0, presqueContre: 0, avis: [], mesures: new Map() });
    const r = rules.get(fam);
    const v = retours.votes[e.id];
    for (const a of (v && v.avis) || []) r.avis.push(`#${e.id} ${a.par} : ${a.texte}`);
    const dire = verdict(e, v);
    if (dire === null) continue;
    if (e.type === "presque") dire ? r.presquePour++ : r.presqueContre++;
    else dire ? r.pour++ : r.contre++;
    for (const m of e.mesures || []) {
      if (!m.cle || typeof m.valeur !== "number" || !m.sens) continue;
      if (!r.mesures.has(m.cle)) r.mesures.set(m.cle, { nom: m.nom, sens: m.sens, unite: m.unite, points: [] });
      r.mesures.get(m.cle).points.push({ valeur: m.valeur, dire, id: e.id });
    }
  }

  const propositions = {};
  const lignes = [];
  for (const [fam, r] of rules) {
    const total = r.pour + r.contre + r.presquePour + r.presqueContre;
    lignes.push(`\n■ ${fam} — ✅ ${r.pour} / ❌ ${r.contre} · presque 👍 ${r.presquePour} / 👎 ${r.presqueContre}${total ? "" : " (pas encore de votes)"}`);
    for (const [cle, m] of r.mesures) {
      const current = seuils[cle];
      if (current === undefined) continue;
      const pts = m.points.map((p) => `${p.dire ? "✓" : "✗"}${valeur(p.valeur, m.unite)}`).join(" ");
      if (m.points.length < MIN_VOTES) {
        lignes.push(`  ${m.nom} (${cle} = ${valeur(current, m.unite)}) : ${m.points.length} vote(s), pas assez pour conclure · ${pts}`);
        continue;
      }
      const b = bestThreshold(m.points, m.sens, current);
      const proposed = roundFor(b.seuil, m.unite);
      if (b.justes > b.actuels && proposed !== current) {
        propositions[cle] = proposed;
        lignes.push(`  ${m.nom} : ${cle} ${valeur(current, m.unite)} → ${valeur(proposed, m.unite)} proposé (${b.actuels}/${m.points.length} → ${b.justes}/${m.points.length} votes respectés) · ${pts}`);
      } else {
        lignes.push(`  ${m.nom} : ${cle} = ${valeur(current, m.unite)}, à garder (${b.actuels}/${m.points.length} votes respectés) · ${pts}`);
      }
    }
    for (const a of r.avis) lignes.push(`  💬 ${a}`);
  }
  return { propositions, rapport: lignes.join("\n") };
}

// Remplace les valeurs dans config.json sans toucher au reste du fichier
function apply(configFile, propositions) {
  let text = fs.readFileSync(configFile, "utf8");
  for (const [cle, v] of Object.entries(propositions)) {
    const re = new RegExp(`("${cle}"\\s*:\\s*)[-0-9.]+`);
    if (re.test(text)) text = text.replace(re, `$1${v}`);
    else console.log(`(${cle} absent de config.json → seuils, pas modifié)`);
  }
  JSON.parse(text);
  fs.writeFileSync(configFile, text);
}

module.exports = { calibrate, bestThreshold, apply };

if (require.main === module) {
  const { readConfig, CONFIG_FILE } = require("./config");
  const { SEUILS } = require("./detector");
  const ROOT = path.join(__dirname, "..");
  const retours = new Retours(path.join(ROOT, "retours"));
  const seuils = { ...SEUILS, ...(readConfig().seuils || {}) };
  const { propositions, rapport } = calibrate(retours, seuils);
  console.log(`${retours.entries.size} déclenchements, ${Object.keys(retours.votes).length} avec votes ou avis`);
  console.log(rapport);
  const n = Object.keys(propositions).length;
  if (!n) console.log("\nAucun seuil à changer pour l'instant.");
  else if (process.argv.includes("--appliquer")) {
    apply(CONFIG_FILE, propositions);
    console.log(`\n${n} seuil(s) écrit(s) dans config.json (pris en compte tout de suite par le bot).`);
  } else {
    console.log(`\n${n} seuil(s) proposé(s). Pour les appliquer : npm run calibrer -- --appliquer`);
  }
}
