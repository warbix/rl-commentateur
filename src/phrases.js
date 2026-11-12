// Picks a random line, replaces player names with their spoken names, and fixes pronunciation.
// phrases.json and config.json are re-read for every line: they can be edited while the bot is running.

const fs = require("fs");
const { readConfig } = require("./config");
const { squadName } = require("./names");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const NAME = String.fromCharCode(1); // marker placed before each inserted name
const VOWEL = "[aeiouyhAEIOUYHàâäéèêëîïôöûùüÀÂÄÉÈÊËÎÏÔÖÛÙÜ]";
// What the voice says instead of an opponent's name (config.json → opponentNames overrides it)
const OPPONENT_NAMES = ["l'adversaire", "un joueur d'en face", "un joueur de l'équipe adverse", "un adversaire"];

// The in-game name as the voice can read it: letters and digits only ("XX-_Name_-XX" → "XX Name XX";
// the game also shows characters it cannot display, like emojis, as "?")
const readable = (name) => String(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim() || String(name);

class Phrases {
  constructor(phrasesFile) {
    this.phrasesFile = phrasesFile;
    this.bags = new Map();
  }

  // A player of the squad → their spoken name; anyone else → the readable in-game name
  spokenName(name, players) {
    return squadName(players, name) || readable(name);
  }

  // The whole phrases.json (re-read: it can be edited while the bot is running)
  all() {
    return JSON.parse(fs.readFileSync(this.phrasesFile, "utf8"));
  }

  // The lines of a situation. A situation can borrow the lines of another one: "backward": "giveaway.shot"
  node(key, all = this.all()) {
    const find = (k) => k.split(".").reduce((n, part) => (n ? n[part] : undefined), all);
    let node = find(key);
    if (typeof node === "string") node = find(node);
    if (!node || !node.phrases || !node.phrases.length) throw new Error(`No lines for "${key}" in phrases.json`);
    return node;
  }

  // opponents: the names in vars that belong to the other team, said as "l'adversaire" and synonyms
  pick(key, vars, { opponents = [] } = {}) {
    const node = this.node(key);
    const i = this.nextIndex(key, node.phrases.length);
    const { players = {}, pronunciation = {}, opponentNames = OPPONENT_NAMES } = readConfig();
    // One name per player within a line
    const said = new Map();
    return this.render(node.phrases[i], (v) => {
      if (!(v in vars)) return undefined;
      if (typeof vars[v] === "number") return vars[v];
      if (!said.has(vars[v])) said.set(vars[v], opponents.includes(vars[v]) ? randomItem(opponentNames) : this.spokenName(vars[v], players));
      return said.get(vars[v]);
    }, pronunciation);
  }

  // Fills a line: valueOf(variable) gives the spoken name (string) or a number, undefined leaves {variable}.
  // The same text always comes out for the same values: the voice library relies on it.
  render(line, valueOf, pronunciation = readConfig().pronunciation || {}) {
    // Each inserted name is preceded by a marker so that the French elision is done right before it ("de Arnaud" → "d'Arnaud")
    let text = line.replace(/\{(\w+)\}/g, (m, v) => {
      const value = valueOf(v);
      if (value === undefined) return m;
      return typeof value === "number" ? String(value) : NAME + value;
    });
    text = text
      .replace(new RegExp(`\\b([dD])e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .replace(new RegExp(`\\b([qQ]u)e ${NAME}(?=${VOWEL})`, "g"), "$1'")
      .split(NAME).join("")
      // "l'adversaire marque" at the start of a sentence → "L'adversaire marque"
      .replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (m, before, letter) => before + letter.toUpperCase());
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

  // Spoken name of a player for the recap: a spoken name stays as is, an in-game name of the squad gives its spoken name
  say(name) {
    const players = readConfig().players || {};
    if (name in players) return name;
    return squadName(players, name) || readable(name);
  }

  // Pronunciation fixes from config.json (e.g. MVP → aime vie pie)
  pronounce(text, pronunciation = readConfig().pronunciation || {}) {
    for (const [word, said] of Object.entries(pronunciation)) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "g"), said);
    }
    return text;
  }
}

module.exports = { Phrases, OPPONENT_NAMES };
