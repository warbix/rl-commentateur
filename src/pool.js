// Phrases prêtes à l'avance pour la bande (les pseudos de config.json → surnoms).
// Pour les situations qui ne citent que des joueurs de notre équipe, on génère une phrase
// (texte + voix) par combinaison de joueurs, en arrière-plan. Au moment du commentaire, elle sort
// sans attendre la voix ; une nouvelle est aussitôt préparée pour la fois suivante.
// La réserve est gardée dans cache/reserve.json et vidée si les phrases, surnoms ou voix changent.

const fs = require("fs");
const crypto = require("crypto");
const { readConfig } = require("./config");

// Situations dont toutes les variables sont des joueurs de notre équipe
const SITUATIONS = {
  tapin: ["buteur", "passeur"],
  vol: ["voleur", "victime"],
  "lucarne.lucarne": ["buteur"],
  "mvp.leger": ["mvp", "vraiMvp"],
  "mvp.moqueur": ["mvp", "vraiMvp"],
  "mvp.rembourse": ["mvp", "vraiMvp"],
};

// Toutes les façons de choisir n joueurs différents, dans l'ordre
function arrangements(names, n) {
  if (n === 0) return [[]];
  return names.flatMap((name) => arrangements(names.filter((x) => x !== name), n - 1).map((rest) => [name, ...rest]));
}

class PhrasePool {
  constructor({ phrases, tts, file }) {
    this.phrases = phrases;
    this.tts = tts;
    this.file = file;
    this.queue = [];
    this.running = false;
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.data = { signature: "", entries: {} }; }
  }

  // Empreinte de tout ce qui change le texte ou la voix : si elle bouge, la réserve est périmée
  signature() {
    const { surnoms, prononciation, voix } = readConfig();
    const phrasesText = fs.readFileSync(this.phrases.phrasesFile, "utf8");
    return crypto.createHash("sha1").update(JSON.stringify([phrasesText, surnoms, prononciation, voix && voix.liste, voix && voix.vitesse, voix && voix.hauteur])).digest("hex");
  }

  checkSignature() {
    const sig = this.signature();
    if (sig !== this.data.signature) this.data = { signature: sig, entries: {} };
  }

  poolKey(key, vars) {
    const names = SITUATIONS[key];
    return names ? `${key}|${names.map((n) => String(vars[n]).toLowerCase()).join("|")}` : null;
  }

  save() {
    fs.writeFile(this.file, JSON.stringify(this.data), () => {});
  }

  // Une phrase prête pour ce commentaire, ou null
  take(key, vars) {
    const pk = this.poolKey(key, vars);
    if (!pk) return null;
    this.checkSignature();
    const entry = this.data.entries[pk];
    delete this.data.entries[pk];
    this.save();
    this.schedule(key, vars);
    return entry && fs.existsSync(entry.file) ? entry : null;
  }

  // Prépare toute la réserve en arrière-plan
  warm() {
    this.checkSignature();
    const friends = Object.keys(readConfig().surnoms || {});
    const missing = [];
    for (const [key, names] of Object.entries(SITUATIONS)) {
      for (const combo of arrangements(friends, names.length)) {
        const vars = Object.fromEntries(names.map((n, i) => [n, combo[i]]));
        if (!this.data.entries[this.poolKey(key, vars)]) missing.push({ key, vars });
      }
    }
    if (!missing.length) return;
    console.log(`Préparation de ${missing.length} phrases pour la bande, en arrière-plan…`);
    this.queue.push(...missing);
    this.run();
  }

  schedule(key, vars) {
    this.queue.push({ key, vars });
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const total = this.queue.length;
    let done = 0;
    while (this.queue.length) {
      const { key, vars } = this.queue.shift();
      const pk = this.poolKey(key, vars);
      if (this.data.entries[pk]) continue;
      try {
        const text = this.phrases.pick(key, vars);
        const file = await this.tts.synth(text);
        this.data.entries[pk] = { text, file };
        if (++done % 10 === 0) this.save();
      } catch (e) {
        console.error("Préparation des phrases :", e.message);
        break;
      }
    }
    this.save();
    if (total > 1 && done) console.log(`${done} phrases prêtes pour la bande.`);
    this.running = false;
  }
}

module.exports = { PhrasePool };
