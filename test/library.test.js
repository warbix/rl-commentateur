const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
process.argv.push("--config", path.join(ROOT, "config.example.json"));
const { Phrases } = require("../src/phrases");
const { TTS } = require("../src/tts");
const library = require("../src/library");

const phrases = new Phrases(path.join(ROOT, "phrases.json"));
const OPPONENT = { "giveaway.shot": "opponent", "giveaway.backward": "opponent", "giveaway.saved": "opponent", "giveaway.goal": "opponent" };
// The squad of config.example.json
const SQUAD = ["MonPseudo", "Coequipier1", "Coequipier2"];

test("every line said during a match is in the voice library", () => {
  const texts = new Set(library.lines(phrases).map((l) => l.text));
  const all = phrases.all();
  const keys = Object.keys(OPPONENT).concat(["tapIn", "steal", "teamBlock", "ownGoal", "finish.topCorner", "nearGoal.crossbar",
    "nearGoal.post", "nearGoal.topCorner", "adminAssist", "mvp.light", "mvp.mocking", "mvp.refund", "ghost", "giveaway.ofTheMatch"]);
  for (const key of keys) {
    const node = phrases.node(key, all);
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (let i = 0; i < 40; i++) {
      const squad = [...SQUAD].sort(() => Math.random() - 0.5);
      const vars = {};
      for (const v of declared) vars[v] = v === "count" ? 3 + (i % 8) : v === OPPONENT[key] ? "Adversaire1" : squad.pop();
      const text = phrases.pick(key, vars, { opponents: ["Adversaire1"] });
      assert.ok(texts.has(text), `${key}: not in the library: ${text}`);
    }
  }
});

test("a line always has the same voice, and the voices still change from one line to the next", () => {
  const tts = new TTS({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "tts-")) });
  const s = { ...tts.settings(), rotation: "line" };
  const lines = library.lines(phrases).slice(0, 60);
  for (const l of lines) assert.strictEqual(tts.voiceFor(l.text, s), tts.voiceFor(l.text, s));
  assert.ok(new Set(lines.map((l) => tts.voiceFor(l.text, s))).size > 1);
  assert.strictEqual(tts.locate(lines[0].text, s).file, tts.fileFor(lines[0].text, tts.voiceFor(lines[0].text, s), s));
});
