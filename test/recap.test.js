const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Recap } = require("../src/recap");

test("the recap survives a bot restart during the evening, not the next day", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recap-")), "recap.json");
  const r = new Recap(file);
  r.addFact({ type: "tapIn", player: "MonPseudo" });
  r.addFact({ type: "tapIn", player: "MonPseudo" });
  r.addResult({ won: true });

  const restarted = new Recap(file);
  assert.match(restarted.text((n) => n), /1 match, 1 victoire[\s\S]*Roi du tap-in : MonPseudo, avec 2 tap-ins/);

  const nextDay = new Recap(file, Date.now() + 7 * 60 * 60 * 1000);
  assert.doesNotMatch(nextDay.text((n) => n), /tap-in/);
});
