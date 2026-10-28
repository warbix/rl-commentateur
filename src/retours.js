// Journal des déclenchements (numérotés) et des votes de la bande, pour régler les seuils.
// retours/declenchements.jsonl : un déclenchement par ligne (commentaire ou « presque »), avec ses mesures
// retours/votes.json           : pour chaque numéro, qui a voté pour / contre, et les avis écrits

const fs = require("fs");
const path = require("path");

// ✅ et 👍 = « bien vu » / « il fallait le dire » ; ❌ et 👎 = l'inverse
const POUR = ["✅", "👍"];
const CONTRE = ["❌", "👎"];

const LABELS = {
  tapin: "Tap-in", vol: "Vol de but", craquage: "Craquage",
  "arretManque.accompagne": "Arrêt manqué", "arretManque.csc": "Contre son camp",
  "lucarne.lucarne": "Lucarne", "lucarne.rasDuSol": "But au ras du sol",
  passeAdmin: "Passe administrative", mendiant: "Mendiant", fantome: "Fantôme",
  "mvp.leger": "MVP illégitime (léger)", "mvp.moqueur": "MVP illégitime", "mvp.rembourse": "MVP illégitime (remboursez)",
  "benevole.tir": "Bénévole", "benevole.but": "Bénévole de l'année", "benevole.duMatch": "Bénévole du match",
};

const pad = (n) => String(n).padStart(2, "0");

function chrono({ secondes, prolongation }) {
  const s = Math.max(0, Math.round(secondes));
  return `${prolongation ? "+" : ""}${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function valeur(v, unite) {
  if (typeof v !== "number") return String(v);
  if (unite === "uu") return `${(Math.max(0, v) / 100).toFixed(1).replace(".", ",")} m`;
  if (unite === "ms") return `${(v / 1000).toFixed(1).replace(".", ",")} s`;
  if (unite === "kmh") return `${Math.round(v)} km/h`;
  return String(Math.round(v * 100) / 100).replace(".", ",");
}

function mesure(m) {
  if (m.seuil === undefined) return `${m.nom} : ${valeur(m.valeur, m.unite)}`;
  const limite = `${m.sens === "max" ? "max" : "min"} ${valeur(m.seuil, m.unite)}`;
  return `${m.nom} ${valeur(m.valeur, m.unite)} (${limite}) ${m.ok ? "✓" : "✗"}`;
}

// Le message posté dans Discord pour un déclenchement
function format(e) {
  const debut = new Date(e.match.debut);
  const tete = `⏱ ${chrono(e.chrono)} · match de ${pad(debut.getHours())}:${pad(debut.getMinutes())}`;
  const label = LABELS[e.key] || e.key;
  const mesures = e.mesures.map(mesure).join(" · ");
  if (e.type === "presque") {
    return `**#${e.id} ?** · ${tete} · *presque* **${label.toLowerCase()}** → ${e.cible}\n${mesures}\nFallait-il le dire ? 👍 / 👎`;
  }
  return `**#${e.id}** · ${tete} · **${label}** → ${e.cible}\n${mesures}\n> ${e.phrase}`;
}

class Retours {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.journal = path.join(dir, "declenchements.jsonl");
    this.votesFile = path.join(dir, "votes.json");
    this.entries = new Map();
    this.byMessage = new Map();
    if (fs.existsSync(this.journal)) {
      for (const line of fs.readFileSync(this.journal, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const x = JSON.parse(line);
          // Une ligne { id, messageId } complète un déclenchement déjà écrit
          const e = { ...(this.entries.get(x.id) || {}), ...x };
          this.entries.set(x.id, e);
          if (e.messageId) this.byMessage.set(e.messageId, x.id);
        } catch {}
      }
    }
    this.next = Math.max(0, ...this.entries.keys()) + 1;
    try { this.votes = JSON.parse(fs.readFileSync(this.votesFile, "utf8")); } catch { this.votes = {}; }
  }

  // type : "commentaire" ou "presque". Renvoie le déclenchement avec son numéro.
  add({ type, key, cible, vars, mesures, chrono: c, match, phrase, t }) {
    const e = { id: this.next++, type, key, cible, vars, mesures, chrono: c, match, phrase, t };
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
    return (this.votes[id] = this.votes[id] || { pour: [], contre: [], avis: [] });
  }

  save() {
    try { fs.writeFileSync(this.votesFile, JSON.stringify(this.votes, null, 1)); } catch {}
  }

  // Réaction ajoutée ou retirée sur un message du bot. Renvoie le numéro concerné, ou null.
  react(messageId, emoji, userId, added) {
    const id = this.byMessage.get(messageId);
    const side = POUR.includes(emoji) ? "pour" : CONTRE.includes(emoji) ? "contre" : null;
    if (!id || !side) return null;
    const v = this.votesOf(id);
    v[side] = v[side].filter((u) => u !== userId);
    if (added) v[side].push(userId);
    this.save();
    return id;
  }

  avis(id, userName, texte) {
    if (!this.entries.has(id)) return false;
    this.votesOf(id).avis.push({ par: userName, texte, t: Date.now() });
    this.save();
    return true;
  }
}

module.exports = { Retours, format, chrono, valeur, POUR, CONTRE };
