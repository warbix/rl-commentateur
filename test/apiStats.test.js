const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkStatsApi } = require("../src/apiStats");

function fakeInstall(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  fs.mkdirSync(path.join(dir, "TAGame", "Config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "TAGame", "Config", "DefaultStatsAPI.ini"), content);
  return dir;
}

test("sets PacketSendRate back to 30 after an update, keeping a copy of the original", () => {
  const dir = fakeInstall("[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\nPacketSendRate=0\r\n");
  const [r] = checkStatsApi({ gamePaths: [dir], search: false });
  assert.deepStrictEqual([r.before, r.after, r.fixed, r.error], [0, 30, true, null]);
  const ini = path.join(dir, "TAGame", "Config", "DefaultStatsAPI.ini");
  assert.match(fs.readFileSync(ini, "utf8"), /^PacketSendRate=30\r?$/m);
  assert.match(fs.readFileSync(`${ini}.bak`, "utf8"), /PacketSendRate=0/);

  const [again] = checkStatsApi({ gamePaths: [dir], search: false });
  assert.strictEqual(again.fixed, false);
});

test("adds the line when it is missing", () => {
  const dir = fakeInstall("[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\n");
  const [r] = checkStatsApi({ gamePaths: [dir], search: false, packetSendRate: 60 });
  assert.strictEqual(r.after, 60);
  assert.match(fs.readFileSync(path.join(dir, "TAGame", "Config", "DefaultStatsAPI.ini"), "utf8"), /PacketSendRate=60/);
});
