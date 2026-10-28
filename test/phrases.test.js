const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
process.argv.push("--config", path.join(ROOT, "config.example.json"));
const { Phrases } = require("../src/phrases");
const { sameName } = require("../src/names");

const all = JSON.parse(fs.readFileSync(path.join(ROOT, "phrases.json"), "utf8"));

// Every list of lines, with its key (e.g. "missedSave.ownGoal")
function situations(node = all, prefix = "") {
  if (node.phrases) return [[prefix, node]];
  return Object.entries(node).filter(([k, v]) => typeof v === "object" && !k.startsWith("_"))
    .flatMap(([k, v]) => situations(v, prefix ? `${prefix}.${k}` : k));
}

const NUMBERS = ["seconds", "speed", "count"];

test("every situation has 5 lines that only use its declared variables", () => {
  for (const [key, node] of situations()) {
    assert.strictEqual(node.phrases.length, 5, key);
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of node.phrases) {
      const used = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.ok(used.length, `${key}: line without a name: ${p}`);
      for (const u of used) assert.ok(declared.includes(u), `${key}: {${u}} not declared`);
    }
  }
});

test("every variable is replaced, one nickname per player", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (const [key, node] of situations()) {
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const vars = Object.fromEntries(declared.map((v) => [v, NUMBERS.includes(v) ? 12 : "MonPseudo"]));
    for (let i = 0; i < 10; i++) {
      const text = phrases.pick(key, vars);
      assert.doesNotMatch(text, /\{\w+\}/, `${key}: ${text}`);
      const said = ["Mon surnom", "Jojo"].filter((s) => text.includes(s));
      assert.ok(said.length <= 1, `${key}: two different nicknames: ${text}`);
    }
  }
});

test("pronunciation: MVP and unknown names", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  assert.strictEqual(phrases.pronounce("Le MVP du match"), "Le aime vie pie du match");
  assert.strictEqual(phrases.say(".officer_tom"), "officer tom");
  assert.strictEqual(phrases.say("XX-_Pseudo_-XX"), "XX Pseudo XX");
  assert.strictEqual(phrases.say("?Ferreira?"), "Ferreira");
});

test("names: accents, spaces and truncated names", () => {
  assert.ok(sameName("MonSuperPséudo20", "MonSuperPseudo2000"));
  assert.ok(sameName("Jean Michel", "JeanMichel"));
  assert.ok(sameName("BOBBY", "bobby"));
  assert.ok(!sameName("bob", "bobby_fan"), "too short for a prefix");
  assert.ok(!sameName("Adversaire1", "MonSuperPseudo2000"));
});

test("elision before a name starting with a vowel", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (let i = 0; i < 20; i++) {
    const text = phrases.pick("missedSave.escorted", { defender: "Arnaud", scorer: "Adversaire1" });
    assert.doesNotMatch(text, /\b[dD]e Arnaud|\b[qQ]ue Arnaud|\bde Adversaire1/, text);
  }
});

test("the 5 lines of a situation all come out before one comes back, never twice in a row", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const seen = [];
  for (let i = 0; i < 50; i++) seen.push(phrases.nextIndex("tapIn", 5));
  for (let k = 0; k < 50; k += 5) assert.strictEqual(new Set(seen.slice(k, k + 5)).size, 5, `round ${k / 5}: ${seen.slice(k, k + 5)}`);
  for (let k = 1; k < 50; k++) assert.notStrictEqual(seen[k], seen[k - 1], `repeat at ${k}`);
});

test("a situation can borrow the lines of another one", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const text = phrases.pick("giveaway.backward", { giver: "MonPseudo", opponent: "Adversaire1" });
  assert.match(text, /Adversaire1/);
  assert.doesNotMatch(text, /\{\w+\}/);
});
