// Choix d'une phrase au hasard, remplacement des pseudos par les surnoms, et corrections de prononciation.
// phrases.json et config.json sont relus à chaque phrase : on peut les modifier pendant que le bot tourne.

const fs = require("fs");
const { readConfig } = require("./config");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

class Phrases {
  constructor(phrasesFile) {
    this.phrasesFile = phrasesFile;
    this.lastIndex = new Map();
  }

  spokenName(name, surnoms) {
    const key = Object.keys(surnoms).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (key && surnoms[key].length) return randomItem(surnoms[key]);
    // Pseudo inconnu : on enlève les points et tirets bas que la voix lirait mal
    return String(name).replace(/[._]+/g, " ").trim() || String(name);
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
    // Un seul surnom par joueur dans une même phrase
    const said = new Map();
    let text = node.phrases[i].replace(/\{(\w+)\}/g, (m, v) => {
      if (!(v in vars)) return m;
      if (typeof vars[v] === "number") return String(vars[v]);
      if (!said.has(vars[v])) said.set(vars[v], this.spokenName(vars[v], surnoms));
      return said.get(vars[v]);
    });
    for (const [mot, dit] of Object.entries(prononciation)) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(mot)}\\b`, "g"), dit);
    }
    return text;
  }
}

module.exports = { Phrases };
