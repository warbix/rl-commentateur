// Détection des situations décrites dans REGLES.md.
// Reçoit les événements du jeu via handle(nom, données, t) et émet "comment" { key, vars, live }.
// Le temps t est passé en paramètre (et pas lu avec Date.now()) pour pouvoir rejouer une capture.

const EventEmitter = require("events");
const { findKey } = require("./names");

const GOAL_LINE = 5120;
const THIRD = (2 * GOAL_LINE) / 3;

// Seuils ⚙️ (voir REGLES.md)
const S = {
  tapinMaxDist: 900, tapinMaxX: 1200, tapinMaxSpeed: 50, tapinMaxGapMs: 2000, tapinMaxTouches: 2,
  shotDelayMs: 300,
  volMaxDist: 1500,
  arretMaxMs: 1000, arretMaxDist: 1500, arretTirSurLigne: 1000, arretTirAvantMs: 3000,
  lucarneMinZ: 450, lucarneMinX: 550, rasDuSolMaxZ: 110, rasDuSolMaxSpeed: 60,
  passeAdminMinMs: 4000, passeAdminMinTouches: 3,
  mvpMinRatio: 0.7,
  mendiantMs: 8000, mendiantAggravantMs: 5000, mendiantApresTouchMs: 3000, mendiantApresEngagementMs: 10000, mendiantCooldownMs: 90000,
  fantome3v3Ms: 45000, fantome2v2Ms: 40000, fantomeAvanceeMin: 1500, fantomeCooldownMs: 120000, fantomeEntreDeuxMs: 60000,
  craquageMaxSecondes: 10,
  benevoleMinMs: 1000, benevoleMinDist: 1500, benevoleMinDistOwn: 2500, benevoleRecul: 800, benevoleFenetreMs: 6000, benevoleDuMatchMin: 3,
  liveCooldownMs: 15000,
  lucarneAttenteMs: 20000,
};

// Ordre de priorité quand plusieurs règles se déclenchent sur le même but
const GOAL_PRIORITY = ["craquage", "vol", "benevole.but", "arretManque.accompagne", "arretManque.csc", "tapin", "passeAdmin"];

// Le joueur visé par chaque situation (celui dont on se moque)
const TARGET = {
  tapin: "buteur", vol: "voleur", arretManque: "defenseur", craquage: "defenseur", lucarne: "buteur",
  passeAdmin: "passeur", mvp: "mvp", mendiant: "joueur", fantome: "joueur", benevole: "benevole",
};

const distOpp = (team, y) => (team === 0 ? GOAL_LINE - y : GOAL_LINE + y);
const distOwn = (team, y) => (team === 0 ? GOAL_LINE + y : GOAL_LINE - y);
const has = (hit, name) => hit.players.some((p) => p.name === name);
const onlyTeam = (hit, team) => hit.players.every((p) => p.team === team);
const findLastIndex = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };

class Detector extends EventEmitter {
  // options() renvoie { commenter, surnoms } (relu à chaque fois depuis config.json)
  constructor({ options = () => ({}) } = {}) {
    super();
    this.options = options;
    this.resetMatch("");
  }

  resetMatch(guid) {
    this.guid = guid;
    this.hits = [];
    this.feed = [];
    this.players = new Map();
    this.inPlay = false;
    this.roundStart = 0;
    this.lastStateT = null;
    this.time = 300;
    this.overtime = false;
    this.teamSize = 3;
    this.scores = [0, 0];
    this.kickoffScores = null; // score au dernier coup d'envoi (inconnu si on arrive en cours de manche)
    this.casseroles = new Map();
    this.benevoles = new Map();
    this.giveaway = null;
    this.pendingGoal = null;
    this.lastLiveT = -Infinity;
    this.lastFantomeT = -Infinity; // deux fantômes (de joueurs différents) espacés d'au moins une minute
    this.mvpChecked = false;
    this.benevoleDone = false;
    this.warnedNoTeam = false;
  }

  // Les équipes où joue au moins un pseudo listé dans les surnoms
  ourTeams() {
    const { surnoms = {} } = this.options() || {};
    const known = Object.keys(surnoms);
    return new Set([...this.players.values()].filter((p) => findKey(known, p.name) !== undefined).map((p) => p.team));
  }

  // Fait marquant pour le bilan de la soirée (toujours compté, même s'il n'est pas commenté)
  fact(type, name) {
    const p = this.players.get(name);
    if (p && this.ourTeams().has(p.team)) this.emit("fait", { type, joueur: name });
  }

