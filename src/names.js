// Comparaison tolérante des pseudos : le jeu peut afficher un pseudo avec des accents,
// des espaces ou coupé (ex. « MonSuperPséudo20 » pour « MonSuperPseudo2000 »).

// Minuscules, sans accents, sans espaces ni ponctuation
function normalize(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Même pseudo, ou l'un est le début de l'autre (pseudo tronqué), à partir de 8 caractères
function sameName(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.startsWith(short);
}

// La clé de surnoms qui correspond à ce pseudo, ou undefined
function findKey(keys, name) {
  return keys.find((k) => sameName(k, name));
}

module.exports = { normalize, sameName, findKey };
