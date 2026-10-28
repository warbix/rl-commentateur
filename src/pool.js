// Lines prepared in advance for the squad (the names in config.json → nicknames).
// For the situations that only mention players of our team, one line (text + voice) is generated
// per combination of players, in the background. When the comment comes, it plays without waiting
// for the voice; a new one is prepared right away for next time.
// The pool is kept in cache/pool.json and emptied when the lines, nicknames or voices change.

const fs = require("fs");
const crypto = require("crypto");
const { readConfig } = require("./config");
const { normalize, findKey } = require("./names");

// Situations whose variables are all players of our team
const SITUATIONS = {
  tapIn: ["scorer", "passer"],
  steal: ["thief", "victim"],
  "finish.topCorner": ["scorer"],
  "mvp.light": ["mvp", "realMvp"],
  "mvp.mocking": ["mvp", "realMvp"],
  "mvp.refund": ["mvp", "realMvp"],
};

// Every way to pick n different players, in order
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

  // Fingerprint of everything that changes the text or the voice: if it moves, the pool is stale
  signature() {
    const { nicknames, pronunciation, voice } = readConfig();
    const phrasesText = fs.readFileSync(this.phrases.phrasesFile, "utf8");
    return crypto.createHash("sha1").update(JSON.stringify([phrasesText, nicknames, pronunciation, voice && voice.list, voice && voice.rate, voice && voice.pitch])).digest("hex");
  }

  checkSignature() {
    const sig = this.signature();
    if (sig !== this.data.signature) this.data = { signature: sig, entries: {} };
  }

  poolKey(key, vars) {
    const names = SITUATIONS[key];
    // The in-game name (e.g. truncated) is mapped back to the matching nicknames key
    const keys = Object.keys(readConfig().nicknames || {});
    return names ? `${key}|${names.map((n) => normalize(findKey(keys, vars[n]) || vars[n])).join("|")}` : null;
  }

  save() {
    fs.writeFile(this.file, JSON.stringify(this.data), () => {});
  }

  // A line ready for this comment, or null
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

  // Prepares the whole pool in the background
  warm() {
    this.checkSignature();
    const friends = Object.keys(readConfig().nicknames || {});
    const missing = [];
    for (const [key, names] of Object.entries(SITUATIONS)) {
      for (const combo of arrangements(friends, names.length)) {
        const vars = Object.fromEntries(names.map((n, i) => [n, combo[i]]));
        if (!this.data.entries[this.poolKey(key, vars)]) missing.push({ key, vars });
      }
    }
    if (!missing.length) return;
    console.log(`Preparing ${missing.length} lines for the squad, in the background…`);
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
        console.error("Preparing lines:", e.message);
        break;
      }
    }
    this.save();
    if (total > 1 && done) console.log(`${done} lines ready for the squad.`);
    this.running = false;
  }
}

module.exports = { PhrasePool };
