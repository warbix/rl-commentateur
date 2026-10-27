// Enregistre chaque match dans matchs/, un fichier par partie, rejouable avec --rejouer.
// Les commentaires du bot y sont notés aussi (événement "Commentaire", ignoré au rejeu),
// pour retrouver facilement les moments où il s'est trompé.

const fs = require("fs");
const path = require("path");

const STATE_EVERY_MS = 1000;

class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.file = null;
    this.guid = null;
    this.lastStateT = 0;
  }

  open(guid, t) {
    fs.mkdirSync(this.dir, { recursive: true });
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    this.file = path.join(this.dir, `${stamp}_${guid.slice(0, 8)}.jsonl`);
    this.guid = guid;
    console.log(`Enregistrement du match dans ${path.relative(process.cwd(), this.file)}`);
  }

  write(t, e, d) {
    if (!this.file) return;
    fs.appendFile(this.file, JSON.stringify({ t, e, d }) + "\n", () => {});
  }

  handle(event, data, t) {
    const guid = data && data.MatchGuid;
    if (guid && guid !== this.guid && event !== "PlayerLeft") this.open(guid, t);
    if (event === "UpdateState") {
      // Une fois par seconde suffit pour rejouer, et sans les objets cosmétiques qui pèsent lourd
      if (t - this.lastStateT < STATE_EVERY_MS) return;
      this.lastStateT = t;
      data = { ...data, Players: (data.Players || []).map(({ Loadout, ...p }) => p) };
    }
    this.write(t, event, data);
    if (event === "MatchDestroyed") { this.file = null; this.guid = null; }
  }

  comment(t, key, text) {
    this.write(t, "Commentaire", { key, text });
  }
}

module.exports = { Recorder };
