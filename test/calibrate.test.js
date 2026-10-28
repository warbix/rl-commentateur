const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Feedback } = require("../src/feedback");
const { calibrate, bestThreshold, apply } = require("../src/calibrate");

test("max threshold: separates the approved tap-ins from the rejected ones", () => {
  const points = [600, 700, 750, 820].map((v) => ({ value: v, say: true })).concat([860, 890].map((v) => ({ value: v, say: false })));
  const b = bestThreshold(points, "max", 900);
  assert.strictEqual(b.respectedNow, 4);
  assert.strictEqual(b.respected, 6);
  assert.ok(b.threshold >= 820 && b.threshold < 860, `threshold ${b.threshold}`);
});

test("calibration: approved near misses widen the threshold, and --apply writes it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-"));
  const f = new Feedback(dir);
  const add = (type, ms, approve) => {
    const e = f.add({ type, key: "adminAssist", target: "X", vars: {}, clock: { seconds: 60 }, match: { start: 0 },
      measures: [{ name: "délai", key: "adminAssistMinMs", value: ms, direction: "min", unit: "ms", threshold: 4000 }] });
    f.setMessage(e.id, `m${e.id}`);
    f.react(`m${e.id}`, approve ? (type === "nearMiss" ? "👍" : "✅") : (type === "nearMiss" ? "👎" : "❌"), "u1", true);
  };
  add("comment", 5000, true); add("comment", 6500, true);
  add("nearMiss", 3300, true); add("nearMiss", 3500, true); add("nearMiss", 2900, false);
  f.note(1, "Bob", "bien vu");

  const { suggestions, report } = calibrate(f, { adminAssistMinMs: 4000 });
  assert.ok(suggestions.adminAssistMinMs >= 2900 && suggestions.adminAssistMinMs <= 3300, JSON.stringify(suggestions));
  assert.match(report, /near misses 👍 2 \/ 👎 1/);
  assert.match(report, /Bob : bien vu/);

  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, '{\n  "thresholds": {\n    "adminAssistMinMs": 4000,\n    "tapInMaxDistance": 900\n  }\n}\n');
  apply(config, suggestions);
  const c = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.strictEqual(c.thresholds.adminAssistMinMs, suggestions.adminAssistMinMs);
  assert.strictEqual(c.thresholds.tapInMaxDistance, 900);
});

test("not enough votes: no suggestion", () => {
  const f = new Feedback(fs.mkdtempSync(path.join(os.tmpdir(), "calib-")));
  const e = f.add({ type: "comment", key: "tapIn", target: "X", vars: {}, clock: { seconds: 1 }, match: { start: 0 },
    measures: [{ name: "d", key: "tapInMaxDistance", value: 880, direction: "max", unit: "uu", threshold: 900 }] });
  f.setMessage(e.id, "m");
  f.react("m", "❌", "u", true);
  assert.deepStrictEqual(calibrate(f, { tapInMaxDistance: 900 }).suggestions, {});
});

test("votes survive a restart, and a removed reaction no longer counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const f = new Feedback(dir);
  const e = f.add({ type: "comment", key: "tapIn", target: "X", vars: {}, measures: [], clock: { seconds: 1 }, match: { start: 0 } });
  f.setMessage(e.id, "msg");
  f.react("msg", "✅", "u1", true);
  f.react("msg", "❌", "u2", true);
  f.react("msg", "❌", "u2", false);
  const again = new Feedback(dir);
  assert.deepStrictEqual(again.votes[e.id], { for: ["u1"], against: [], notes: [] });
  assert.strictEqual(again.byMessage.get("msg"), e.id);
  assert.strictEqual(again.next, e.id + 1);
});

test("ideas are kept with their match and clock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-"));
  new Feedback(dir).addIdea({ by: "Bob", text: "double commit à 2:10", match: { guid: "G", start: 0 }, clock: { seconds: 130, overtime: false } });
  const [idea] = new Feedback(dir).ideas();
  assert.strictEqual(idea.text, "double commit à 2:10");
  assert.deepStrictEqual(idea.clock, { seconds: 130, overtime: false });
});
