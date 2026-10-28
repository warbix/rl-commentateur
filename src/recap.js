// Evening recap: the highlights of our team. The text itself is French (it is read out and posted).
// Kept in a file to survive bot restarts: an evening ends after 6 h without anything new.

const fs = require("fs");

const EVENING_MS = 6 * 60 * 60 * 1000;

const TITLES = [
  { type: "tapIn", title: "Roi du tap-in", unit: ["tap-in", "tap-ins"] },
  { type: "steal", title: "Pickpocket de la soirée", unit: ["but volé", "buts volés"] },
  { type: "missedSave", title: "Passoire d'or", unit: ["arrêt manqué", "arrêts manqués"] },
  { type: "giveaway", title: "Bénévole de la soirée", unit: ["ballon rendu", "ballons rendus"] },
  { type: "adminAssist", title: "Fonctionnaire de la passe", unit: ["passe administrative", "passes administratives"] },
  { type: "mvp", title: "Braqueur de MVP", unit: ["MVP volé", "MVP volés"] },
  { type: "ghost", title: "Fantôme de la soirée", unit: ["disparition", "disparitions"] },
  { type: "beggar", title: "Mendiant de la soirée", unit: ["panne sèche", "pannes sèches"] },
  { type: "finish", title: "Sniper de la soirée", unit: ["lucarne", "lucarnes"] },
];

class Recap {
  // file: where to keep the recap (no file: in memory only). now: for the tests
  constructor(file = null, now = Date.now()) {
    this.file = file;
    this.facts = new Map(); // type → Map(player → count)
    this.wins = 0;
    this.losses = 0;
    this.load(now);
  }

  load(now) {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (now - d.updated > EVENING_MS) return;
      this.facts = new Map(Object.entries(d.facts).map(([type, m]) => [type, new Map(Object.entries(m))]));
      this.wins = d.wins;
      this.losses = d.losses;
    } catch {}
  }

  save() {
    if (!this.file) return;
    const facts = Object.fromEntries([...this.facts].map(([type, m]) => [type, Object.fromEntries(m)]));
    // Synchronous write: with an asynchronous one, an older version could overwrite the latest
    try { fs.writeFileSync(this.file, JSON.stringify({ updated: Date.now(), facts, wins: this.wins, losses: this.losses })); } catch {}
  }

  addFact({ type, player }) {
    if (!this.facts.has(type)) this.facts.set(type, new Map());
    const m = this.facts.get(type);
    m.set(player, (m.get(player) || 0) + 1);
    this.save();
  }

  addResult({ won }) {
    if (won) this.wins++;
    else this.losses++;
    this.save();
  }

  // say(name) → spoken name. Returns the recap text, to be read out and posted.
  text(say) {
    const matches = this.wins + this.losses;
    const lines = [];
    lines.push(matches
      ? `Bilan de la soirée : ${matches} match${matches > 1 ? "s" : ""}, ${this.wins} victoire${this.wins > 1 ? "s" : ""}, ${this.losses} défaite${this.losses > 1 ? "s" : ""}.`
      : "Bilan de la soirée :");
    for (const { type, title, unit } of TITLES) {
      const m = this.facts.get(type);
      if (!m || !m.size) continue;
      const [player, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      lines.push(`${title} : ${say(player)}, avec ${n} ${unit[n > 1 ? 1 : 0]}.`);
    }
    if (lines.length === 1) lines.push("Rien à signaler. Une soirée aussi propre, c'est suspect.");
    return lines.join("\n");
  }
}

module.exports = { Recap };
