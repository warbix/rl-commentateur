// Replays the recorded ranked match and checks that the bot still says the same things.
// If a rule change alters these results on purpose, update the expected lists.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Detector, TARGET } = require("../src/detector");
const { migrate } = require("../src/config");

const ROOT = path.join(__dirname, "..");
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
migrate(example);
const events = fs.readFileSync(path.join(ROOT, "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function replay(options) {
  const detector = new Detector({ options: () => options });
  const comments = [], nearMisses = [], facts = [], results = [];
  detector.on("comment", ({ key, vars }) => comments.push(`${key} → ${vars[TARGET[key.split(".")[0]]]}`));
  detector.on("nearMiss", ({ key, target, measures }) => nearMisses.push({ key, target, measures }));
  detector.on("fact", ({ type, player }) => facts.push(`${type} → ${player}`));
  detector.on("result", ({ won }) => results.push(won));
  for (const { t, e, d } of events) detector.handle(e, d || {}, t);
  return { comments, nearMisses, facts, results };
}

test("our team: the match comments", () => {
  assert.deepStrictEqual(replay(example).comments, [
    "ghost → Coequipier2",
    "ghost → Coequipier1",
    "finish.topCorner → Coequipier1",
    "giveaway.goal → Coequipier1",
    "ghost → Coequipier2",
    "tapIn → MonPseudo",
  ]);
});

test("our team: never a comment about an opponent", () => {
  for (const c of replay(example).comments) assert.doesNotMatch(c, /Adversaire/);
});

test("everyone: the opponent's missed save beats the tap-in", () => {
  const { comments } = replay({ ...example, target: "everyone" });
  assert.strictEqual(comments[comments.length - 1], "missedSave.escorted → Adversaire3");
});

test("recap: facts and win", () => {
  const { facts, results } = replay(example);
  assert.deepStrictEqual(results, [true]);
  for (const f of ["tapIn → MonPseudo", "finish → Coequipier1", "giveaway → Coequipier1", "ghost → Coequipier2"]) {
    assert.ok(facts.includes(f), `missing fact: ${f}`);
  }
});

test("no known name: silence", () => {
  assert.deepStrictEqual(replay({ ...example, nicknames: {} }).comments, []);
});

test("thresholds from config: a stricter tap-in disappears, then becomes a near miss", () => {
  const strict = { ...example, thresholds: { tapInMaxDistance: 50 } };
  const { comments, nearMisses } = replay(strict);
  assert.ok(!comments.includes("tapIn → MonPseudo"));
  assert.ok(nearMisses.some((n) => n.key === "tapIn" && n.target === "MonPseudo"));
});
