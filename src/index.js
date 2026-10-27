// Commentateur Rocket League.
//
//   npm start                                  → Rocket League + Discord
//   npm start -- --local                       → Rocket League + haut-parleurs du PC (sans Discord)
//   npm start -- --muet                        → Rocket League, texte seulement
//   npm start -- --rejouer capture.jsonl       → rejoue une partie enregistrée (combinable avec --local / --muet)
//   npm start -- --rejouer capture.jsonl --vitesse 10
//   npm start -- --config config.exemple.json ...  → utilise une autre config

const fs = require("fs");
const path = require("path");
const { RLClient } = require("./rlClient");
const { Detector } = require("./detector");
const { Phrases } = require("./phrases");
const { TTS } = require("./tts");
const { readConfig, CONFIG_FILE } = require("./config");
const { checkAndReport } = require("./apiStats");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json manquant : copie config.exemple.json en config.json et remplis-le (voir README.md).");
    process.exit(1);
  }
  return readConfig();
}

async function main() {
  const config = loadConfig();
  const muet = flag("--muet");
  const local = flag("--local");

  const phrases = new Phrases(path.join(ROOT, "phrases.json"));
  const tts = new TTS({ cacheDir: path.join(ROOT, "cache") });

  let output = null;
  if (local) {
    output = new (require("./localPlayer").LocalPlayer)();
  } else if (!muet) {
    output = new (require("./discordVoice").DiscordVoice)(config.discord, config.voix);
  }
  if (output) await output.start();

  // Les phrases sont générées une par une, dans l'ordre, pour ne pas mélanger les commentaires
  let chain = Promise.resolve();
  const detector = new Detector({ options: readConfig });
  detector.on("warning", (msg) => console.log(msg));
  detector.on("comment", ({ key, vars, live, t }) => {
    let text;
    try { text = phrases.pick(key, vars); } catch (e) { return console.error(e.message); }
    console.log(`${new Date(t).toLocaleTimeString()} [${key}${live ? ", direct" : ""}] ${text}`);
    if (!output) return;
    chain = chain
      .then(() => tts.synth(text))
      .then((file) => output.enqueue(file, text))
      .catch((e) => console.error("Voix :", e.message));
  });

  const replayFile = option("--rejouer");
  if (replayFile) return replay(replayFile, Number(option("--vitesse") || 1), detector);

  // Une mise à jour du jeu peut remettre PacketSendRate à 0 : on vérifie au lancement, puis toutes les 10 minutes
  const checkApi = (verbose) => {
    const options = readConfig().rocketLeague || {};
    if (options.verifierApi !== false) checkAndReport(options, { verbose });
  };
  checkApi(true);
  setInterval(() => checkApi(false), 10 * 60 * 1000);

  const rl = new RLClient(config.rocketLeague);
  rl.on("connected", () => console.log("Rocket League : connecté à l'API Stats"));
  rl.on("disconnected", () => console.log("Rocket League : connexion perdue, on attend le jeu…"));
  rl.on("event", (event, data) => detector.handle(event, data || {}, Date.now()));
  rl.start();
  console.log("En attente de Rocket League…");
}

// Rejoue un fichier enregistré par capture.js, en respectant le rythme d'origine (accéléré par --vitesse)
async function replay(file, speed, detector) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`Rejoue ${lines.length} événements de ${file} (vitesse x${speed})`);
  for (let i = 0; i < lines.length; i++) {
    const { t, e, d } = lines[i];
    detector.handle(e, d || {}, t);
    const next = lines[i + 1];
    if (next && speed < 1000) await new Promise((r) => setTimeout(r, Math.min((next.t - t) / speed, 5000)));
  }
  console.log("Fin de la partie rejouée.");
}

main().catch((e) => {
  console.error("Erreur :", e.message);
  process.exit(1);
});
