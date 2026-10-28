// Checks that the Stats API is enabled in every Rocket League install (Steam and Epic),
// and sets PacketSendRate back to the right value if a game update reset it to 0.
// Can be run on its own: npm run check-api

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
  // The other Steam libraries (other drives) are listed in libraryfolders.vdf
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
    // "Sugar" is Rocket League's code name at Epic
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

// Returns one result per install found: { file, before, after, fixed, error }
// search: false to only check gamePaths (used by the tests)
function checkStatsApi({ packetSendRate = 30, gamePaths = [], search = true } = {}) {
  // Windows ignores case: deduplicate in lowercase, but keep the path as is
  const unique = new Map();
  const found = search ? [...steamInstalls(), ...epicInstalls()] : [];
  for (const d of [...found, ...gamePaths]) {
    const full = path.resolve(d);
    if (!unique.has(full.toLowerCase())) unique.set(full.toLowerCase(), full);
  }
  const results = [];
  for (const dir of unique.values()) {
    const file = path.join(dir, INI);
    if (!fs.existsSync(file)) continue;
    const result = { file, before: null, after: null, fixed: false, error: null };
    try {
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/^PacketSendRate=(\d+)/m);
      result.before = m ? Number(m[1]) : null;
      result.after = result.before;
      if (result.before !== packetSendRate) {
        // Copy of the original, only once
        if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
        const fixed = m ? text.replace(/^PacketSendRate=\d+/m, `PacketSendRate=${packetSendRate}`) : `${text.trimEnd()}\r\nPacketSendRate=${packetSendRate}\r\n`;
        fs.writeFileSync(file, fixed);
        result.after = packetSendRate;
        result.fixed = true;
      }
    } catch (e) {
      result.error = e.code === "EPERM" || e.code === "EACCES" ? "access denied (run as administrator)" : e.message;
    }
    results.push(result);
  }
  return results;
}

// Checks, fixes and prints the result. Returns true if something was fixed.
function checkAndReport(options, { verbose = true } = {}) {
  const results = checkStatsApi(options);
  if (!results.length) {
    console.log("Stats API: no Rocket League install found (add the game folder to config.json → rocketLeague.gamePaths).");
    return false;
  }
  let changed = false;
  for (const r of results) {
    if (r.error) console.log(`Stats API: cannot fix ${r.file}: ${r.error}`);
    else if (r.fixed) { changed = true; console.log(`Stats API: re-enabled in ${r.file} (PacketSendRate ${r.before} → ${r.after})`); }
    else if (verbose) console.log(`Stats API: OK in ${r.file}`);
  }
  if (changed && gameRunning()) console.log("Stats API: ⚠️ Rocket League is already running, restart the game for the setting to apply.");
  return changed;
}

module.exports = { checkStatsApi, checkAndReport, gameRunning };

if (require.main === module) {
  const { readConfig } = require("./config");
  let options = {};
  try { options = readConfig().rocketLeague || {}; } catch {}
  checkAndReport(options);
}