  announceBenevole(t) {
    const g = this.giveaway;
    this.giveaway = null;
    this.live("benevole.tir", { benevole: g.p, adversaire: g.shooter }, t);
  }

  countBenevole(name) {
    this.benevoles.set(name, (this.benevoles.get(name) || 0) + 1);
    this.fact("benevole", name);
  }

  // "notre-equipe" : on ne commente que les équipes où joue au moins un pseudo listé dans les surnoms
  isTarget(key, vars) {
    const { commenter = "notre-equipe" } = this.options() || {};
    if (commenter === "tout-le-monde") return true;
    const ourTeams = this.ourTeams();
    if (!ourTeams.size) {
      if (!this.warnedNoTeam && this.players.size) {
        this.warnedNoTeam = true;
        this.emit("warning", "Aucun pseudo de la liste des surnoms dans ce match : personne ne sera commenté (ajoute ton pseudo dans config.json → surnoms).");
      }
      return false;
    }
    const target = this.players.get(vars[TARGET[key.split(".")[0]]]);
    return !!target && ourTeams.has(target.team);
  }

  emitComment(key, vars, live = false) {
    if (!this.isTarget(key, vars)) return false;
    this.emit("comment", { key, vars, live, t: this.now });
    return true;
  }

  // Commentaire en direct : jamais pendant un replay, et espacé des autres
  live(key, vars, t) {
    if (!this.inPlay || t - this.lastLiveT < S.liveCooldownMs || !this.isTarget(key, vars)) return false;
    this.lastLiveT = t;
    const type = key.split(".")[0];
    // Les bénévoles sont comptés à la récupération de balle, pas ici
    if (type !== "benevole") this.fact(type, vars[TARGET[type]]);
    return this.emitComment(key, vars, true);
  }

  player(name, team) {
    let p = this.players.get(name);
    if (!p) {
      p = { name, team, stats: {}, idleMs: 0, zeroBoostMs: 0, lastTouchT: -Infinity, lastFantomeT: -Infinity, lastMendiantT: -Infinity };
      this.players.set(name, p);
    }
    if (team !== undefined) p.team = team;
    return p;
  }

  addCasserole(name) {
    this.casseroles.set(name, (this.casseroles.get(name) || 0) + 1);
  }

  handle(event, d, t) {
    this.now = t;
    if (d && d.MatchGuid && d.MatchGuid !== this.guid && event !== "PlayerLeft") this.resetMatch(d.MatchGuid);

    if (event === "MatchEnded" && typeof d.WinnerTeamNum === "number") {
      const ours = this.ourTeams();
      if (ours.size === 1) this.emit("resultat", { gagne: ours.has(d.WinnerTeamNum) });
    }

    switch (event) {
      case "RoundStarted":
        this.inPlay = true;
        this.roundStart = t;
        this.kickoffScores = [...this.scores];
        // Nouvelle manche : fantôme et mendiant repartent de zéro
        for (const p of this.players.values()) { p.zeroBoostMs = 0; p.idleMs = 0; }
        break;
      case "CountdownBegin":
      case "GoalReplayStart":
      case "MatchEnded":
      case "MatchPaused":
        this.inPlay = false;
        break;
      case "MatchUnpaused":
        this.inPlay = true;
        break;
      case "UpdateState":
        this.onState(d, t);
        break;
      case "BallHit":
        this.onHit(d, t);
        break;
      case "StatfeedEvent":
        this.onFeed(d, t);
        break;
      case "GoalScored":
        if (d.Scorer && d.Scorer.Name) {
          this.onGoal(d, t);
          // Plus personne ne joue jusqu'au prochain coup d'envoi (fantôme et mendiant ne comptent plus)
          this.inPlay = false;
        } else {
          this.onReplayGoal(d);
        }
        break;
      case "PodiumStart":
        this.benevoleDuMatch();
        break;
    }
  }

