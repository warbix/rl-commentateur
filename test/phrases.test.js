const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
process.argv.push("--config", path.join(ROOT, "config.exemple.json"));
const { Phrases } = require("../src/phrases");

const all = JSON.parse(fs.readFileSync(path.join(ROOT, "phrases.json"), "utf8"));

// Toutes les listes de phrases, avec leur clé (ex. "arretManque.csc")
function situations(node = all, prefix = "") {
  if (node.phrases) return [[prefix, node]];
  return Object.entries(node).filter(([k, v]) => typeof v === "object" && !k.startsWith("_"))
    .flatMap(([k, v]) => situations(v, prefix ? `${prefix}.${k}` : k));
}

test("chaque situation a 5 phrases qui n'utilisent que ses variables", () => {
  for (const [key, node] of situations()) {
    assert.strictEqual(node.phrases.length, 5, key);
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of node.phrases) {
      const used = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.ok(used.length, `${key} : phrase sans pseudo : ${p}`);
      for (const u of used) assert.ok(declared.includes(u), `${key} : {${u}} non déclaré`);
    }
  }
});

test("toutes les variables sont remplacées, un seul surnom par joueur", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (const [key, node] of situations()) {
    const declared = [...node._variables.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const vars = Object.fromEntries(declared.map((v) => [v, ["secondes", "vitesse", "nombre"].includes(v) ? 12 : "MonPseudo"]));
    for (let i = 0; i < 10; i++) {
      const text = phrases.pick(key, vars);
      assert.doesNotMatch(text, /\{\w+\}/, `${key} : ${text}`);
      const said = ["Mon surnom", "Jojo"].filter((s) => text.includes(s));
      assert.ok(said.length <= 1, `${key} : deux surnoms différents : ${text}`);
    }
  }
});

test("prononciation : MVP et pseudos inconnus", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  assert.strictEqual(phrases.pronounce("Le MVP du match"), "Le aime vie pie du match");
  assert.strictEqual(phrases.say(".officer_tom"), "officer tom");
});

test("pseudos : accents, espaces et pseudos tronqués", () => {
  const { sameName } = require("../src/names");
  assert.ok(sameName("MonSuperPséudo20", "MonSuperPseudo2000"));
  assert.ok(sameName("Jean Michel", "JeanMichel"));
  assert.ok(sameName("BOBBY", "bobby"));
  assert.ok(!sameName("bob", "bobby_fan"), "trop court pour un préfixe");
  assert.ok(!sameName("Adversaire1", "MonSuperPseudo2000"));
});

test("élision devant un nom qui commence par une voyelle", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  for (let i = 0; i < 20; i++) {
    const text = phrases.pick("arretManque.accompagne", { defenseur: "Arnaud", buteur: "Adversaire1" });
    assert.doesNotMatch(text, /\b[dD]e Arnaud|\b[qQ]ue Arnaud|\bde Adversaire1/, text);
  }
  assert.strictEqual(phrases.say("XX-_Pseudo_-XX"), "XX Pseudo XX");
});

test("les 5 phrases d'une situation sortent avant qu'une revienne, jamais deux fois de suite", () => {
  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const seen = [];
  for (let i = 0; i < 50; i++) seen.push(phrases.nextIndex("tapin", 5));
  for (let k = 0; k < 50; k += 5) assert.strictEqual(new Set(seen.slice(k, k + 5)).size, 5, `tour ${k / 5} : ${seen.slice(k, k + 5)}`);
  for (let k = 1; k < 50; k++) assert.notStrictEqual(seen[k], seen[k - 1], `répétition à ${k}`);
});
