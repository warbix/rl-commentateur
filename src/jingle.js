// Petit bruitage joué avant chaque phrase, pour attirer l'attention.
// config.json → voix.jingle : true (ding par défaut), false, ou le chemin d'un fichier audio à toi.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { readConfig } = require("./config");

const ROOT = path.join(__dirname, "..");
const DEFAULT = path.join(ROOT, "cache", "jingle.mp3");

// Ding en deux notes, fabriqué une fois avec FFmpeg
function makeDefault() {
  if (fs.existsSync(DEFAULT)) return DEFAULT;
  fs.mkdirSync(path.dirname(DEFAULT), { recursive: true });
  execFileSync(ffmpegPath, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=0.12",
    "-f", "lavfi", "-i", "sine=frequency=1320:duration=0.25",
    "-filter_complex", "[0][1]concat=n=2:v=0:a=1,afade=t=out:st=0.22:d=0.15,volume=0.35",
    "-ar", "48000", DEFAULT,
  ]);
  return DEFAULT;
}

function jingleFile() {
  const setting = (readConfig().voix || {}).jingle;
  if (!setting) return null;
  if (setting === true) {
    try { return makeDefault(); } catch (e) { console.error("Jingle :", e.message); return null; }
  }
  const file = path.resolve(ROOT, String(setting));
  if (fs.existsSync(file)) return file;
  console.error(`Jingle introuvable : ${file}`);
  return null;
}

module.exports = { jingleFile };
