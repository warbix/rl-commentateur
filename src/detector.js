// Detects the situations described in REGLES.md.
// Receives game events through handle(name, data, t) and emits:
//   "comment"  { key, vars, live, target, measures, clock, match, t } → situation to comment on
//   "nearMiss" { key, vars, target, measures, clock, match, t }       → missed by a little, to be voted on
//   "fact"     { type, player }  → for the evening recap (counted even when not commented)
//   "result"   { won }           → end of a match where our team is known
// The time t is passed in (not read with Date.now()) so that a recording can be replayed.
// Thresholds come from config.json → thresholds (re-read on every event), otherwise from the defaults below.

const EventEmitter = require("events");
const { findKey } = require("./names");

const GOAL_LINE = 5120;
const THIRD = (2 * GOAL_LINE) / 3;

// Default thresholds ⚙️ (see REGLES.md). Distances in game units (1 = 1 cm), speeds in km/h, durations in ms.
const DEFAULTS = {
  tapInMaxDistance: 900, tapInMaxSideOffset: 1200, tapInMaxSpeed: 50, tapInMaxGapMs: 2000, tapInMaxTouches: 2,
  shotDelayMs: 300,
  stealMaxDistance: 1500,
  missedSaveMaxMs: 1000, missedSaveMaxDistance: 1500, missedSaveOnLineDistance: 1000, missedSaveShotWindowMs: 3000,
  topCornerMinHeight: 450, topCornerMinSideOffset: 550, groundRollerMaxHeight: 110, groundRollerMaxSpeed: 60,
  adminAssistMinMs: 4000, adminAssistMinTouches: 3,
  mvpMinHighlightRatio: 0.7,
  beggarMs: 8000, beggarUnderPressureMs: 5000, beggarAfterTouchMs: 3000, beggarAfterKickoffMs: 10000, beggarCooldownMs: 90000,
  // Useful action for the ghost: a touch kept by the team, a demo, or anything the game rewards with ≥ 10 points
  // (center 10, clear 20, shot 20, save 50, goal 100… — a plain touch is only worth 2)
  ghost3v3Ms: 45000, ghost2v2Ms: 40000, ghostMinScoreGain: 10, ghostCooldownMs: 120000, ghostSpacingMs: 60000,
  chokeMaxSecondsLeft: 10,
  giveawayMinMs: 1000, giveawayMinDistance: 1500, giveawayMinOwnGoalDistance: 2500, giveawayMinBackward: 800, giveawayWindowMs: 6000, giveawayOfTheMatchMin: 3,
  // A ball sent at least this far back towards one's own goal is commented on even without an opponent shot
  giveawayBackwardNoShot: 1500,
  // Near assist to the opponent: a touch in one's own half that does not go forward, picked up by an opponent
  // (not a 50/50), who shoots, and the shot is saved by the giver's team
  nearAssistMaxOwnGoalDistance: 5120, nearAssistMaxForward: 500, nearAssistMinMs: 1000,
  nearAssistShotWindowMs: 4000, nearAssistSaveWindowMs: 2500,
  liveCooldownMs: 15000,
  topCornerWaitMs: 20000,
  // Near miss: every failed measure misses its threshold by less than 30 %
  nearMissMargin: 0.3,
};

// Priority when several rules fire on the same goal
const GOAL_PRIORITY = ["choke", "steal", "giveaway.goal", "missedSave.escorted", "missedSave.ownGoal", "tapIn", "adminAssist"];
// Near misses that can be offered on a goal, by priority
const NEAR_MISS_PRIORITY = ["missedSave", "tapIn", "adminAssist"];

// The player each situation targets (the one being mocked)
const TARGET = {
  tapIn: "scorer", steal: "thief", missedSave: "defender", choke: "defender", finish: "scorer",
  adminAssist: "passer", mvp: "mvp", beggar: "player", ghost: "player", giveaway: "giver",
};

const distToOpponentGoal = (team, y) => (team === 0 ? GOAL_LINE - y : GOAL_LINE + y);
const distToOwnGoal = (team, y) => (team === 0 ? GOAL_LINE + y : GOAL_LINE - y);
const has = (hit, name) => hit.players.some((p) => p.name === name);
const onlyTeam = (hit, team) => hit.players.every((p) => p.team === team);
const findLastIndex = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };

