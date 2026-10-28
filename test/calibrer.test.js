const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Retours } = require("../src/retours");
const { calibrate, bestThreshold, apply } = require("../src/calibrer");

test("seuil max : sépare les tap-ins validés des rejetés", () => {
  const points = [600, 700, 750, 820].map((v) => ({ valeur: v, dire: true })).concat([860, 890].map((v) => ({ valeur: v, dire: false })));
  const b = bestThreshold(points, "max", 900);
  assert.strictEqual(b.actuels, 4);
  assert.strictEqual(b.justes, 6);
  assert.ok(b.seuil >= 820 && b.seuil < 860, `seuil ${b.seuil}`);
});

test("calibration : les « presque » validés élargissent le seuil, et --appliquer l'écrit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-"));
  const r = new Retours(dir);
  const add = (type, ms, pour) => {
    const e = r.add({ type, key: "passeAdmin", cible: "X", vars: {}, chrono: { secondes: 60 }, match: { debut: 0 },
      mesures: [{ nom: "délai", cle: "passeAdminMinMs", valeur: ms, sens: "min", unite: "ms", seuil: 4000 }] });
    r.setMessage(e.id, `m${e.id}`);
    r.react(`m${e.id}`, pour ? (type === "presque" ? "👍" : "✅") : (type === "presque" ? "👎" : "❌"), "u1", true);
  };
  add("commentaire", 5000, true); add("commentaire", 6500, true);
  add("presque", 3300, true); add("presque", 3500, true); add("presque", 2900, false);
  r.avis(1, "Bob", "bien vu");

  const { propositions, rapport } = calibrate(r, { passeAdminMinMs: 4000 });
  assert.ok(propositions.passeAdminMinMs >= 2900 && propositions.passeAdminMinMs <= 3300, JSON.stringify(propositions));
  assert.match(rapport, /presque 👍 2 \/ 👎 1/);
  assert.match(rapport, /Bob : bien vu/);

  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, '{\n  "seuils": {\n    "passeAdminMinMs": 4000,\n    "tapinMaxDist": 900\n  }\n}\n');
  apply(config, propositions);
  const c = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.strictEqual(c.seuils.passeAdminMinMs, propositions.passeAdminMinMs);
  assert.strictEqual(c.seuils.tapinMaxDist, 900);
});

test("pas assez de votes : aucune proposition", () => {
  const r = new Retours(fs.mkdtempSync(path.join(os.tmpdir(), "calib-")));
  const e = r.add({ type: "commentaire", key: "tapin", cible: "X", vars: {}, chrono: { secondes: 1 }, match: { debut: 0 },
    mesures: [{ nom: "d", cle: "tapinMaxDist", valeur: 880, sens: "max", unite: "uu", seuil: 900 }] });
  r.setMessage(e.id, "m");
  r.react("m", "❌", "u", true);
  assert.deepStrictEqual(calibrate(r, { tapinMaxDist: 900 }).propositions, {});
});
