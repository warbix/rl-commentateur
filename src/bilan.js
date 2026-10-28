// Bilan de la soirée : les faits marquants de notre équipe.
// Gardé dans un fichier pour survivre aux relances du bot : une soirée s'arrête après 6 h sans rien de nouveau.

const fs = require("fs");

const SOIREE_MS = 6 * 60 * 60 * 1000;

const TITRES = [
  { type: "tapin", titre: "Roi du tap-in", unite: ["tap-in", "tap-ins"] },
  { type: "vol", titre: "Pickpocket de la soirée", unite: ["but volé", "buts volés"] },
  { type: "arretManque", titre: "Passoire d'or", unite: ["arrêt manqué", "arrêts manqués"] },
  { type: "benevole", titre: "Bénévole de la soirée", unite: ["ballon rendu", "ballons rendus"] },
  { type: "passeAdmin", titre: "Fonctionnaire de la passe", unite: ["passe administrative", "passes administratives"] },
  { type: "mvpVole", titre: "Braqueur de MVP", unite: ["MVP volé", "MVP volés"] },
  { type: "fantome", titre: "Fantôme de la soirée", unite: ["disparition", "disparitions"] },
  { type: "mendiant", titre: "Mendiant de la soirée", unite: ["panne sèche", "pannes sèches"] },
  { type: "lucarne", titre: "Sniper de la soirée", unite: ["lucarne", "lucarnes"] },
];

class Bilan {
  // file : où garder le bilan (aucun fichier : bilan en mémoire seulement). now : pour les tests
  constructor(file = null, now = Date.now()) {
    this.file = file;
    this.faits = new Map(); // type -> Map(joueur -> nombre)
    this.victoires = 0;
    this.defaites = 0;
    this.load(now);
  }

  load(now) {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (now - d.maj > SOIREE_MS) return;
      this.faits = new Map(Object.entries(d.faits).map(([type, m]) => [type, new Map(Object.entries(m))]));
      this.victoires = d.victoires;
      this.defaites = d.defaites;
    } catch {}
  }

  save() {
    if (!this.file) return;
    const faits = Object.fromEntries([...this.faits].map(([type, m]) => [type, Object.fromEntries(m)]));
    // Écriture directe : en asynchrone, une ancienne version pouvait écraser la dernière
    try { fs.writeFileSync(this.file, JSON.stringify({ maj: Date.now(), faits, victoires: this.victoires, defaites: this.defaites })); } catch {}
  }

  addFait({ type, joueur }) {
    if (!this.faits.has(type)) this.faits.set(type, new Map());
    const m = this.faits.get(type);
    m.set(joueur, (m.get(joueur) || 0) + 1);
    this.save();
  }

  addResultat({ gagne }) {
    if (gagne) this.victoires++;
    else this.defaites++;
    this.save();
  }

  // say(pseudo) → nom prononcé. Renvoie le texte du bilan, à lire et à afficher.
  texte(say) {
    const matchs = this.victoires + this.defaites;
    const lignes = [];
    lignes.push(matchs
      ? `Bilan de la soirée : ${matchs} match${matchs > 1 ? "s" : ""}, ${this.victoires} victoire${this.victoires > 1 ? "s" : ""}, ${this.defaites} défaite${this.defaites > 1 ? "s" : ""}.`
      : "Bilan de la soirée :");
    for (const { type, titre, unite } of TITRES) {
      const m = this.faits.get(type);
      if (!m || !m.size) continue;
      const [joueur, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      lignes.push(`${titre} : ${say(joueur)}, avec ${n} ${unite[n > 1 ? 1 : 0]}.`);
    }
    if (lignes.length === 1) lignes.push("Rien à signaler. Une soirée aussi propre, c'est suspect.");
    return lignes.join("\n");
  }
}

module.exports = { Bilan };
