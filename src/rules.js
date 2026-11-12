// Rules that can be switched off in config.json → rules, by family ({ "ghost": false })
// or one by one ({ "giveaway.ofTheMatch": false }). A rule that is off is not detected at all:
// no voice, no Discord post, no vote, nothing in the recap, no line in the voice library.

function ruleEnabled(rules, key) {
  if (!rules) return true;
  return rules[key] !== false && rules[key.split(".")[0]] !== false;
}

module.exports = { ruleEnabled };
