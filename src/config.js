// Lecture de config.json. Relu à chaque appel : les surnoms, la prononciation et les voix
// peuvent être modifiés pendant que le bot tourne. Si le fichier est momentanément invalide
// (en cours d'édition), on garde la dernière version correcte.

const fs = require("fs");
const path = require("path");

// --config autre-fichier.json pour utiliser une autre config (ex. config.exemple.json pour les tests)
const i = process.argv.indexOf("--config");
const FILE = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(__dirname, "..", "config.json"));
let last = null;

function readConfig() {
  try {
    last = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    if (!last) throw new Error(`config.json illisible : ${e.message}`);
  }
  return last;
}

module.exports = { readConfig, CONFIG_FILE: FILE };
