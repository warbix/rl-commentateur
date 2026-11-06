// Text-to-speech, with voice rotation. Two providers:
//   - "edge": the free Microsoft voices of Edge (Python package edge-tts)
//   - "openai": the OpenAI voices (paid, needs voice.openai.apiKey or the OPENAI_API_KEY variable)
// Every generated line is kept in cache/: the same line with the same voice is never generated again.
// The "voice" settings of config.json are re-read for every line.

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readConfig } = require("./config");

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

const OPENAI_DEFAULTS = {
  model: "gpt-4o-mini-tts",
  voices: ["ash", "onyx", "coral", "sage", "ballad", "verse"],
  instructions: "Tu es un commentateur sportif français, moqueur et piquant. Parle en français de France, avec un ton ironique et vivant.",
};

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
    const provider = v.provider === "openai" ? "openai" : "edge";
    const openai = { ...OPENAI_DEFAULTS, ...(v.openai || {}) };
    const list = provider === "openai"
      ? (openai.voices.length ? openai.voices : OPENAI_DEFAULTS.voices)
      : (Array.isArray(v.list) && v.list.length ? v.list : ["fr-FR-HenriNeural"]);
    return {
      provider, list, openai,
      rotation: v.rotation || "line",
      rate: v.rate || "+0%", pitch: v.pitch || "+0Hz", python: config.python || "python",
    };
  }

  // "line": each line always has the same voice (the voices still change from one line to the next),
  // so a line is only generated once and can be prepared in advance
  voiceFor(text, { list, rotation }) {
    let voice;
    if (rotation === "fixed" || list.length === 1) voice = list[0];
    else if (rotation === "alternate") voice = list[this.turn++ % list.length];
    else if (rotation === "random") {
      const others = list.filter((x) => x !== this.lastVoice);
      voice = others[Math.floor(Math.random() * others.length)];
    } else voice = list[parseInt(sha1(text).slice(0, 8), 16) % list.length];
    this.lastVoice = voice;
    return voice;
  }

  // The cache file of a line, whether it exists or not
  fileFor(text, voice, s = this.settings()) {
    const id = s.provider === "openai"
      ? ["openai", s.openai.model, voice, s.openai.instructions, text].join("|")
      : [voice, s.rate, s.pitch, text].join("|");
    return path.join(this.cacheDir, `${sha1(id)}.mp3`);
  }

  // Where a line is (or will be) kept, with the voice that says it (with the "line" rotation)
  locate(text, s = this.settings()) {
    const voice = this.voiceFor(text, { ...s, rotation: s.rotation === "fixed" ? "fixed" : "line" });
    return { voice, file: this.fileFor(text, voice, s) };
  }

  // The service sometimes answers without audio: retry once before giving up
  async synth(text, voice) {
    const s = this.settings();
    voice = voice || this.voiceFor(text, s);
    const file = this.fileFor(text, voice, s);
    if (fs.existsSync(file)) return file;
    try {
      await this.generate(text, voice, file, s);
    } catch {
      try {
        await this.generate(text, voice, file, s);
      } catch (e) {
        // Some voices refuse some texts for good (Edge's multilingual ones): the next voice says it,
        // kept under the same file so that the line is still found
        const other = s.list[(s.list.indexOf(voice) + 1) % s.list.length];
        if (other === voice) throw e;
        await this.generate(text, other, file, s);
      }
    }
    return file;
  }

  generate(text, voice, file, s) {
    return s.provider === "openai" ? this.generateOpenAI(text, voice, file, s) : this.generateEdge(text, voice, file, s);
  }

  generateEdge(text, voice, file, { rate, pitch, python }) {
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

  async generateOpenAI(text, voice, file, { openai }) {
    const key = openai.apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OpenAI: no API key (voice.openai.apiKey in config.json, or the OPENAI_API_KEY variable)");
    const body = { model: openai.model, voice, input: text, response_format: "mp3" };
    // Only the gpt-4o-mini-tts family takes a tone instruction
    if (openai.instructions && !/^tts-1/.test(openai.model)) body.instructions = openai.instructions;
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, file);
    return file;
  }
}

// Approximate price of generating these characters, in dollars (0 for the free Edge voices)
function estimateCost(chars, s) {
  if (s.provider !== "openai") return 0;
  if (s.openai.model === "tts-1") return (chars / 1e6) * 15;
  if (s.openai.model === "tts-1-hd") return (chars / 1e6) * 30;
  // gpt-4o-mini-tts: about 0.015 dollar per minute of speech, about 14 characters per second in French
  return (chars / 14 / 60) * 0.015;
}

module.exports = { TTS, estimateCost };
