// Picks a random line, replaces player names with their nicknames, and fixes pronunciation.
// phrases.json and config.json are re-read for every line: they can be edited while the bot is running.

const fs = require("fs");
const { readConfig } = require("./config");
const { findKey } = require("./names");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const NAME = String.fromCharCode(1); // marker placed before each inserted name
const VOWEL = "[aeiouyhAEIOUYHàâäéèêëîïôöûùüÀÂÄÉÈÊËÎÏÔÖÛÙÜ]";

class Phrases {
  constructor(phrasesFile) {
    this.phrasesFile = phrasesFile;
    this.bags = new Map();
  }

  spokenName(name, nicknames) {
    const key = findKey(Object.keys(nicknames), name);
    if (key && nicknames[key].length) return randomItem(nicknames[key]);
    // Unknown name: keep only letters and digits, the voice reads the rest badly ("XX-_Name_-XX" → "XX Name XX";
    // the game also shows characters it cannot display, like emojis, as "?")
    return String(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim() || String(name);
  }

  pick(key, vars) {
    const all = JSON.parse(fs.readFileSync(this.phrasesFile, "utf8"));
    const find = (k) => k.split(".").reduce((n, part) => (n ? n[part] : undefined), all);
    let node = find(key);
    // A situation can borrow the lines of another one: "backward": "giveaway.shot"
    if (typeof node === "string") node = find(node);
    if (!node || !node.phrases || !node.phrases.length) throw new Error(`No lines for "${key}" in phrases.json`);

    const i = this.nextIndex(key, node.phrases.length);

    const { nicknames = {}, pronunciation = {} } = readConfig();
    // One nickname per player within a line. Each inserted name is preceded by a marker
    // so that the French elision is done right before it ("de Arnaud" → "d'Arnaud").
    const said = new Map();
    let text = node.phrases[i].replace(/\{(\w+)\}/g, (m, v) => {
      if (!(v in vars)) return m;
      if (typeof vars[v] === "number") return String(vars[v]);
      if (!said.has(vars[v])) said.set(vars[v], this.spokenName(vars[v], nicknames));
      return NAME + said.get(vars[v]);
    });
    text = text
      .replace(new RegExp(`\\b([dD])e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .replace(new RegExp(`\\b([qQ]u)e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .split(NAME).join("");
    return this.pronounce(text, pronunciation);
  }

  // All the lines of a situation come out once (in random order) before one comes back,
  // and never the same twice in a row, even from one round to the next
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

  // Spoken name of a player, from the nicknames in config.json
  say(name) {
    return this.spokenName(name, readConfig().nicknames || {});
  }

  // Pronunciation fixes from config.json (e.g. MVP → aime vie pie)
  pronounce(text, pronunciation = readConfig().pronunciation || {}) {
    for (const [word, said] of Object.entries(pronunciation)) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "g"), said);
    }
    return text;
  }
}

module.exports = { Phrases };
