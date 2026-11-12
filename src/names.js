// Tolerant comparison of player names: the game may show a name with accents,
// spaces, or cut short (e.g. "MonSuperPséudo20" for "MonSuperPseudo2000").

// Lowercase, no accents, no spaces or punctuation
function normalize(name) {
  return String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Same name, or one is the start of the other (truncated name), from 8 characters on
function sameName(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.startsWith(short);
}

// The key matching this name, or undefined
function findKey(keys, name) {
  return keys.find((k) => sameName(k, name));
}

// players (config.json): { spoken name: [in-game names] }. The spoken name of this in-game name, or undefined if not in the squad.
function squadName(players, name) {
  return Object.keys(players || {}).find((k) => (players[k] || []).some((account) => sameName(account, name)));
}

module.exports = { normalize, sameName, findKey, squadName };
