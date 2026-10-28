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
    this.bags = new Map();
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

    const i = this.nextIndex(key, node.phrases.length);

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

  // Les phrases d'une situation sortent toutes une fois (dans le désordre) avant qu'une revienne,
  // et jamais deux fois de suite la même, même d'un tour à l'autre
  nextIndex(key, count) {
    let bag = this.bags.get(key);
    if (!bag || bag.count !== count || !bag.left.length) {
      const left = [...Array(count).keys()].sort(() => Math.random() - 0.5);
      if (count > 1 && bag && left[left.length - 1] === bag.last) left.unshift(left.pop());
      bag = { count, left, last: bag && bag.last };
      this.bags.set(key, bag);
    }
    bag.last = bag.left.pop();
    return bag.last;
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
