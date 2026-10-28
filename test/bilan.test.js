const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Bilan } = require("../src/bilan");

test("le bilan survit à une relance du bot pendant la soirée, pas le lendemain", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bilan-")), "bilan.json");
  const b = new Bilan(file);
  b.addFait({ type: "tapin", joueur: "MonPseudo" });
  b.addFait({ type: "tapin", joueur: "MonPseudo" });
  b.addResultat({ gagne: true });
  await new Promise((r) => setTimeout(r, 100));

  const relance = new Bilan(file);
  assert.match(relance.texte((n) => n), /1 match, 1 victoire[\s\S]*Roi du tap-in : MonPseudo, avec 2 tap-ins/);

  const lendemain = new Bilan(file, Date.now() + 7 * 60 * 60 * 1000);
  assert.doesNotMatch(lendemain.texte((n) => n), /tap-in/);
});