// A numeric condition. name: shown in Discord (French); key: its threshold in config;
// direction: "max" (value ≤ threshold) or "min" (≥); unit: "uu" | "ms" | "kmh" | "n"
const condition = (name, key, value, direction, unit) => ({ name, key, value, direction, unit });

class Detector extends EventEmitter {
  // options() returns { target, nicknames, thresholds } (re-read from config.json every time)
  constructor({ options = () => ({}) } = {}) {
    super();
    this.options = options;
    this.S = { ...DEFAULTS };
    this.resetMatch("", 0);
  }

  resetMatch(guid, t) {
    this.guid = guid;
    this.matchStart = t;
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
    this.kickoffScores = null; // score at the last kickoff (unknown when joining mid-round)
    this.blunders = new Map(); // player → count, for the undeserved MVP
    this.giveaways = new Map();
    this.giveaway = null;
    this.nearAssist = null;
    this.pendingGoal = null;
    this.lastLiveT = -Infinity;
    this.lastGhostT = -Infinity; // two ghosts (of different players) at least a minute apart
    this.mvpChecked = false;
    this.giveawayOfTheMatchDone = false;
    this.warnedNoTeam = false;
  }

  // Compares each measure with its threshold: ok if all pass, near miss if the failing ones fail by a little
  evaluate(conditions) {
    const margin = this.S.nearMissMargin;
    const measures = conditions.map((c) => {
      const threshold = this.S[c.key];
      const ok = c.direction === "max" ? c.value <= threshold : c.value >= threshold;
      const close = c.direction === "max" ? c.value <= threshold * (1 + margin) : c.value >= threshold * (1 - margin);
      return { ...c, threshold, ok, close };
    });
    const ok = measures.every((m) => m.ok);
    return { ok, nearMiss: !ok && measures.every((m) => m.close), measures };
  }

  // The teams with at least one name listed in nicknames
  ourTeams() {
    const { nicknames = {} } = this.options() || {};
    const known = Object.keys(nicknames);
    return new Set([...this.players.values()].filter((p) => findKey(known, p.name) !== undefined).map((p) => p.team));
  }

  // Did the game report a shot on target or a save for this touch? Then it is not a ball handed back or a mere pass.
  wasShotOrSave(name, t) {
    return this.feed.some((f) => ["Shot", "Save", "EpicSave"].includes(f.type) && f.name === name && f.t >= t - 100 && f.t <= t + this.S.shotDelayMs);
  }

  // Fact for the evening recap (always counted, even when not commented)
  fact(type, name) {
    const p = this.players.get(name);
    if (p && this.ourTeams().has(p.team)) this.emit("fact", { type, player: name });
  }

  // With an opponent shot: "giveaway.shot". Without one, only for a ball sent far back: "giveaway.backward".
  announceGiveaway(t) {
    const g = this.giveaway;
    this.giveaway = null;
    if (g.shotAt) this.live("giveaway.shot", { giver: g.giver, opponent: g.shooter }, t, g.measures);
    else if (g.clean && g.backward.ok) this.live("giveaway.backward", { giver: g.giver, opponent: g.taker }, t, [...g.measures, ...g.backward.measures]);
  }

  countGiveaway(name) {
    this.giveaways.set(name, (this.giveaways.get(name) || 0) + 1);
    this.fact("giveaway", name);
  }

  // "our-team": only the teams with at least one name listed in nicknames are commented on
  isTarget(key, vars) {
    const { target = "our-team" } = this.options() || {};
    if (target === "everyone") return true;
    const ourTeams = this.ourTeams();
    if (!ourTeams.size) {
      if (!this.warnedNoTeam && this.players.size) {
        this.warnedNoTeam = true;
        this.emit("warning", "None of the nicknames is in this match: nobody will be commented on (add your in-game name to config.json → nicknames).");
      }
      return false;
    }
    const player = this.players.get(vars[TARGET[key.split(".")[0]]]);
    return !!player && ourTeams.has(player.team);
  }

  // What comes with each comment, detection or near miss: who is targeted, when, in which match
  context(key, vars, measures) {
    const target = vars[TARGET[key.split(".")[0]]];
    const p = this.players.get(target);
    return {
      key, vars, measures: measures || [], target, team: p ? p.team : null, ours: !!p && this.ourTeams().has(p.team),
      clock: { seconds: this.time, overtime: this.overtime }, match: { guid: this.guid, start: this.matchStart }, t: this.now,
    };
  }

