// Journal of the (numbered) triggers and of the squad's votes, to tune the thresholds.
// feedback/triggers.jsonl : one trigger per line (comment, detection or near miss), with its measures
// feedback/votes.json     : for each number, who voted for / against, and the written notes
// The messages posted in Discord are in French, like the rest of what the squad reads and hears.

const fs = require("fs");
const path = require("path");
const { findKey } = require("./names");

// ✅ and 👍 = "well spotted" / "it should have been said"; ❌ and 👎 = the opposite
const FOR = ["✅", "👍"];
const AGAINST = ["❌", "👎"];

const LABELS = {
  tapIn: "Tap-in", steal: "Vol de but", choke: "Craquage",
  "missedSave.escorted": "Arrêt manqué", "missedSave.ownGoal": "Contre son camp",
  "finish.topCorner": "Lucarne", "finish.groundRoller": "But au ras du sol",
  adminAssist: "Passe administrative", beggar: "Mendiant", ghost: "Fantôme",
  "mvp.light": "MVP illégitime (léger)", "mvp.mocking": "MVP illégitime", "mvp.refund": "MVP illégitime (remboursez)",
  "giveaway.shot": "Bénévole", "giveaway.backward": "Balle rendue", "giveaway.saved": "Presque passe décisive à l'adversaire", "giveaway.savedSelf": "Presque passe décisive à l'adversaire (rattrapée par lui-même)", "giveaway.goal": "Bénévole de l'année", "giveaway.ofTheMatch": "Bénévole du match",
};

// Only the player concerned can judge these (a teammate's or an opponent's boost or idleness is not visible)
const PERSONAL = ["ghost", "beggar"];

// Should the squad be asked to vote on this trigger? Everything that can be seen on the pitch or in the replay
// (goals, saves, giveaways, MVP…) for both teams; ghost and beggar only for a player listed in nicknames.
function isVotable(e, nicknames = {}) {
  if (!PERSONAL.includes(e.key.split(".")[0])) return true;
  return findKey(Object.keys(nicknames), e.target) !== undefined;
}

const pad = (n) => String(n).padStart(2, "0");

// Match clock as shown in game (+m:ss in overtime)
function clockText({ seconds, overtime }) {
  const s = Math.max(0, Math.round(seconds));
  return `${overtime ? "+" : ""}${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function valueText(v, unit) {
  if (typeof v !== "number") return String(v);
  if (unit === "uu") return `${(Math.max(0, v) / 100).toFixed(1).replace(".", ",")} m`;
  if (unit === "ms") return `${(v / 1000).toFixed(1).replace(".", ",")} s`;
  if (unit === "kmh") return `${Math.round(v)} km/h`;
  return String(Math.round(v * 100) / 100).replace(".", ",");
}

function measureText(m) {
  if (m.threshold === undefined) return `${m.name} : ${valueText(m.value, m.unit)}`;
  const limit = `${m.direction === "max" ? "max" : "min"} ${valueText(m.threshold, m.unit)}`;
  return `${m.name} ${valueText(m.value, m.unit)} (${limit}) ${m.ok ? "✓" : "✗"}`;
}

// The message posted in Discord for a trigger
function format(e) {
  const start = new Date(e.match.start);
  const head = `⏱ ${clockText(e.clock)} · match de ${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const label = LABELS[e.key] || e.key;
  const target = `${e.target}${e.ours === false ? " (adversaire)" : ""}`;
  const measures = e.measures.map(measureText).join(" · ");
  if (e.type === "nearMiss") {
    return `**#${e.id} ?** · ${head} · *presque* **${label.toLowerCase()}** → ${target}\n${measures}\nFallait-il le dire ? 👍 / 👎`;
  }
  if (e.type === "detection") {
    const why = e.ours === false ? "équipe adverse" : "un autre commentaire passait avant";
    return `**#${e.id}** · ${head} · **${label}** → ${target}\n${measures}\n*Non dit (${why}).* Bien vu ? ✅ / ❌`;
  }
  return `**#${e.id}** · ${head} · **${label}** → ${target}\n${measures}\n> ${e.phrase}`;
}

class Feedback {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.journal = path.join(dir, "triggers.jsonl");
    this.votesFile = path.join(dir, "votes.json");
    this.entries = new Map();
    this.byMessage = new Map();
    if (fs.existsSync(this.journal)) {
      for (const line of fs.readFileSync(this.journal, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const x = JSON.parse(line);
          // A { id, messageId } line completes a trigger already written
          const e = { ...(this.entries.get(x.id) || {}), ...x };
          this.entries.set(x.id, e);
          if (e.messageId) this.byMessage.set(e.messageId, x.id);
        } catch {}
      }
    }
    this.next = Math.max(0, ...this.entries.keys()) + 1;
    try { this.votes = JSON.parse(fs.readFileSync(this.votesFile, "utf8")); } catch { this.votes = {}; }
  }

  // type: "comment" (said), "detection" (not said) or "nearMiss". Returns the trigger with its number.
  add({ type, key, target, ours, vars, measures, clock, match, phrase, t }) {
    const e = { id: this.next++, type, key, target, ours, vars, measures, clock, match, phrase, t };
    this.entries.set(e.id, e);
    fs.appendFileSync(this.journal, JSON.stringify(e) + "\n");
    return e;
  }

  setMessage(id, messageId) {
    this.entries.get(id).messageId = messageId;
    this.byMessage.set(messageId, id);
    fs.appendFileSync(this.journal, JSON.stringify({ id, messageId }) + "\n");
  }

  votesOf(id) {
    return (this.votes[id] = this.votes[id] || { for: [], against: [], notes: [] });
  }

  save() {
    try { fs.writeFileSync(this.votesFile, JSON.stringify(this.votes, null, 1)); } catch {}
  }

  // Reaction added or removed on a bot message. Returns the trigger number concerned, or null.
  react(messageId, emoji, userId, added) {
    const id = this.byMessage.get(messageId);
    const side = FOR.includes(emoji) ? "for" : AGAINST.includes(emoji) ? "against" : null;
    if (!id || !side) return null;
    const v = this.votesOf(id);
    v[side] = v[side].filter((u) => u !== userId);
    if (added) v[side].push(userId);
    this.save();
    return id;
  }

  // An idea for a new situation, with the match and its clock when it was given (feedback/ideas.jsonl)
  addIdea({ by, text, match, clock, t = Date.now() }) {
    const idea = { by, text, match, clock, t };
    fs.appendFileSync(path.join(path.dirname(this.journal), "ideas.jsonl"), JSON.stringify(idea) + "\n");
    return idea;
  }

  ideas() {
    try {
      return fs.readFileSync(path.join(path.dirname(this.journal), "ideas.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  note(id, by, text) {
    if (!this.entries.has(id)) return false;
    this.votesOf(id).notes.push({ by, text, t: Date.now() });
    this.save();
    return true;
  }
}

module.exports = { Feedback, format, isVotable, clockText, valueText, FOR, AGAINST };
