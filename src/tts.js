// Text-to-speech with Edge TTS (Python package edge-tts), with voice rotation.
// Every generated line is kept in cache/: the same line with the same voice never goes through the internet again.
// The "voice" settings of config.json are re-read for every line.

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
    const v = config.voice || {};
    const list = Array.isArray(v.list) && v.list.length ? v.list : ["fr-FR-HenriNeural"];
    return { list, rotation: v.rotation || "random", rate: v.rate || "+0%", pitch: v.pitch || "+0Hz", python: config.python || "python" };
  }

  nextVoice({ list, rotation }) {
    let voice;
    if (rotation === "fixed" || list.length === 1) voice = list[0];
    else if (rotation === "alternate") voice = list[this.turn++ % list.length];
    else {
      const others = list.filter((x) => x !== this.lastVoice);
      voice = others[Math.floor(Math.random() * others.length)];
    }
    this.lastVoice = voice;
    return voice;
  }

  // The service sometimes answers without audio: retry once before giving up
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
    // "--rate=-10%" as a single argument: otherwise a negative value would be taken for an option
    const args = ["-m", "edge_tts", "--voice", voice, `--rate=${rate}`, `--pitch=${pitch}`, "--text", text, "--write-media", tmp];
    return new Promise((resolve, reject) => {
      const proc = spawn(python, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let err = "";
      proc.stderr.on("data", (c) => (err += c));
      proc.on("error", (e) => reject(new Error(`Cannot start ${python} (is Python installed?): ${e.message}`)));
      proc.on("close", (code) => {
        if (code !== 0 || !fs.existsSync(tmp)) return reject(new Error(`edge-tts failed with ${voice} (code ${code}): ${err.trim().split("\n").pop()}`));
        fs.renameSync(tmp, file);
        resolve(file);
      });
    });
  }
}

module.exports = { TTS };
