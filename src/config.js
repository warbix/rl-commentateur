// Reads config.json. Re-read on every call: nicknames, pronunciation, voices and thresholds
// can be edited while the bot is running. If the file is momentarily invalid (being edited),
// the last valid version is kept.
// Older configs are migrated on first read: the former French keys become the English ones, and
// nicknames (in-game name → spoken names) becomes players (spoken name → in-game names).

const fs = require("fs");
const path = require("path");

// --config other-file.json to use another config (e.g. config.example.json for tests)
const i = process.argv.indexOf("--config");
const FILE = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(__dirname, "..", "config.json"));
let last = null;

// Former French keys → English keys, per section ("" = top level)
const KEYS = {
  "": {
    _commenter: "_target", commenter: "target", _surnoms: "_nicknames", surnoms: "nicknames",
    _prononciation: "_pronunciation", prononciation: "pronunciation", _voix: "_voice", voix: "voice",
    _pregenerer: "_pregenerate", pregenerer: "pregenerate", _enregistrerMatchs: "_recordMatches", enregistrerMatchs: "recordMatches",
    _seuils: "_thresholds", seuils: "thresholds", _rocketLeague: "_rocketLeague",
  },
  discord: { salonVocalId: "voiceChannelId", salonTexteId: "textChannelId", _suivre: "_follow", suivre: "follow" },
  voice: { liste: "list", vitesse: "rate", hauteur: "pitch" },
  rocketLeague: { hote: "host", verifierApi: "checkApi", cheminsJeu: "gamePaths" },
  thresholds: {
    tapinMaxDist: "tapInMaxDistance", tapinMaxX: "tapInMaxSideOffset", tapinMaxSpeed: "tapInMaxSpeed",
    tapinMaxGapMs: "tapInMaxGapMs", tapinMaxTouches: "tapInMaxTouches", volMaxDist: "stealMaxDistance",
    arretMaxMs: "missedSaveMaxMs", arretMaxDist: "missedSaveMaxDistance", arretTirSurLigne: "missedSaveOnLineDistance",
    arretTirAvantMs: "missedSaveShotWindowMs", lucarneMinZ: "topCornerMinHeight", lucarneMinX: "topCornerMinSideOffset",
    rasDuSolMaxZ: "groundRollerMaxHeight", rasDuSolMaxSpeed: "groundRollerMaxSpeed", passeAdminMinMs: "adminAssistMinMs",
    passeAdminMinTouches: "adminAssistMinTouches", mvpMinRatio: "mvpMinHighlightRatio", mendiantMs: "beggarMs",
    mendiantAggravantMs: "beggarUnderPressureMs", mendiantApresTouchMs: "beggarAfterTouchMs",
    mendiantApresEngagementMs: "beggarAfterKickoffMs", mendiantCooldownMs: "beggarCooldownMs",
    fantome3v3Ms: "ghost3v3Ms", fantome2v2Ms: "ghost2v2Ms", fantomeAvanceeMin: "ghostMinAdvance",
    fantomeCooldownMs: "ghostCooldownMs", fantomeEntreDeuxMs: "ghostSpacingMs", craquageMaxSecondes: "chokeMaxSecondsLeft",
    benevoleMinMs: "giveawayMinMs", benevoleMinDist: "giveawayMinDistance", benevoleMinDistOwn: "giveawayMinOwnGoalDistance",
    benevoleRecul: "giveawayMinBackward", benevoleFenetreMs: "giveawayWindowMs", benevoleDuMatchMin: "giveawayOfTheMatchMin",
    lucarneAttenteMs: "topCornerWaitMs", presqueMarge: "nearMissMargin",
  },
};
const VALUES = {
  target: { "notre-equipe": "our-team", "tout-le-monde": "everyone" },
  rotation: { aleatoire: "random", alternee: "alternate", fixe: "fixed" },
};

// Renames keys in place, keeping their order. Returns true if something changed.
function renameKeys(obj, map) {
  if (!obj || typeof obj !== "object") return false;
  let changed = false;
  for (const [k, v] of Object.entries(obj)) {
    delete obj[k];
    const nk = map[k] || k;
    obj[nk] = v;
    if (nk !== k) changed = true;
  }
  return changed;
}

const PLAYERS_DOC = "Spoken name -> in-game names (one player can have several accounts: they count as one). Case, accents, spaces and punctuation don't matter, and a name cut short by the game (8 characters or more) is recognized: MonSuperPseudo2000 = MonSuperPséudo20. These players define our team. Can be changed while the bot is running.";

// Replaces a key by another one at the same place
function replaceKey(obj, oldKey, newKey, value) {
  for (const [k, v] of Object.entries(obj)) {
    delete obj[k];
    if (k === oldKey) obj[newKey] = value;
    else obj[k] = v;
  }
}

// nicknames { in-game name: [spoken names] } → players { first spoken name: [in-game names] }
function nicknamesToPlayers(config) {
  if (!config.nicknames || config.players) return false;
  const players = {};
  for (const [account, names] of Object.entries(config.nicknames)) {
    const name = (Array.isArray(names) && names[0]) || account;
    (players[name] = players[name] || []).push(account);
  }
  if ("_nicknames" in config) replaceKey(config, "_nicknames", "_players", PLAYERS_DOC);
  replaceKey(config, "nicknames", "players", players);
  return true;
}

function migrate(config) {
  let changed = renameKeys(config, KEYS[""]);
  for (const section of ["discord", "voice", "rocketLeague", "thresholds"]) changed = renameKeys(config[section], KEYS[section]) || changed;
  if (VALUES.target[config.target]) { config.target = VALUES.target[config.target]; changed = true; }
  if (config.voice && VALUES.rotation[config.voice.rotation]) { config.voice.rotation = VALUES.rotation[config.voice.rotation]; changed = true; }
  if (config.voice && config.voice.nom && !config.voice.list) { config.voice.list = [config.voice.nom]; delete config.voice.nom; changed = true; }
  return nicknamesToPlayers(config) || changed;
}

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (migrate(config)) {
      fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + "\n");
      console.log(`${path.basename(FILE)}: migrated to the current format`);
    }
    last = config;
  } catch (e) {
    if (!last) throw new Error(`config.json unreadable: ${e.message}`);
  }
  return last;
}

module.exports = { readConfig, migrate, CONFIG_FILE: FILE };
