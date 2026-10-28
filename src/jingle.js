// Short sound played before each line, to get attention.
// config.json → voice.jingle: true (default ding), false, or the path of your own audio file.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { readConfig } = require("./config");

const ROOT = path.join(__dirname, "..");
const DEFAULT = path.join(ROOT, "cache", "jingle.mp3");

// Two-note ding, made once with FFmpeg
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
  const setting = (readConfig().voice || {}).jingle;
  if (!setting) return null;
  if (setting === true) {
    try { return makeDefault(); } catch (e) { console.error("Jingle:", e.message); return null; }
  }
  const file = path.resolve(ROOT, String(setting));
  if (fs.existsSync(file)) return file;
  console.error(`Jingle not found: ${file}`);
  return null;
}

module.exports = { jingleFile };
