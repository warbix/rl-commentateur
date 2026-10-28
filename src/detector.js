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
  ghost3v3Ms: 45000, ghost2v2Ms: 40000, ghostMinAdvance: 1500, ghostCooldownMs: 120000, ghostSpacingMs: 60000,
  chokeMaxSecondsLeft: 10,
  giveawayMinMs: 1000, giveawayMinDistance: 1500, giveawayMinOwnGoalDistance: 2500, giveawayMinBackward: 800, giveawayWindowMs: 6000, giveawayOfTheMatchMin: 3,
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

  // Fact for the evening recap (always counted, even when not commented)
  fact(type, name) {
    const p = this.players.get(name);
    if (p && this.ourTeams().has(p.team)) this.emit("fact", { type, player: name });
  }

  announceGiveaway(t) {
    const g = this.giveaway;
    this.giveaway = null;
    this.live("giveaway.shot", { giver: g.giver, opponent: g.shooter }, t, g.measures);
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

  // What comes with each comment or near miss: who is targeted, when, in which match
  context(key, vars, measures) {
    return {
      key, vars, measures: measures || [], target: vars[TARGET[key.split(".")[0]]],
      clock: { seconds: this.time, overtime: this.overtime }, match: { guid: this.guid, start: this.matchStart }, t: this.now,
    };
  }

  emitComment(key, vars, live = false, measures) {
    if (!this.isTarget(key, vars)) return false;
    this.emit("comment", { ...this.context(key, vars, measures), live });
    return true;
  }

  emitNearMiss(key, vars, measures) {
    if (!this.isTarget(key, vars)) return false;
    this.emit("nearMiss", this.context(key, vars, measures));
    return true;
  }

  // Live comment: never during a replay, and spaced out from the others
  live(key, vars, t, measures) {
    if (!this.inPlay || t - this.lastLiveT < this.S.liveCooldownMs || !this.isTarget(key, vars)) return false;
    this.lastLiveT = t;
    const type = key.split(".")[0];
    // Giveaways are counted when the ball is picked up, not here
    if (type !== "giveaway") this.fact(type, vars[TARGET[type]]);
    return this.emitComment(key, vars, true, measures);
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
    // (normally as soon as the giver's team gets the ball back, see onHit; here after 4 s at worst)
    const g = this.giveaway;
    if (g && g.shotAt && t - g.shotAt >= 4000) {
      this.announceGiveaway(t);
    } else if (g && !g.shotAt && t - g.pickedUpAt > S.giveawayWindowMs) {
      this.giveaway = null;
    }

    if (this.pendingGoal && t - this.pendingGoal.t > S.topCornerWaitMs) this.pendingGoal = null;
  }

  tickPlayer(p, s, dt, t) {
    const S = this.S;
    if (!s.bHasCar) { p.zeroBoostMs = 0; return; }

    // Ghost
    p.idleMs += dt;
    const ghostKey = this.teamSize >= 3 ? "ghost3v3Ms" : this.teamSize === 2 ? "ghost2v2Ms" : null;
    if (ghostKey && p.idleMs >= S[ghostKey] && t - p.lastGhostT >= S.ghostCooldownMs && t - this.lastGhostT >= S.ghostSpacingMs) {
      const measures = [{ ...condition("sans action utile", ghostKey, p.idleMs, "min", "ms"), threshold: S[ghostKey], ok: true }];
      if (this.live("ghost", { player: p.name, seconds: Math.round(p.idleMs / 1000) }, t, measures)) p.lastGhostT = this.lastGhostT = t;
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

    // Ghost: was the previous touch useful?
    for (const pp of prev.players) {
      const keptByTeam = hit.players.some((p) => p.team === pp.team);
      const advanced = distToOpponentGoal(pp.team, prev.loc.Y) - distToOpponentGoal(pp.team, hit.loc.Y) >= S.ghostMinAdvance;
      if (keptByTeam || advanced) this.player(pp.name).idleMs = 0;
    }

    // Giveaway: after the opponent's shot, the giver's team got the ball back → the action is over, it can be said
    if (this.giveaway && this.giveaway.shotAt && hit.players.some((p) => p.team === this.giveaway.giverTeam)) this.announceGiveaway(t);

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

    // Giveaway: a new ball handed back?
    if (prev.players.length !== 1 || hit.players.length !== 1) return;
    const giver = prev.players[0], taker = hit.players[0];
    if (giver.team === taker.team) return;
    const dist = Math.hypot(prev.loc.X - hit.loc.X, prev.loc.Y - hit.loc.Y);
    const ownGiver = distToOwnGoal(giver.team, prev.loc.Y), ownTaker = distToOwnGoal(giver.team, hit.loc.Y);
    const wasShot = this.feed.some((f) => f.type === "Shot" && f.name === giver.name && f.t >= prev.t && f.t <= prev.t + S.shotDelayMs);
    if (wasShot || !(ownGiver - ownTaker >= S.giveawayMinBackward || ownTaker < GOAL_LINE)) return;
    const r = this.evaluate([
      condition("délai avant la récupération", "giveawayMinMs", t - prev.t, "min", "ms"),
      condition("distance entre les deux touches", "giveawayMinDistance", dist, "min", "uu"),
      condition("distance à sa propre ligne", "giveawayMinOwnGoalDistance", ownGiver, "min", "uu"),
    ]);
    if (r.ok) {
      this.giveaway = {
        giver: giver.name, giverTeam: giver.team, taker: taker.name, takerTeam: taker.team,
        pickedUpAt: t, pickupHit: hit, clean: false, shotAt: null, shooter: null, measures: r.measures,
      };
    }
  }

  onFeed(d, t) {
    const S = this.S;
    const target = d.MainTarget || {};
    const f = { t, type: d.EventName, name: target.Name, team: target.TeamNum };
    this.feed.push(f);
    this.feed = this.feed.filter((x) => t - x.t <= 60000);

    if (["Shot", "Save", "EpicSave", "Goal", "Assist"].includes(f.type) && f.name) this.player(f.name).idleMs = 0;

    const g = this.giveaway;
    if (f.type === "Shot" && g && f.team === g.takerTeam && !g.shotAt && t - g.pickedUpAt <= S.giveawayWindowMs) {
      g.shotAt = t;
      g.shooter = f.name;
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

    // Giveaway of the year
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
        const measures = [...r.measures, ...touches.measures, { name: "adversaire touche entre les deux", value: opponentBetween ? "oui" : "non", ok: opponentBetween }];
        if (r.ok || touches.ok || opponentBetween) found.adminAssist = { vars, measures };
        else if (r.nearMiss) nearMisses.adminAssist = { key: "adminAssist", vars, measures };
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

    // The spiciest situation among those targeting a player of our team
    const key = GOAL_PRIORITY.find((k) => found[k] && this.isTarget(k, found[k].vars));
    if (key) {
      this.pendingGoal = null;
      this.emitComment(key, found[key].vars, false, found[key].measures);
    } else {
      // Nothing spicy: wait for the 2nd GoalScored (replay) for the top corner
      this.pendingGoal = { t, scorer, speed: d.GoalSpeed || 0 };
    }

    // One near miss per goal at most, from another family than the comment made
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
      this.emitComment("finish.topCorner", vars, false, topCorner.measures);
    } else if (ground.ok) {
      this.emitComment("finish.groundRoller", { ...vars, speed: Math.round(g.speed) }, false, ground.measures);
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
      this.emitComment(`mvp.${tier}`, { mvp: mvp.name, realMvp: real.name }, false, measures);
    }
  }

  giveawayOfTheMatch() {
    if (this.giveawayOfTheMatchDone) return;
    this.giveawayOfTheMatchDone = true;
    const [best, count] = [...this.giveaways.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (best && count >= this.S.giveawayOfTheMatchMin) {
      const measures = [{ ...condition("ballons rendus", "giveawayOfTheMatchMin", count, "min", "n"), threshold: this.S.giveawayOfTheMatchMin, ok: true }];
      this.emitComment("giveaway.ofTheMatch", { giver: best, count }, false, measures);
    }
  }
}

module.exports = { Detector, THRESHOLDS: DEFAULTS, TARGET };