  // Said out loud: only for a player of our team (see isTarget)
  emitComment(key, vars, live = false, measures) {
    if (!this.isTarget(key, vars)) return false;
    this.emit("comment", { ...this.context(key, vars, measures), live });
    return true;
  }

  // Detected but not said (other team, or not the priority on this goal): kept for the votes
  emitDetection(key, vars, live = false, measures) {
    this.emit("detection", { ...this.context(key, vars, measures), live });
  }

  // Said if it targets our team, otherwise only detected
  report(key, vars, measures) {
    if (!this.emitComment(key, vars, false, measures)) this.emitDetection(key, vars, false, measures);
  }

  emitNearMiss(key, vars, measures) {
    this.emit("nearMiss", this.context(key, vars, measures));
    return true;
  }

  // Live comment: never during a replay, and spaced out from the others. Returns "spoken",
  // "detected" (other team: kept for the votes, without using up the spacing) or false.
  live(key, vars, t, measures) {
    if (!this.inPlay) return false;
    if (!this.isTarget(key, vars)) {
      this.emitDetection(key, vars, true, measures);
      return "detected";
    }
    if (t - this.lastLiveT < this.S.liveCooldownMs) return false;
    this.lastLiveT = t;
    const type = key.split(".")[0];
    // Giveaways are counted when the ball is picked up, not here
    if (type !== "giveaway") this.fact(type, vars[TARGET[type]]);
    this.emitComment(key, vars, true, measures);
    return "spoken";
  }

  player(name, team) {
    let p = this.players.get(name);
    if (!p) {
      p = { name, team, stats: {}, idleMs: 0, zeroBoostMs: 0, lastTouchT: -Infinity, lastGhostT: -Infinity, lastBeggarT: -Infinity };
      this.players.set(name, p);
    }
    if (team !== undefined) p.team = team;
    return p;
  }

  addBlunder(name) {
    this.blunders.set(name, (this.blunders.get(name) || 0) + 1);
  }

