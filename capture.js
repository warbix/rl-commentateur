// Records every Stats API event (UpdateState only once per second) into a JSONL file, without starting the bot.
// Usage: node capture.js output.jsonl   (replay it with: npm start -- --text-only --replay output.jsonl)
const fs = require("fs");
const { RLClient } = require("./src/rlClient");

const out = process.argv[2];
if (!out) {
  console.error("Usage: node capture.js output.jsonl");
  process.exit(1);
}
let lastState = 0, count = 0;
const rl = new RLClient();
rl.on("connected", () => console.log("Capturing into", out));
rl.on("event", (event, d) => {
  const now = Date.now();
  if (event === "UpdateState") {
    if (now - lastState < 1000) return;
    lastState = now;
  }
  fs.appendFileSync(out, JSON.stringify({ t: now, e: event, d }) + "\n");
  if (++count % 50 === 0) console.log(count, "events recorded");
});
rl.start();