  onState(d, t) {
    const game = d.Game || {};
    if (Array.isArray(game.Teams)) for (const team of game.Teams) this.scores[team.TeamNum] = team.Score || 0;
    // Arrivé en cours de manche (bot relancé) : le score actuel tient lieu de score au coup d'envoi
    if (!this.kickoffScores && Array.isArray(game.Teams)) this.kickoffScores = [...this.scores];
    if (typeof game.TimeSeconds === "number") this.time = game.TimeSeconds;
    this.overtime = !!game.bOvertime;

    const perTeam = [0, 0];
    for (const s of d.Players || []) {
      const p = this.player(s.Name, s.TeamNum);
      p.stats = s;
      perTeam[s.TeamNum]++;
    }
    if (perTeam[0] || perTeam[1]) this.teamSize = Math.max(perTeam[0], perTeam[1]);

    const dt = this.lastStateT === null ? 0 : Math.min(t - this.lastStateT, 2000);
    this.lastStateT = t;

    if (this.inPlay && !game.bReplay) {
      for (const s of d.Players || []) this.tickPlayer(this.player(s.Name), s, dt, t);
    }

    // Bénévole : tir adverse sans but derrière → on le dit quand le danger est passé
    // (normalement dès que son équipe reprend la balle, voir onHit ; ici au bout de 4 s au pire)
    const g = this.giveaway;
    if (g && g.shotAt && t - g.shotAt >= 4000) {
      this.announceBenevole(t);
    } else if (g && !g.shotAt && t - g.rT > S.benevoleFenetreMs) {
      this.giveaway = null;
    }

    if (this.pendingGoal && t - this.pendingGoal.t > S.lucarneAttenteMs) this.pendingGoal = null;
  }

  tickPlayer(p, s, dt, t) {
    if (!s.bHasCar) { p.zeroBoostMs = 0; return; }

    // Fantôme
    p.idleMs += dt;
    const fantomeMs = this.teamSize >= 3 ? S.fantome3v3Ms : this.teamSize === 2 ? S.fantome2v2Ms : Infinity;
    if (p.idleMs >= fantomeMs && t - p.lastFantomeT >= S.fantomeCooldownMs && t - this.lastFantomeT >= S.fantomeEntreDeuxMs) {
      if (this.live("fantome", { joueur: p.name, secondes: Math.round(p.idleMs / 1000) }, t)) p.lastFantomeT = this.lastFantomeT = t;
    }

    // Mendiant
    const boost = s.Boost || 0;
    if (boost > 0 || s.bOnWall) { p.zeroBoostMs = 0; return; }
    if (t - this.roundStart < S.mendiantApresEngagementMs) return;
    p.zeroBoostMs += dt;
    const lastHit = this.hits[this.hits.length - 1];
    const aggravant = lastHit && distOwn(p.team, lastHit.loc.Y) <= THIRD;
    const seuil = aggravant ? S.mendiantAggravantMs : S.mendiantMs;
    if (p.zeroBoostMs >= seuil && t - p.lastTouchT >= S.mendiantApresTouchMs && t - p.lastMendiantT >= S.mendiantCooldownMs) {
      if (this.live("mendiant", { joueur: p.name, secondes: Math.round(p.zeroBoostMs / 1000) }, t)) p.lastMendiantT = t;
    }
  }

  onHit(d, t) {
    const hit = {
      t,
      players: (d.Players || []).map((p) => ({ name: p.Name, team: p.TeamNum })),
      loc: (d.Ball && d.Ball.Location) || { X: 0, Y: 0, Z: 0 },
      pre: (d.Ball && d.Ball.PreHitSpeed) || 0,
      post: (d.Ball && d.Ball.PostHitSpeed) || 0,
    };
    if (!hit.players.length) return;
    const prev = this.hits[this.hits.length - 1];
    this.hits.push(hit);
    this.hits = this.hits.filter((h) => t - h.t <= 60000);
    for (const p of hit.players) this.player(p.name, p.team).lastTouchT = t;

    if (!prev) return;

    // Fantôme : la touche précédente était-elle utile ?
    for (const pp of prev.players) {
      const keptByTeam = hit.players.some((p) => p.team === pp.team);
      const advanced = distOpp(pp.team, prev.loc.Y) - distOpp(pp.team, hit.loc.Y) >= S.fantomeAvanceeMin;
      if (keptByTeam || advanced) this.player(pp.name).idleMs = 0;
    }

    // Bénévole : après le tir adverse, son équipe a repris la balle → l'action est finie, on peut le dire
    if (this.giveaway && this.giveaway.shotAt && hit.players.some((p) => p.team === this.giveaway.pTeam)) this.announceBenevole(t);

    // Bénévole : la récupération adverse est-elle propre ?
    const g = this.giveaway;
    if (g && !g.clean && g.rHit === prev) {
      if (onlyTeam(hit, g.rTeam)) {
        g.clean = true;
        this.countBenevole(g.p);
      } else {
        this.giveaway = null;
      }
    }

    // Bénévole : nouvelle balle rendue ?
    if (prev.players.length !== 1 || hit.players.length !== 1) return;
    const P = prev.players[0], R = hit.players[0];
    if (P.team === R.team) return;
    const dist = Math.hypot(prev.loc.X - hit.loc.X, prev.loc.Y - hit.loc.Y);
    const ownP = distOwn(P.team, prev.loc.Y), ownR = distOwn(P.team, hit.loc.Y);
    const wasShot = this.feed.some((f) => f.type === "Shot" && f.name === P.name && f.t >= prev.t && f.t <= prev.t + S.shotDelayMs);
    if (t - prev.t >= S.benevoleMinMs && dist >= S.benevoleMinDist && ownP >= S.benevoleMinDistOwn && !wasShot &&
        (ownR <= ownP - S.benevoleRecul || ownR < GOAL_LINE)) {
      this.giveaway = { p: P.name, pTeam: P.team, r: R.name, rTeam: R.team, rT: t, rHit: hit, clean: false, shotAt: null, shooter: null };
    }
  }

