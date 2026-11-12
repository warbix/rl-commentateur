const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
process.argv.push("--config", path.join(ROOT, "config.example.json"));
const { Phrases, UNKNOWN_NAMES } = require("../src/phrases");
const { sameName, squadName } = require("../src/names");

const all = JSON.parse(fs.readFileSync(path.join(ROOT, "phrases.json"), "utf8"));

// Every list of lines, with its key (e.g. "missedSave.ownGoal")
function situations(node = all, prefix = "") {
  if (node.phrases) return [[prefix, node]];
  return Object.entries(node).filter(([k, v]) => typeof v === "object" && !k.startsWith("_"))
    .flatMap(([k, v]) => situations(v, prefix ? `${prefix}.${k}` : k));
}

const NUMBERS = ["seconds", "speed", "count"];

test("every situation has 10 lines that only use its declared variables", () => {
  for (const [key, node] of situations()) {
    assert.strictEqual(node.phrases.length, 10, key);
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of node.phrases) {
      const used = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.ok(used.length, `${key}: line without a name: ${p}`);
      for (const u of used) assert.ok(declared.includes(u), `${key}: {${u}} not declared`);
    }
  }
});

test("every variable is replaced, and a player of the squad is said by their spoken name", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (const [key, node] of situations()) {
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const vars = Object.fromEntries(declared.map((v) => [v, NUMBERS.includes(v) ? 12 : "MonPseudo"]));
    for (let i = 0; i < 10; i++) {
      const text = phrases.pick(key, vars);
      assert.doesNotMatch(text, /\{\w+\}/, `${key}: ${text}`);
      assert.doesNotMatch(text, /MonPseudo/, `${key}: in-game name said: ${text}`);
    }
  }
});

test("pronunciation, the squad's spoken names, and unknown teammates", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  assert.strictEqual(phrases.pronounce("Le MVP du match"), "Le aime vie pie du match");
  // Recap: in-game name or spoken name → spoken name; anyone else → the readable in-game name
  assert.strictEqual(phrases.say("MonPséudo"), "Jojo");
  assert.strictEqual(phrases.say("Jojo"), "Jojo");
  assert.strictEqual(phrases.say("XX-_Pseudo_-XX"), "XX Pseudo XX");
  assert.strictEqual(phrases.say("?Pseudo?"), "Pseudo");
  // In a line: a teammate outside the squad is said with a formula, or by the readable name if there is none
  assert.ok(UNKNOWN_NAMES.includes(phrases.spokenName(".officer_tom", { Jojo: ["MonPseudo"] })));
  assert.strictEqual(phrases.spokenName(".officer_tom", {}, []), "officer tom");
});

test("two accounts of one player count as one", () => {
  const players = { Arnaud: ["MonCompteSteam", "MonCompteEpic"] };
  assert.strictEqual(squadName(players, "MonCompteEpic"), "Arnaud");
  assert.strictEqual(squadName(players, "moncomptesteam"), "Arnaud");
  assert.strictEqual(squadName(players, "Adversaire1"), undefined);
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
    const text = phrases.pick("missedSave.escorted", { defender: "Coequipier2", scorer: "Adversaire1" }, { opponents: ["Adversaire1"] });
    assert.doesNotMatch(text, /\b[dD]e Albert|\b[qQ]ue Albert|\bde un\b/, text);
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
  const text = phrases.pick("giveaway.backward", { giver: "MonPseudo", opponent: "Adversaire1" }, { opponents: ["Adversaire1"] });
  assert.match(text, /Jojo/);
  assert.doesNotMatch(text, /\{\w+\}/);
});

test("opponents are said as \"l'adversaire\" and synonyms, with elision and a capital at the start", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (let i = 0; i < 30; i++) {
    const text = phrases.pick("missedSave.escorted", { defender: "MonPseudo", scorer: "Adversaire1" }, { opponents: ["Adversaire1"] });
    assert.doesNotMatch(text, /Adversaire1/, text);
    assert.doesNotMatch(text, /\bde un\b|^[a-zà-ÿ]/, text);
  }
});
