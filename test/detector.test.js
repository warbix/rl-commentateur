// Rejoue le match classé enregistré et vérifie que le bot dit toujours la même chose.
// Si une modification des règles change ces résultats volontairement, mets à jour les listes attendues.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Detector } = require("../src/detector");

const ROOT = path.join(__dirname, "..");
const exemple = JSON.parse(fs.readFileSync(path.join(ROOT, "config.exemple.json"), "utf8"));
const events = fs.readFileSync(path.join(ROOT, "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const TARGET = { tapin: "buteur", vol: "voleur", arretManque: "defenseur", craquage: "defenseur", lucarne: "buteur", passeAdmin: "passeur", mvp: "mvp", mendiant: "joueur", fantome: "joueur", benevole: "benevole" };

function replay(options) {
  const detector = new Detector({ options: () => options });
  const comments = [], faits = [], resultats = [];
  detector.on("comment", ({ key, vars }) => comments.push(`${key} → ${vars[TARGET[key.split(".")[0]]]}`));
  detector.on("fait", ({ type, joueur }) => faits.push(`${type} → ${joueur}`));
  detector.on("resultat", ({ gagne }) => resultats.push(gagne));
  for (const { t, e, d } of events) detector.handle(e, d || {}, t);
  return { comments, faits, resultats };
}

test("notre équipe : les commentaires du match", () => {
  assert.deepStrictEqual(replay(exemple).comments, [
    "fantome → Coequipier2",
    "fantome → Coequipier1",
    "lucarne.lucarne → Coequipier1",
    "benevole.but → Coequipier1",
    "fantome → Coequipier2",
    "tapin → MonPseudo",
  ]);
});

test("notre équipe : jamais de commentaire sur un adversaire", () => {
  for (const c of replay(exemple).comments) assert.doesNotMatch(c, /Adversaire/);
});

test("tout le monde : l'arrêt manqué adverse passe devant le tap-in", () => {
  const { comments } = replay({ ...exemple, commenter: "tout-le-monde" });
  assert.strictEqual(comments[comments.length - 1], "arretManque.accompagne → Adversaire3");
});

test("bilan : faits marquants et victoire", () => {
  const { faits, resultats } = replay(exemple);
  assert.deepStrictEqual(resultats, [true]);
  for (const f of ["tapin → MonPseudo", "lucarne → Coequipier1", "benevole → Coequipier1", "fantome → Coequipier2"]) {
    assert.ok(faits.includes(f), `fait manquant : ${f}`);
  }
});

test("aucun pseudo connu : silence", () => {
  assert.deepStrictEqual(replay({ ...exemple, surnoms: {} }).comments, []);
});