  onFeed(d, t) {
    const target = d.MainTarget || {};
    const f = { t, type: d.EventName, name: target.Name, team: target.TeamNum };
    this.feed.push(f);
    this.feed = this.feed.filter((x) => t - x.t <= 60000);

    if (["Shot", "Save", "EpicSave", "Goal", "Assist"].includes(f.type) && f.name) this.player(f.name).idleMs = 0;

    const g = this.giveaway;
    if (f.type === "Shot" && g && f.team === g.rTeam && !g.shotAt && t - g.rT <= S.benevoleFenetreMs) {
      g.shotAt = t;
      g.shooter = f.name;
    }

    if (f.type === "MVP") this.checkMvp(f.name);
  }

  onGoal(d, t) {
    const scorer = d.Scorer.Name, TS = d.Scorer.TeamNum, TD = 1 - TS;
    const hits = this.hits.filter((h) => h.t >= this.roundStart && h.t <= t);
    const found = {};

    // Tap-in et vol de but : la séquence de touches du buteur et ce qui la précède
    const iS = findLastIndex(hits, (h) => has(h, scorer));
    if (iS >= 0) {
      const lastS = hits[iS];
      let iFirst = iS;
      while (iFirst > 0 && hits[iFirst - 1].players.length === 1 && hits[iFirst - 1].players[0].name === scorer) iFirst--;
      const sTouches = iS - iFirst + 1;
      const prev = hits[iFirst - 1];
      const mate = prev && onlyTeam(prev, TS) ? prev.players.find((p) => p.name !== scorer) : null;

      if (mate && distOpp(TS, lastS.loc.Y) <= S.tapinMaxDist && Math.abs(lastS.loc.X) <= S.tapinMaxX &&
          lastS.post <= S.tapinMaxSpeed && hits[iFirst].t - prev.t <= S.tapinMaxGapMs && sTouches <= S.tapinMaxTouches) {
        found.tapin = { buteur: scorer, passeur: mate.name };
      }

      if (mate) {
        const mateShot = this.feed.some((f) => f.type === "Shot" && f.name === mate.name && f.t >= prev.t && f.t <= prev.t + S.shotDelayMs);
        const onlyScorerAfter = hits.slice(iFirst).every((h) => h.players.every((p) => p.name === scorer));
        const scorerNear = hits.slice(iFirst, iS + 1).every((h) => distOpp(TS, h.loc.Y) <= S.volMaxDist);
        if (mateShot && onlyScorerAfter && scorerNear) found.vol = { voleur: scorer, victime: mate.name };
      }
    }

    // Arrêt manqué (et craquage)
    const iD = findLastIndex(hits, (h) => t - h.t <= S.arretMaxMs && h.players.some((p) => p.team === TD));
    if (iD >= 0 && distOwn(TD, hits[iD].loc.Y) <= S.arretMaxDist) {
      const defender = hits[iD].players.find((p) => p.team === TD).name;
      const iAtk = findLastIndex(hits.slice(0, iD), (h) => h.players.some((p) => p.team === TS));
      // La balle rentrait si l'attaquant avait un tir cadré peu avant la touche du défenseur (le jeu l'envoie parfois
      // avant la touche elle-même), ou s'il l'a touchée sur la ligne (le jeu n'envoie pas toujours "Shot" si près)
      const onTarget = iAtk >= 0 && (distOpp(TS, hits[iAtk].loc.Y) <= S.arretTirSurLigne ||
        this.feed.some((f) => f.type === "Shot" && f.team === TS && f.t >= hits[iD].t - S.arretTirAvantMs && f.t <= hits[iD].t));
      found[onTarget ? "arretManque.accompagne" : "arretManque.csc"] = { defenseur: defender, buteur: scorer };

      const [s, o] = this.kickoffScores ? [this.kickoffScores[TS], this.kickoffScores[TD]] : [NaN, NaN];
      if (!this.overtime && this.time <= S.craquageMaxSecondes && (s === o - 1 || s === o)) {
        found.craquage = { defenseur: defender, buteur: scorer };
      }
    }

    // Bénévole de l'année
    const g = this.giveaway;
    if (g && g.rTeam === TS && t - g.rT <= S.benevoleFenetreMs) {
      if (!g.clean) this.countBenevole(g.p);
      found["benevole.but"] = { benevole: g.p, adversaire: scorer };
      this.giveaway = null;
    }

    // Passe décisive administrative
    const assister = d.Assister && d.Assister.Name;
    if (assister) {
      const iA = findLastIndex(hits, (h) => has(h, assister));
      if (iA >= 0) {
        const after = hits.slice(iA + 1);
        const iFirstS = after.findIndex((h) => has(h, scorer));
        const scorerTouches = after.filter((h) => has(h, scorer)).length;
        const oppBetween = after.slice(0, iFirstS < 0 ? after.length : iFirstS).some((h) => h.players.some((p) => p.team === TD));
        const ms = t - hits[iA].t;
        if (ms >= S.passeAdminMinMs || scorerTouches >= S.passeAdminMinTouches || oppBetween) {
          found.passeAdmin = { passeur: assister, buteur: scorer, secondes: Math.round(ms / 1000) };
        }
      }
    }

    // Casseroles pour le MVP illégitime
    if (found.tapin) this.addCasserole(scorer);
    if (found.vol) this.addCasserole(scorer);
    if (found.passeAdmin) this.addCasserole(assister);
    const arret = found["arretManque.accompagne"] || found["arretManque.csc"];
    if (arret) this.addCasserole(arret.defenseur);

    // Tout compte pour le bilan (le craquage est déjà un arrêt manqué, le bénévole est compté à part)
    for (const [k, vars] of Object.entries(found)) {
      const type = k.split(".")[0];
      if (type !== "craquage" && type !== "benevole") this.fact(type, vars[TARGET[type]]);
    }

    // La situation la plus piquante parmi celles qui visent un joueur de notre équipe
    const key = GOAL_PRIORITY.find((k) => found[k] && this.isTarget(k, found[k]));
    if (key) {
      this.pendingGoal = null;
      this.emitComment(key, found[key]);
    } else {
      // Rien de piquant : on attend le 2e GoalScored (replay) pour la lucarne
      this.pendingGoal = { t, scorer, speed: d.GoalSpeed || 0 };
    }
  }