  handle(event, d, t) {
    this.now = t;
    this.S = { ...DEFAULTS, ...((this.options() || {}).thresholds || {}) };
    if (d && d.MatchGuid && d.MatchGuid !== this.guid && event !== "PlayerLeft") this.resetMatch(d.MatchGuid, t);

    if (event === "MatchEnded" && typeof d.WinnerTeamNum === "number") {
      const ours = this.ourTeams();
      if (ours.size === 1) this.emit("result", { won: ours.has(d.WinnerTeamNum) });
    }

    switch (event) {
      case "RoundStarted":
        this.inPlay = true;
        this.roundStart = t;
        this.kickoffScores = [...this.scores];
        // New round: ghost and beggar start again from zero
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
          // Nobody plays until the next kickoff (ghost and beggar stop counting)
          this.inPlay = false;
        } else {
          this.onReplayGoal(d);
        }
        break;
      case "PodiumStart":
        this.giveawayOfTheMatch();
        break;
    }
  }

  onState(d, t) {
    const S = this.S;
    const game = d.Game || {};
    if (Array.isArray(game.Teams)) for (const team of game.Teams) this.scores[team.TeamNum] = team.Score || 0;
    // Joined mid-round (bot restarted): the current score stands for the kickoff score
    if (!this.kickoffScores && Array.isArray(game.Teams)) this.kickoffScores = [...this.scores];
    if (typeof game.TimeSeconds === "number") this.time = game.TimeSeconds;
    this.overtime = !!game.bOvertime;

    const perTeam = [0, 0];
    for (const s of d.Players || []) {
      const p = this.player(s.Name, s.TeamNum);
      // Ghost: the game rewarded an action (center, clear, shot, save…) → it was useful
      if (p.stats.Score !== undefined && (s.Score || 0) - (p.stats.Score || 0) >= S.ghostMinScoreGain) p.idleMs = 0;
      p.stats = s;
      perTeam[s.TeamNum]++;
    }
    if (perTeam[0] || perTeam[1]) this.teamSize = Math.max(perTeam[0], perTeam[1]);

    const dt = this.lastStateT === null ? 0 : Math.min(t - this.lastStateT, 2000);
    this.lastStateT = t;

    if (this.inPlay && !game.bReplay) {
      for (const s of d.Players || []) this.tickPlayer(this.player(s.Name), s, dt, t);
    }

    // Giveaway: opponent shot without a goal → said once the danger is over
    // (normally as soon as the giver's team gets the ball back, see onHit; here after 4 s at worst).
    // No shot within the window: said only for a ball sent far back, otherwise forgotten.
    const g = this.giveaway;
    if (g && ((g.shotAt && t - g.shotAt >= 4000) || (!g.shotAt && t - g.pickedUpAt > S.giveawayWindowMs))) {
      this.announceGiveaway(t);
    }

    // Near assist: no shot, or no save after the shot, in time → forgotten
    const na = this.nearAssist;
    if (na && ((!na.shotAt && t - na.pickedUpAt > S.nearAssistShotWindowMs) || (na.shotAt && t - na.shotAt > S.nearAssistSaveWindowMs))) this.nearAssist = null;

    if (this.pendingGoal && t - this.pendingGoal.t > S.topCornerWaitMs) this.pendingGoal = null;
  }

  tickPlayer(p, s, dt, t) {
    const S = this.S;
    if (!s.bHasCar) { p.zeroBoostMs = 0; return; }

    // Ghost
    p.idleMs += dt;
    const ghostKey = this.teamSize >= 3 ? "ghost3v3Ms" : this.teamSize === 2 ? "ghost2v2Ms" : null;
    // The minute between two ghosts only applies to the ones said out loud
    const vars = { player: p.name, seconds: Math.round(p.idleMs / 1000) };
    if (ghostKey && p.idleMs >= S[ghostKey] && t - p.lastGhostT >= S.ghostCooldownMs &&
        (t - this.lastGhostT >= S.ghostSpacingMs || !this.isTarget("ghost", vars))) {
      const measures = [{ ...condition("sans action utile", ghostKey, p.idleMs, "min", "ms"), threshold: S[ghostKey], ok: true }];
      const r = this.live("ghost", vars, t, measures);
      if (r) p.lastGhostT = t;
      if (r === "spoken") this.lastGhostT = t;
    }

    // Beggar
    const boost = s.Boost || 0;
    if (boost > 0 || s.bOnWall) { p.zeroBoostMs = 0; return; }
    if (t - this.roundStart < S.beggarAfterKickoffMs) return;
    p.zeroBoostMs += dt;
    const lastHit = this.hits[this.hits.length - 1];
    const underPressure = lastHit && distToOwnGoal(p.team, lastHit.loc.Y) <= THIRD;
    const key = underPressure ? "beggarUnderPressureMs" : "beggarMs";
    if (p.zeroBoostMs >= S[key] && t - p.lastTouchT >= S.beggarAfterTouchMs && t - p.lastBeggarT >= S.beggarCooldownMs) {
      const measures = [{ ...condition(underPressure ? "sans boost (balle dans son camp)" : "sans boost", key, p.zeroBoostMs, "min", "ms"), threshold: S[key], ok: true }];
      if (this.live("beggar", { player: p.name, seconds: Math.round(p.zeroBoostMs / 1000) }, t, measures)) p.lastBeggarT = t;
    }
  }

  onHit(d, t) {
    const S = this.S;
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

    // Ghost: the previous touch was kept by the team (pass, possession) → it was useful.
    // A ball pushed forward and lost counts only if the game rewarded it (see onState).
    for (const pp of prev.players) {
      if (hit.players.some((p) => p.team === pp.team)) this.player(pp.name).idleMs = 0;
    }

    // Giveaway: after the opponent's shot (or a clean pick-up of a ball sent far back), the giver's team
    // got the ball back → the action is over, it can be said
    // (not when the same ball can still become a near assist: the game reports the save just after the touch)
    const ga = this.giveaway;
    const naPending = this.nearAssist && this.nearAssist.shotAt && ga && this.nearAssist.giver === ga.giver;
    if (ga && !naPending && (ga.shotAt || (ga.clean && ga.backward.ok)) && hit.players.some((p) => p.team === ga.giverTeam)) this.announceGiveaway(t);

    // Giveaway: was the opponent's pick-up clean?
    const g = this.giveaway;
    if (g && !g.clean && g.pickupHit === prev) {
      if (onlyTeam(hit, g.takerTeam)) {
        g.clean = true;
        this.countGiveaway(g.giver);
      } else {
        this.giveaway = null;
      }
    }

    // Near assist to the opponent: a ball played in one's own half, not forward, picked up by an opponent
    if (prev.players.length === 1 && hit.players.length === 1 && prev.players[0].team !== hit.players[0].team) {
      const giver = prev.players[0], taker = hit.players[0];
      const ownGiver = distToOwnGoal(giver.team, prev.loc.Y);
      const wasShot = this.wasShotOrSave(giver.name, prev.t);
      const r = this.evaluate([
        condition("touche à sa propre ligne", "nearAssistMaxOwnGoalDistance", ownGiver, "max", "uu"),
        condition("balle envoyée vers l'avant", "nearAssistMaxForward", distToOwnGoal(giver.team, hit.loc.Y) - ownGiver, "max", "uu"),
        condition("délai avant la récupération", "nearAssistMinMs", t - prev.t, "min", "ms"),
      ]);
      if (!wasShot && r.ok) {
        this.nearAssist = { giver: giver.name, giverTeam: giver.team, takerTeam: taker.team, pickedUpAt: t, shotAt: null, shooter: null, measures: r.measures };
      }
    }

    // Giveaway: a new ball handed back?
    if (prev.players.length !== 1 || hit.players.length !== 1) return;
    const giver = prev.players[0], taker = hit.players[0];
    if (giver.team === taker.team) return;
    const dist = Math.hypot(prev.loc.X - hit.loc.X, prev.loc.Y - hit.loc.Y);
    const ownGiver = distToOwnGoal(giver.team, prev.loc.Y), ownTaker = distToOwnGoal(giver.team, hit.loc.Y);
    const wasShot = this.wasShotOrSave(giver.name, prev.t);
    if (wasShot || !(ownGiver - ownTaker >= S.giveawayMinBackward || ownTaker < GOAL_LINE)) return;
    const r = this.evaluate([
      condition("délai avant la récupération", "giveawayMinMs", t - prev.t, "min", "ms"),
      condition("distance entre les deux touches", "giveawayMinDistance", dist, "min", "uu"),
      condition("distance à sa propre ligne", "giveawayMinOwnGoalDistance", ownGiver, "min", "uu"),
    ]);
    if (r.ok) {
      const backward = this.evaluate([condition("recul vers son propre but", "giveawayBackwardNoShot", ownGiver - ownTaker, "min", "uu")]);
      this.giveaway = {
        giver: giver.name, giverTeam: giver.team, taker: taker.name, takerTeam: taker.team,
        pickedUpAt: t, pickupHit: hit, clean: false, shotAt: null, shooter: null, measures: r.measures, backward,
      };
    }
  }

  onFeed(d, t) {
    const S = this.S;
    const target = d.MainTarget || {};
    const f = { t, type: d.EventName, name: target.Name, team: target.TeamNum };
    this.feed.push(f);
    this.feed = this.feed.filter((x) => t - x.t <= 60000);

    if (["Shot", "Save", "EpicSave", "Savior", "Goal", "Assist", "Demolish"].includes(f.type) && f.name) this.player(f.name).idleMs = 0;

    const g = this.giveaway;
    if (f.type === "Shot" && g && f.team === g.takerTeam && !g.shotAt && t - g.pickedUpAt <= S.giveawayWindowMs) {
      g.shotAt = t;
      g.shooter = f.name;
    }

    // Near assist: the opponent shoots in time, then the giver's team saves it → said (instead of a plain giveaway)
    const na = this.nearAssist;
    if (na && f.type === "Shot" && f.team === na.takerTeam && !na.shotAt && t - na.pickedUpAt <= S.nearAssistShotWindowMs) {
      na.shotAt = t;
      na.shooter = f.name;
    } else if (na && na.shotAt && ["Save", "EpicSave"].includes(f.type) && f.team === na.giverTeam && t - na.shotAt <= S.nearAssistSaveWindowMs) {
      this.nearAssist = null;
      const measures = [...na.measures, { name: "tir adverse après la récupération", value: na.shotAt - na.pickedUpAt, unit: "ms" }, { name: "arrêt", value: f.type === "EpicSave" ? "miraculeux" : "simple" }];
      const sameBall = this.giveaway && this.giveaway.giver === na.giver;
      if (sameBall) this.giveaway = null;
      // Saved by the giver himself: it does not really count, nothing is said
      if (f.name === na.giver) return;
      if (!sameBall) this.countGiveaway(na.giver);
      this.live("giveaway.saved", { giver: na.giver, opponent: na.shooter, saver: f.name }, t, measures);
    }

    if (f.type === "MVP") this.checkMvp(f.name);
  }

  onGoal(d, t) {
    const S = this.S;
    const scorer = d.Scorer.Name, TS = d.Scorer.TeamNum, TD = 1 - TS;
    const hits = this.hits.filter((h) => h.t >= this.roundStart && h.t <= t);
    const found = {}; // key → { vars, measures }
    const nearMisses = {}; // family → { key, vars, measures }

    // Tap-in and goal steal: the scorer's sequence of touches and what comes before it
    const iS = findLastIndex(hits, (h) => has(h, scorer));
    if (iS >= 0) {
      const lastS = hits[iS];
      let iFirst = iS;
      while (iFirst > 0 && hits[iFirst - 1].players.length === 1 && hits[iFirst - 1].players[0].name === scorer) iFirst--;
      const scorerTouches = iS - iFirst + 1;
      const prev = hits[iFirst - 1];
      const mate = prev && onlyTeam(prev, TS) ? prev.players.find((p) => p.name !== scorer) : null;

      if (mate) {
        const vars = { scorer, passer: mate.name };
        const r = this.evaluate([
          condition("dernière touche à la ligne", "tapInMaxDistance", distToOpponentGoal(TS, lastS.loc.Y), "max", "uu"),
          condition("décalage sur le côté", "tapInMaxSideOffset", Math.abs(lastS.loc.X), "max", "uu"),
          condition("vitesse après la touche", "tapInMaxSpeed", lastS.post, "max", "kmh"),
          condition("délai depuis la passe", "tapInMaxGapMs", hits[iFirst].t - prev.t, "max", "ms"),
          condition("touches du buteur", "tapInMaxTouches", scorerTouches, "max", "n"),
        ]);
        if (r.ok) found.tapIn = { vars, measures: r.measures };
        else if (r.nearMiss) nearMisses.tapIn = { key: "tapIn", vars, measures: r.measures };

        const mateShot = this.feed.some((f) => f.type === "Shot" && f.name === mate.name && f.t >= prev.t && f.t <= prev.t + S.shotDelayMs);
        const onlyScorerAfter = hits.slice(iFirst).every((h) => h.players.every((p) => p.name === scorer));
        if (mateShot && onlyScorerAfter) {
          const farthest = Math.max(...hits.slice(iFirst, iS + 1).map((h) => distToOpponentGoal(TS, h.loc.Y)));
          const v = this.evaluate([condition("touches du voleur à la ligne", "stealMaxDistance", farthest, "max", "uu")]);
          if (v.ok) found.steal = { vars: { thief: scorer, victim: mate.name }, measures: v.measures };
        }
      }
    }

    // Missed save (and choke): slightly older touches are looked at too, for near misses
    const window = S.missedSaveMaxMs * (1 + S.nearMissMargin);
    const iD = findLastIndex(hits, (h) => t - h.t <= window && h.players.some((p) => p.team === TD));
    if (iD >= 0) {
      const defender = hits[iD].players.find((p) => p.team === TD).name;
      const iAtk = findLastIndex(hits.slice(0, iD), (h) => h.players.some((p) => p.team === TS));
      // The ball was going in if the attacker had a shot on target shortly before the defender's touch (the game
      // sometimes sends it before the touch itself), or touched it on the line (the game does not always send "Shot" that close)
      const onTarget = iAtk >= 0 && (distToOpponentGoal(TS, hits[iAtk].loc.Y) <= S.missedSaveOnLineDistance ||
        this.feed.some((f) => f.type === "Shot" && f.team === TS && f.t >= hits[iD].t - S.missedSaveShotWindowMs && f.t <= hits[iD].t));
      const key = onTarget ? "missedSave.escorted" : "missedSave.ownGoal";
      const vars = { defender, scorer };
      const r = this.evaluate([
        condition("touche avant le but", "missedSaveMaxMs", t - hits[iD].t, "max", "ms"),
        condition("touche à sa propre ligne", "missedSaveMaxDistance", distToOwnGoal(TD, hits[iD].loc.Y), "max", "uu"),
      ]);
      if (r.ok) {
        found[key] = { vars, measures: r.measures };
        const [s, o] = this.kickoffScores ? [this.kickoffScores[TS], this.kickoffScores[TD]] : [NaN, NaN];
        const c = this.evaluate([condition("temps restant", "chokeMaxSecondsLeft", this.time, "max", "n")]);
        if (!this.overtime && c.ok && (s === o - 1 || s === o)) found.choke = { vars, measures: [...c.measures, ...r.measures] };
      } else if (r.nearMiss) {
        nearMisses.missedSave = { key, vars, measures: r.measures };
      }
    }

    // Giveaway of the year (also when a near assist to the opponent ends in a goal)
    const na = this.nearAssist;
    this.nearAssist = null;
    if (na && na.takerTeam === TS && t - na.pickedUpAt <= S.nearAssistShotWindowMs + S.nearAssistSaveWindowMs &&
        !(this.giveaway && this.giveaway.takerTeam === TS && t - this.giveaway.pickedUpAt <= S.giveawayWindowMs)) {
      this.countGiveaway(na.giver);
      found["giveaway.goal"] = { vars: { giver: na.giver, opponent: scorer }, measures: na.measures };
    }
    const g = this.giveaway;
    if (g && g.takerTeam === TS && t - g.pickedUpAt <= S.giveawayWindowMs) {
      if (!g.clean) this.countGiveaway(g.giver);
      found["giveaway.goal"] = { vars: { giver: g.giver, opponent: scorer }, measures: g.measures };
      this.giveaway = null;
    }

    // Admin assist
    const assister = d.Assister && d.Assister.Name;
    if (assister) {
      const iA = findLastIndex(hits, (h) => has(h, assister));
      if (iA >= 0) {
        const after = hits.slice(iA + 1);
        const iFirstS = after.findIndex((h) => has(h, scorer));
        const touchesAfter = after.filter((h) => has(h, scorer)).length;
        const opponentBetween = after.slice(0, iFirstS < 0 ? after.length : iFirstS).some((h) => h.players.some((p) => p.team === TD));
        const ms = t - hits[iA].t;
        const vars = { passer: assister, scorer, seconds: Math.round(ms / 1000) };
        const r = this.evaluate([condition("délai entre la passe et le but", "adminAssistMinMs", ms, "min", "ms")]);
        const touches = this.evaluate([condition("touches du buteur après la passe", "adminAssistMinTouches", touchesAfter, "min", "n")]);
        // For information (being studied to cap the delay): delay up to the scorer's first touch, and how far the pass moved the ball forward
        const scorerHit = iFirstS >= 0 ? after[iFirstS] : null;
        const info = scorerHit ? [
          { name: "délai jusqu'à la touche du buteur", value: scorerHit.t - hits[iA].t, unit: "ms" },
          { name: "la passe avance la balle de", value: distToOpponentGoal(TS, hits[iA].loc.Y) - distToOpponentGoal(TS, scorerHit.loc.Y), unit: "uu" },
        ] : [];
        const measures = [...r.measures, ...touches.measures, { name: "adversaire touche entre les deux", value: opponentBetween ? "oui" : "non", ok: opponentBetween }, ...info];
        // A shot on target by the passer (saved, then scored on the rebound) is a real contribution: never admin
        if (!this.wasShotOrSave(assister, hits[iA].t)) {
          if (r.ok || touches.ok || opponentBetween) found.adminAssist = { vars, measures };
          else if (r.nearMiss) nearMisses.adminAssist = { key: "adminAssist", vars, measures };
        }
      }
    }

    // Blunders for the undeserved MVP
    if (found.tapIn) this.addBlunder(scorer);
    if (found.steal) this.addBlunder(scorer);
    if (found.adminAssist) this.addBlunder(assister);
    const missed = found["missedSave.escorted"] || found["missedSave.ownGoal"];
    if (missed) this.addBlunder(missed.vars.defender);

    // Everything counts for the recap (a choke is already a missed save, giveaways are counted separately)
    for (const [k, { vars }] of Object.entries(found)) {
      const type = k.split(".")[0];
      if (type !== "choke" && type !== "giveaway") this.fact(type, vars[TARGET[type]]);
    }

    // The spiciest situation among those targeting a player of our team is said; all the others are detections
    const key = GOAL_PRIORITY.find((k) => found[k] && this.isTarget(k, found[k].vars));
    if (key) this.emitComment(key, found[key].vars, false, found[key].measures);
    for (const k of GOAL_PRIORITY) {
      if (found[k] && k !== key) this.emitDetection(k, found[k].vars, false, found[k].measures);
    }
    if (key) {
      this.pendingGoal = null;
    } else {
      // Nothing spicy: wait for the 2nd GoalScored (replay) for the top corner
      this.pendingGoal = { t, scorer, speed: d.GoalSpeed || 0 };
    }

    // One near miss per goal at most (any team), from another family than the comment made
    const done = key ? key.split(".")[0] : null;
    for (const family of NEAR_MISS_PRIORITY) {
      const n = nearMisses[family];
      if (n && family !== done && this.emitNearMiss(n.key, n.vars, n.measures)) break;
    }
  }

  onReplayGoal(d) {
    const g = this.pendingGoal;
    if (!g || !d.ImpactLocation) return;
    this.pendingGoal = null;
    const { X, Z } = d.ImpactLocation;
    const vars = { scorer: g.scorer };
    const topCorner = this.evaluate([
      condition("hauteur dans la cage", "topCornerMinHeight", Z, "min", "uu"),
      condition("écart au centre de la cage", "topCornerMinSideOffset", Math.abs(X), "min", "uu"),
    ]);
    const ground = this.evaluate([
      condition("hauteur dans la cage", "groundRollerMaxHeight", Z, "max", "uu"),
      condition("vitesse du but", "groundRollerMaxSpeed", g.speed, "max", "kmh"),
    ]);
    if (topCorner.ok) {
      this.fact("finish", g.scorer);
      this.report("finish.topCorner", vars, topCorner.measures);
    } else if (ground.ok) {
      this.report("finish.groundRoller", { ...vars, speed: Math.round(g.speed) }, ground.measures);
    } else if (topCorner.nearMiss) {
      this.emitNearMiss("finish.topCorner", vars, topCorner.measures);
    }
  }

  checkMvp(name) {
    const S = this.S;
    const mvp = this.players.get(name);
    if (!mvp || this.mvpChecked) return;
    this.mvpChecked = true;
    const m = mvp.stats;
    const score = m.Score || 0;
    const ratio = score ? (100 * (m.Goals || 0) + 50 * (m.Assists || 0)) / score : 0;
    const mates = [...this.players.values()].filter((p) => p.team === mvp.team);
    const avgTouches = mates.reduce((a, p) => a + (p.stats.Touches || 0), 0) / mates.length;
    const blunders = this.blunders.get(mvp.name) || 0;
    const real = mates.filter((p) => p !== mvp).sort((a, b) => (b.stats.Touches || 0) - (a.stats.Touches || 0))[0];
    if (real && ratio >= S.mvpMinHighlightRatio && (m.Touches || 0) <= avgTouches && !(m.Saves > 0) && blunders >= 1) {
      const tier = blunders >= 3 ? "refund" : blunders === 2 ? "mocking" : "light";
      const measures = [
        { ...condition("part des points venant des buts et passes", "mvpMinHighlightRatio", ratio, "min", "n"), threshold: S.mvpMinHighlightRatio, ok: true },
        { name: "casseroles", value: blunders, ok: true },
      ];
      this.fact("mvp", mvp.name);
      this.report(`mvp.${tier}`, { mvp: mvp.name, realMvp: real.name }, measures);
    }
  }

  giveawayOfTheMatch() {
    if (this.giveawayOfTheMatchDone) return;
    this.giveawayOfTheMatchDone = true;
    const [best, count] = [...this.giveaways.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (best && count >= this.S.giveawayOfTheMatchMin) {
      const measures = [{ ...condition("ballons rendus", "giveawayOfTheMatchMin", count, "min", "n"), threshold: this.S.giveawayOfTheMatchMin, ok: true }];
      this.report("giveaway.ofTheMatch", { giver: best, count }, measures);
    }
  }
}

module.exports = { Detector, THRESHOLDS: DEFAULTS, TARGET };
