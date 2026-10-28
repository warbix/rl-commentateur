// Choix d'une phrase au hasard, remplacement des pseudos par les surnoms, et corrections de prononciation.
// phrases.json et config.json sont relus à chaque phrase : on peut les modifier pendant que le bot tourne.

const fs = require("fs");
const { readConfig } = require("./config");
const { findKey } = require("./names");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const NAME = "\u0001"; // repère placé devant chaque nom inséré
const VOWEL = "[aeiouyhAEIOUYHàâäéèêëîïôöûùüÀÂÄÉÈÊËÎÏÔÖÛÙÜ]";

class Phrases {
  constructor(phrasesFile) {
    this.phrasesFile = phrasesFile;
    this.lastIndex = new Map();
  }

  spokenName(name, surnoms) {
    const key = findKey(Object.keys(surnoms), name);
    if (key && surnoms[key].length) return randomItem(surnoms[key]);
    // Pseudo inconnu : on enlève les points, tirets et tirets bas que la voix lirait mal (« XX-_Pseudo_-XX » → « XX Pseudo XX »)
    return String(name).replace(/[._\-]+/g, " ").replace(/\s+/g, " ").trim() || String(name);
  }

  pick(key, vars) {
    const all = JSON.parse(fs.readFileSync(this.phrasesFile, "utf8"));
    const node = key.split(".").reduce((n, k) => (n ? n[k] : undefined), all);
    if (!node || !node.phrases || !node.phrases.length) throw new Error(`Pas de phrases pour "${key}" dans phrases.json`);

    // Jamais deux fois de suite la même phrase pour une situation
    let i = Math.floor(Math.random() * node.phrases.length);
    if (node.phrases.length > 1 && i === this.lastIndex.get(key)) i = (i + 1) % node.phrases.length;
    this.lastIndex.set(key, i);

    const { surnoms = {}, prononciation = {} } = readConfig();
    // Un seul surnom par joueur dans une même phrase. Chaque nom inséré est précédé d'un repère
    // pour faire l'élision juste devant lui (« de Arnaud » → « d'Arnaud »).
    const said = new Map();
    let text = node.phrases[i].replace(/\{(\w+)\}/g, (m, v) => {
      if (!(v in vars)) return m;
      if (typeof vars[v] === "number") return String(vars[v]);
      if (!said.has(vars[v])) said.set(vars[v], this.spokenName(vars[v], surnoms));
      return NAME + said.get(vars[v]);
    });
    text = text
      .replace(new RegExp(`\\b([dD])e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .replace(new RegExp(`\\b([qQ]u)e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .split(NAME).join("");
    return this.pronounce(text, prononciation);
  }

  // Nom prononcé d'un joueur, d'après les surnoms de config.json
  say(name) {
    return this.spokenName(name, readConfig().surnoms || {});
  }

  // Corrections de prononciation de config.json (ex. MVP → aime vie pie)
  pronounce(text, prononciation = readConfig().prononciation || {}) {
    for (const [mot, dit] of Object.entries(prononciation)) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(mot)}\\b`, "g"), dit);
    }
    return text;
  }
}

module.exports = { Phrases };