  onReplayGoal(d) {
    const g = this.pendingGoal;
    if (!g || !d.ImpactLocation) return;
    this.pendingGoal = null;
    const { X, Z } = d.ImpactLocation;
    if (Z >= S.lucarneMinZ && Math.abs(X) >= S.lucarneMinX) {
      this.fact("lucarne", g.scorer);
      this.emitComment("lucarne.lucarne", { buteur: g.scorer });
    } else if (Z <= S.rasDuSolMaxZ && g.speed <= S.rasDuSolMaxSpeed) {
      this.emitComment("lucarne.rasDuSol", { buteur: g.scorer, vitesse: Math.round(g.speed) });
    }
  }

  checkMvp(name) {
    const mvp = this.players.get(name);
    if (!mvp || this.mvpChecked) return;
    this.mvpChecked = true;
    const m = mvp.stats;
    const score = m.Score || 0;
    const ratio = score ? (100 * (m.Goals || 0) + 50 * (m.Assists || 0)) / score : 0;
    const mates = [...this.players.values()].filter((p) => p.team === mvp.team);
    const avgTouches = mates.reduce((a, p) => a + (p.stats.Touches || 0), 0) / mates.length;
    const cas = this.casseroles.get(mvp.name) || 0;
    const vrai = mates.filter((p) => p !== mvp).sort((a, b) => (b.stats.Touches || 0) - (a.stats.Touches || 0))[0];
    if (vrai && ratio >= S.mvpMinRatio && (m.Touches || 0) <= avgTouches && !(m.Saves > 0) && cas >= 1) {
      const tier = cas >= 3 ? "rembourse" : cas === 2 ? "moqueur" : "leger";
      this.fact("mvpVole", mvp.name);
      this.emitComment(`mvp.${tier}`, { mvp: mvp.name, vraiMvp: vrai.name });
    }
  }

  benevoleDuMatch() {
    if (this.benevoleDone) return;
    this.benevoleDone = true;
    const [best, nombre] = [...this.benevoles.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (best && nombre >= S.benevoleDuMatchMin) this.emitComment("benevole.duMatch", { benevole: best, nombre });
  }
}

module.exports = { Detector, SEUILS: S };
