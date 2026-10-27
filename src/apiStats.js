// Vérifie que l'API Stats est activée dans chaque installation de Rocket League (Steam et Epic),
// et remet PacketSendRate à la bonne valeur si une mise à jour du jeu l'a remis à 0.
// Utilisable seul : npm run verifier-api

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const INI = path.join("TAGame", "Config", "DefaultStatsAPI.ini");

function steamInstalls() {
  const roots = new Set(["C:\\Program Files (x86)\\Steam"]);
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { encoding: "utf8" });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
    if (m) roots.add(m[1].trim().replace(/\//g, "\\"));
  } catch {}
  // Les autres bibliothèques Steam (autres disques) sont listées dans libraryfolders.vdf
  const libraries = new Set();
  for (const root of roots) {
    libraries.add(root);
    try {
      const vdf = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"(.+?)"/g)) libraries.add(m[1].replace(/\\\\/g, "\\"));
    } catch {}
  }
  return [...libraries].map((lib) => path.join(lib, "steamapps", "common", "rocketleague"));
}

function epicInstalls() {
  try {
    const dat = JSON.parse(fs.readFileSync("C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat", "utf8"));
    // "Sugar" est le nom de code de Rocket League chez Epic
    return (dat.InstallationList || []).filter((i) => i.AppName === "Sugar").map((i) => i.InstallLocation);
  } catch {
    return [];
  }
}

function gameRunning() {
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq RocketLeague.exe", "/NH"], { encoding: "utf8" }).includes("RocketLeague.exe");
  } catch {
    return false;
  }
}

// Renvoie un résultat par installation trouvée : { file, avant, apres, corrige, erreur }
function checkStatsApi({ packetSendRate = 30, cheminsJeu = [] } = {}) {
  // Windows ne tient pas compte des majuscules : on dédoublonne en minuscules, mais on garde le chemin tel quel
  const unique = new Map();
  for (const d of [...steamInstalls(), ...epicInstalls(), ...cheminsJeu]) {
    const full = path.resolve(d);
    if (!unique.has(full.toLowerCase())) unique.set(full.toLowerCase(), full);
  }
  const dirs = [...unique.values()];
  const results = [];
  for (const dir of dirs) {
    const file = path.join(dir, INI);
    if (!fs.existsSync(file)) continue;
    const result = { file, avant: null, apres: null, corrige: false, erreur: null };
    try {
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/^PacketSendRate=(\d+)/m);
      result.avant = m ? Number(m[1]) : null;
      result.apres = result.avant;
      if (result.avant !== packetSendRate) {
        // Copie de l'original, une seule fois
        if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
        const fixed = m ? text.replace(/^PacketSendRate=\d+/m, `PacketSendRate=${packetSendRate}`) : `${text.trimEnd()}\r\nPacketSendRate=${packetSendRate}\r\n`;
        fs.writeFileSync(file, fixed);
        result.apres = packetSendRate;
        result.corrige = true;
      }
    } catch (e) {
      result.erreur = e.code === "EPERM" || e.code === "EACCES" ? "accès refusé (relance en administrateur)" : e.message;
    }
    results.push(result);
  }
  return results;
}

// Vérifie, corrige et affiche le résultat. Renvoie true si une correction a été faite.
function checkAndReport(options, { verbose = true } = {}) {
  const results = checkStatsApi(options);
  if (!results.length) {
    console.log("API Stats : aucune installation de Rocket League trouvée (ajoute le dossier du jeu dans config.json → rocketLeague.cheminsJeu).");
    return false;
  }
  let changed = false;
  for (const r of results) {
    if (r.erreur) console.log(`API Stats : impossible de corriger ${r.file} : ${r.erreur}`);
    else if (r.corrige) { changed = true; console.log(`API Stats : réactivée dans ${r.file} (PacketSendRate ${r.avant} → ${r.apres})`); }
    else if (verbose) console.log(`API Stats : OK dans ${r.file}`);
  }
  if (changed && gameRunning()) console.log("API Stats : ⚠️ Rocket League est déjà lancé, relance le jeu pour que le réglage soit pris en compte.");
  return changed;
}

module.exports = { checkStatsApi, checkAndReport };

if (require.main === module) {
  const { readConfig } = require("./config");
  let options = {};
  try { options = readConfig().rocketLeague || {}; } catch {}
  checkAndReport(options);
}
