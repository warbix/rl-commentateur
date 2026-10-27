// Synthèse vocale avec Edge TTS (paquet Python edge-tts), avec rotation des voix.
// Chaque phrase générée est gardée dans cache/ : la même phrase avec la même voix ne repasse jamais par internet.
// Les réglages "voix" de config.json sont relus à chaque phrase.

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readConfig } = require("./config");

class TTS {
  constructor({ cacheDir }) {
    this.cacheDir = cacheDir;
    this.turn = 0;
    this.lastVoice = null;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  settings() {
    const config = readConfig();
    const v = config.voix || {};
    // "nom" accepté pour une seule voix (ancien format)
    const liste = Array.isArray(v.liste) && v.liste.length ? v.liste : [v.nom || "fr-FR-HenriNeural"];
    return { liste, rotation: v.rotation || "aleatoire", rate: v.vitesse || "+0%", pitch: v.hauteur || "+0Hz", python: config.python || "python" };
  }

  nextVoice({ liste, rotation }) {
    let voice;
    if (rotation === "fixe" || liste.length === 1) voice = liste[0];
    else if (rotation === "alternee") voice = liste[this.turn++ % liste.length];
    else {
      const others = liste.filter((x) => x !== this.lastVoice);
      voice = others[Math.floor(Math.random() * others.length)];
    }
    this.lastVoice = voice;
    return voice;
  }

  // Le service répond parfois sans audio : on retente une fois avant d'abandonner
  async synth(text, voice) {
    const s = this.settings();
    voice = voice || this.nextVoice(s);
    try {
      return await this.synthOnce(text, voice, s);
    } catch {
      return this.synthOnce(text, voice, s);
    }
  }

  synthOnce(text, voice, { rate, pitch, python }) {
    const hash = crypto.createHash("sha1").update([voice, rate, pitch, text].join("|")).digest("hex");
    const file = path.join(this.cacheDir, `${hash}.mp3`);
    if (fs.existsSync(file)) return Promise.resolve(file);

    const tmp = `${file}.tmp`;
    // "--rate=-10%" en un seul argument : sinon une valeur négative serait prise pour une option
    const args = ["-m", "edge_tts", "--voice", voice, `--rate=${rate}`, `--pitch=${pitch}`, "--text", text, "--write-media", tmp];
    return new Promise((resolve, reject) => {
      const proc = spawn(python, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let err = "";
      proc.stderr.on("data", (c) => (err += c));
      proc.on("error", (e) => reject(new Error(`Impossible de lancer ${python} (Python installé ?) : ${e.message}`)));
      proc.on("close", (code) => {
        if (code !== 0 || !fs.existsSync(tmp)) return reject(new Error(`edge-tts a échoué avec ${voice} (code ${code}) : ${err.trim().split("\n").pop()}`));
        fs.renameSync(tmp, file);
        resolve(file);
      });
    });
  }
}

module.exports = { TTS };
