// Rocket League commentator.
//
//   npm start                                   → Rocket League + Discord
//   npm start -- --local                        → Rocket League + PC speakers (no Discord)
//   npm start -- --text-only                    → Rocket League, text only
//   npm start -- --replay capture.jsonl         → replays a recorded game (works with --local / --text-only)
//   npm start -- --replay capture.jsonl --speed 10
//   npm start -- --config config.example.json … → uses another config

const fs = require("fs");
const path = require("path");
const { RLClient } = require("./rlClient");
const { Detector } = require("./detector");
const { Phrases } = require("./phrases");
const { TTS } = require("./tts");
const { readConfig, CONFIG_FILE } = require("./config");
const { checkAndReport } = require("./apiStats");
const { Recorder } = require("./recorder");
const { PhrasePool } = require("./pool");
const { Recap } = require("./recap");
const { jingleFile } = require("./jingle");
const { Feedback, format, clockText } = require("./feedback");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json missing: copy config.example.json to config.json and fill it in (see README.md).");
    process.exit(1);
  }
  return readConfig();
}

async function main() {
  const config = loadConfig();
  const textOnly = flag("--text-only");
  const local = flag("--local");
  const replayFile = option("--replay");

  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const tts = new TTS({ cacheDir: path.join(ROOT, "cache") });

  let output = null;
  if (local) {
    output = new (require("./localPlayer").LocalPlayer)();
  } else if (!textOnly) {
    output = new (require("./discordVoice").DiscordVoice)(config.discord, config.voice);
  }
  // Jingle (if enabled) then the line
  const play = (file) => {
    const jingle = jingleFile();
    if (jingle) output.enqueue(jingle);
    output.enqueue(file);
  };

  // Numbered triggers and votes (not for a replay: it must not mix with the real votes)
  const feedback = replayFile ? null : new Feedback(path.join(ROOT, "feedback"));

  // The recap of a replay stays separate: it must not mix with the evening's one
  const recap = new Recap(replayFile ? null : path.join(ROOT, "cache", "recap.json"));
  const recapText = () => recap.text((name) => phrases.say(name));

  // Created once Discord is up, but already known to the commands (/idea reads the match clock)
  let detector = null;

  // Discord commands (before start(): they are registered on connection). Replies are in French for the squad.
  let muted = false;
  if (output && output.addCommand) {
    const { SlashCommandBuilder, MessageFlags } = require("discord.js");
    output.addCommand(new SlashCommandBuilder().setName("mute").setDescription("Mutes the commentator"), () => {
      muted = true;
      return "🤐 Commentateur coupé. /unmute pour le relancer.";
    });
    output.addCommand(new SlashCommandBuilder().setName("unmute").setDescription("Unmutes the commentator"), () => {
      muted = false;
      return "🎙️ Le commentateur reprend du service.";
    });
    output.addCommand(
      new SlashCommandBuilder().setName("volume").setDescription("Commentator volume, in %")
        .addIntegerOption((o) => o.setName("percent").setDescription("From 0 to 200").setMinValue(0).setMaxValue(200).setRequired(true)),
      (interaction) => {
        const pct = interaction.options.getInteger("percent");
        output.volume = pct / 100;
        return `🔊 Volume réglé à ${pct} %.`;
      },
    );
    output.addCommand(
      new SlashCommandBuilder().setName("feedback").setDescription("Leave a note on a commentator trigger")
        .addIntegerOption((o) => o.setName("number").setDescription("The trigger number (#12 → 12)").setMinValue(1).setRequired(true))
        .addStringOption((o) => o.setName("text").setDescription("E.g. too harsh, it was a steal, it should have been said…").setRequired(true)),
      (interaction) => {
        const id = interaction.options.getInteger("number");
        const text = interaction.options.getString("text");
        if (!feedback || !feedback.note(id, interaction.user.displayName || interaction.user.username, text)) {
          return { content: `Je ne connais pas de déclenchement #${id}.`, flags: MessageFlags.Ephemeral };
        }
        return `📝 Noté pour #${id} : « ${text} »`;
      },
    );
    output.addCommand(
      new SlashCommandBuilder().setName("idea").setDescription("Suggest a situation the commentator should notice")
        .addStringOption((o) => o.setName("text").setDescription("E.g. 2:10, Marcel and I both went for the ball").setRequired(true)),
      (interaction) => {
        if (!feedback) return { content: "Pas d'idées pendant un rejeu.", flags: MessageFlags.Ephemeral };
        const text = interaction.options.getString("text");
        const inMatch = detector && detector.guid;
        const idea = feedback.addIdea({
          by: interaction.user.displayName || interaction.user.username, text,
          match: inMatch ? { guid: detector.guid, start: detector.matchStart } : null,
          clock: inMatch ? { seconds: detector.time, overtime: detector.overtime } : null,
        });
        console.log(`Idea from ${idea.by}: ${text}`);
        if (!inMatch) return `💡 Idée notée (hors match) : « ${text} »`;
        const start = new Date(idea.match.start);
        const hhmm = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
        return `💡 Idée notée · match de ${hhmm} · ⏱ ${clockText(idea.clock)} : « ${text} »`;
      },
    );
    output.addCommand(new SlashCommandBuilder().setName("recap").setDescription("Evening recap, read out and posted"), async (interaction) => {
      const text = recapText();
      await interaction.deferReply();
      const file = await tts.synth(phrases.pronounce(text.replace(/\n/g, " ")));
      play(file);
      await interaction.editReply(`📋 ${text}`);
    });
  }
  if (output && feedback) output.onVote = (messageId, emoji, userId, added) => feedback.react(messageId, emoji, userId, added);
  if (output) await output.start();

  const pool = output && config.pregenerate !== false
    ? new PhrasePool({ phrases, tts, file: path.join(ROOT, "cache", "pool.json") })
    : null;
  if (pool) pool.warm();

  // Lines are generated one at a time, in order, so that comments don't get mixed up
  let chain = Promise.resolve();
  detector = new Detector({ options: readConfig });
  const recorder = !replayFile && config.recordMatches !== false ? new Recorder(path.join(ROOT, "matches")) : null;
  detector.on("warning", (msg) => console.log(msg));
  detector.on("fact", (f) => recap.addFact(f));
  detector.on("result", (r) => recap.addResult(r));
  // Ctrl+C or closing: print the recap before leaving
  process.on("SIGINT", () => { console.log(`\n${recapText()}`); process.exit(0); });

  // Numbers the trigger and posts it in the text channel (right away, to vote during the replay)
  const publish = (type, c, phrase) => {
    if (!feedback) return "";
    const e = feedback.add({ type, ...c, phrase });
    if (output && output.post) {
      output.post(format(e), type === "nearMiss" ? ["👍", "👎"] : ["✅", "❌"])
        .then((messageId) => messageId && feedback.setMessage(e.id, messageId));
    }
    return `#${e.id} `;
  };

  detector.on("nearMiss", (c) => {
    const num = publish("nearMiss", c);
    console.log(`${new Date(c.t).toLocaleTimeString()} ${num}[near miss ${c.key}] ${c.target}`);
  });

  detector.on("comment", (c) => {
    const { key, vars, live, t } = c;
    // Line already prepared (voice included) if it only mentions the squad, otherwise generated now
    const ready = pool && pool.take(key, vars);
    let text;
    try { text = ready ? ready.text : phrases.pick(key, vars); } catch (e) { return console.error(e.message); }
    const num = publish("comment", c, text);
    console.log(`${new Date(t).toLocaleTimeString()} ${num}[${key}${live ? ", live" : ""}] ${text}`);
    if (recorder) recorder.comment(t, key, text);
    if (!output || muted) return;
    chain = chain
      .then(() => (ready ? ready.file : tts.synth(text)))
      .then((file) => play(file))
      .catch((e) => console.error("Voice:", e.message));
  });

  if (replayFile) {
    await replay(replayFile, Number(option("--speed") || 1), detector);
    return console.log(recapText());
  }

  // A game update can reset PacketSendRate to 0: checked at launch, then every 10 minutes
  const checkApi = (verbose) => {
    const options = readConfig().rocketLeague || {};
    if (options.checkApi !== false) checkAndReport(options, { verbose });
  };
  checkApi(true);
  setInterval(() => checkApi(false), 10 * 60 * 1000);

  const rl = new RLClient(config.rocketLeague);
  rl.on("connected", () => console.log("Rocket League: connected to the Stats API"));
  rl.on("disconnected", () => console.log("Rocket League: connection lost, waiting for the game…"));
  rl.on("event", (event, data) => {
    const t = Date.now();
    if (recorder) recorder.handle(event, data || {}, t);
    detector.handle(event, data || {}, t);
  });
  rl.start();
  console.log("Waiting for Rocket League…");
}

// Replays a file recorded by the bot or capture.js, at the original pace (sped up by --speed)
async function replay(file, speed, detector) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`Replaying ${lines.length} events from ${file} (speed x${speed})`);
  for (let i = 0; i < lines.length; i++) {
    const { t, e, d } = lines[i];
    detector.handle(e, d || {}, t);
    const next = lines[i + 1];
    if (next && speed < 1000) await new Promise((r) => setTimeout(r, Math.min((next.t - t) / speed, 5000)));
  }
  console.log("End of the replayed game.");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
