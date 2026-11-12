// Detects the situations described in REGLES.md.
// Receives game events through handle(name, data, t) and emits:
//   "comment"  { key, vars, live, target, measures, clock, match, t } → situation to comment on
//   "nearMiss" { key, vars, target, measures, clock, match, t }       → missed by a little, to be voted on
//   "fact"     { type, player }  → for the evening recap (counted even when not commented)
//   "result"   { won }           → end of a match where our team is known
// The time t is passed in (not read with Date.now()) so that a recording can be replayed.
// Thresholds come from config.json → thresholds (re-read on every event), otherwise from the defaults below.

const EventEmitter = require("events");
const { squadName } = require("./names");
const { ruleEnabled } = require("./rules");

const GOAL_LINE = 5120;

// Default thresholds ⚙️ (see REGLES.md). Distances in game units (1 = 1 cm), speeds in km/h, durations in ms.
const DEFAULTS = {
  // Tap-in: a ball pushed in from close, touched low, slow, and not placed high in the goal (no pass needed)
  tapInMaxDistance: 900, tapInMaxSideOffset: 1200, tapInMaxSpeed: 50, tapInMaxTouchHeight: 250, tapInMaxImpactHeight: 300,
  shotDelayMs: 300,
  stealMaxDistance: 1500,
  // Own goal: the last touch before the goal is the conceding team's, and the ball was not already going in
  ownGoalMaxMs: 3000, ownGoalOnLineDistance: 1000, ownGoalShotWindowMs: 3000,
  topCornerMinHeight: 450, topCornerMinSideOffset: 550,
  adminAssistMinMs: 4000, adminAssistMinTouches: 3,
  mvpMinHighlightRatio: 0.7,
  // Ghost: play time without touching the ball. Measured on the recorded matches, these thresholds give
  // about one ghost every match and a half per team (one touches the ball less at three than at two)
  ghost3v3Ms: 40000, ghost2v2Ms: 30000, ghostCooldownMs: 120000, ghostSpacingMs: 60000,
  giveawayMinMs: 1000, giveawayMinDistance: 1500, giveawayMinOwnGoalDistance: 2500, giveawayMinBackward: 800, giveawayWindowMs: 6000, giveawayOfTheMatchMin: 3,
  // A ball sent at least this far back towards one's own goal is commented on even without an opponent shot
  giveawayBackwardNoShot: 1500,
  // Kickoff: a ball lost in the first seconds after the kickoff is not a giveaway (nor a near assist)
  giveawayKickoffMs: 5000,
  // Near assist to the opponent: a touch in one's own half that does not go forward, picked up by an opponent
  // (not a 50/50), who shoots, and the shot is saved by the giver's team
  nearAssistMaxOwnGoalDistance: 5120, nearAssistMaxForward: 500, nearAssistMinMs: 1000,
  nearAssistShotWindowMs: 4000, nearAssistSaveWindowMs: 2500,
  // Save for the opponent: a teammate is the first to touch a shot on target, close to the opponent goal, and no goal follows
  teamBlockMaxDistance: 1200, teamBlockMaxMs: 2500, teamBlockNoGoalMs: 3000,
  // Near goal: a shot hits the frame (crossbar, post, top corner) and does not go in. The shot must be recent and
  // real (not a ball rolling onto the post); the frame zone is told by the impact point (crossbar above, posts on the side).
  nearGoalShotMaxMs: 2500, nearGoalMinSpeed: 30, nearGoalNoGoalMs: 2000, nearGoalCrossbarMinHeight: 550, nearGoalPostMinSideOffset: 750,
  liveCooldownMs: 15000,
  topCornerWaitMs: 20000,
  // Near miss: every failed measure misses its threshold by less than 30 %
  nearMissMargin: 0.3,
};

// Priority when several rules fire on the same goal
// (the tap-in is decided during the replay, once the impact point in the goal is known: it comes after these)
const GOAL_PRIORITY = ["steal", "giveaway.goal", "ownGoal", "adminAssist"];
// Near misses that can be offered on a goal, by priority
const NEAR_MISS_PRIORITY = ["ownGoal", "tapIn", "adminAssist"];

// The player each situation targets (the one being mocked)
const TARGET = {
  tapIn: "scorer", steal: "thief", ownGoal: "defender", finish: "scorer",
  adminAssist: "passer", mvp: "mvp", ghost: "player", giveaway: "giver", teamBlock: "blocker", nearGoal: "shooter",
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
  // options() returns { target, players, rules, thresholds } (re-read from config.json every time)
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
    this.blunders = new Map(); // player → count, for the undeserved MVP
    this.giveaways = new Map();
    this.giveaway = null;
    this.nearAssist = null;
    this.lastShot = null; // last shot on target, until the next touch
    this.teamBlock = null;
    this.nearGoal = null;
    this.lastFrameT = -Infinity;
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

  // The teams with at least one player of the squad (config.json → players)
  ourTeams() {
    const { players = {} } = this.options() || {};
    return new Set([...this.players.values()].filter((p) => squadName(players, p.name) !== undefined).map((p) => p.team));
  }

  // Did the game report a shot on target or a save for this touch? Then it is not a ball handed back or a mere pass.
  wasShotOrSave(name, t) {
    return this.feed.some((f) => ["Shot", "Save", "EpicSave"].includes(f.type) && f.name === name && f.t >= t - 100 && f.t <= t + this.S.shotDelayMs);
  }

  // Switched off in config.json → rules: not detected at all
  enabled(key) {
    return ruleEnabled((this.options() || {}).rules, key);
  }

  // Fact for the evening recap (always counted, even when not commented). key: the situation, the recap counts its family.
  fact(key, name) {
    if (!this.enabled(key)) return;
    const p = this.players.get(name);
    if (p && this.ourTeams().has(p.team)) this.emit("fact", { type: key.split(".")[0], player: name });
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

  // "our-team": only the teams with at least one player of the squad are commented on
  isTarget(key, vars) {
    const { target = "our-team" } = this.options() || {};
    if (target === "everyone") return true;
    const ourTeams = this.ourTeams();
    if (!ourTeams.size) {
      if (!this.warnedNoTeam && this.players.size) {
        this.warnedNoTeam = true;
        this.emit("warning", "Nobody from the squad is in this match: nobody will be commented on (add your in-game name to config.json → players).");
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
    const ourTeams = this.ourTeams();
    // The players mentioned who are not on our team: the voice says "l'adversaire" instead of their name
    const opponents = Object.values(vars).filter((v) => {
      const pl = typeof v === "string" && this.players.get(v);
      return pl && ourTeams.size && !ourTeams.has(pl.team);
    });
    return {
      key, vars, opponents, measures: measures || [], target, team: p ? p.team : null, ours: !!p && ourTeams.has(p.team),
      clock: { seconds: this.time, overtime: this.overtime }, match: { guid: this.guid, start: this.matchStart }, t: this.now,
    };
  }

  // Said out loud: only for a player of our team (see isTarget)
  emitComment(key, vars, live = false, measures) {
    if (!this.enabled(key) || !this.isTarget(key, vars)) return false;
    this.emit("comment", { ...this.context(key, vars, measures), live });
    return true;
  }

  // Detected but not said (other team, or not the priority on this goal): kept for the votes
  emitDetection(key, vars, live = false, measures) {
    if (!this.enabled(key)) return;
    this.emit("detection", { ...this.context(key, vars, measures), live });
  }

  // Said if it targets our team, otherwise only detected
  report(key, vars, measures) {
    if (!this.emitComment(key, vars, false, measures)) this.emitDetection(key, vars, false, measures);
  }

  emitNearMiss(key, vars, measures) {
    if (!this.enabled(key)) return false;
    this.emit("nearMiss", this.context(key, vars, measures));
    return true;
  }

  // Live comment: never during a replay, and spaced out from the others. Returns "spoken",
  // "detected" (other team: kept for the votes, without using up the spacing) or false.
  live(key, vars, t, measures) {
    if (!this.inPlay || !this.enabled(key)) return false;
    if (!this.isTarget(key, vars)) {
      this.emitDetection(key, vars, true, measures);
      return "detected";
    }
    if (t - this.lastLiveT < this.S.liveCooldownMs) return false;
    this.lastLiveT = t;
    const type = key.split(".")[0];
    // Giveaways are counted when the ball is picked up, not here
    if (type !== "giveaway") this.fact(key, vars[TARGET[type]]);
    this.emitComment(key, vars, true, measures);
    return "spoken";
  }

  player(name, team) {
    let p = this.players.get(name);
    if (!p) {
      p = { name, team, stats: {}, idleMs: 0, lastTouchT: -Infinity, lastGhostT: -Infinity };
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
        // New round: the ghost starts again from zero
        for (const p of this.players.values()) p.idleMs = 0;
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
      case "CrossbarHit":
        this.onFrame(d, t);
        break;
      case "GoalScored":
        if (d.Scorer && d.Scorer.Name) {
          this.onGoal(d, t);
          // Nobody plays until the next kickoff (the ghost stops counting)
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
    // (normally as soon as the giver's team gets the ball back, see onHit; here after 4 s at worst).
    // No shot within the window: said only for a ball sent far back, otherwise forgotten.
    const g = this.giveaway;
    if (g && ((g.shotAt && t - g.shotAt >= 4000) || (!g.shotAt && t - g.pickedUpAt > S.giveawayWindowMs))) {
      this.announceGiveaway(t);
    }

    // Near goal: still no goal a moment after hitting the frame → said
    const ng = this.nearGoal;
    if (ng && t - ng.t >= S.nearGoalNoGoalMs) {
      this.nearGoal = null;
      this.addBlunder(ng.shooter);
      this.live(ng.key, { shooter: ng.shooter }, t, ng.measures);
    }

    // Save for the opponent: still no goal a moment after the teammate's touch → said (or offered as a near miss)
    const tb = this.teamBlock;
    if (tb && t - tb.t >= S.teamBlockNoGoalMs) {
      this.teamBlock = null;
      const r = this.evaluate([condition("touche du coéquipier à la ligne adverse", "teamBlockMaxDistance", tb.distance, "max", "uu")]);
      const measures = [...r.measures, { name: "délai après le tir", value: tb.t - tb.shotAt, unit: "ms" }];
      const vars = { blocker: tb.blocker, shooter: tb.shooter };
      if (r.ok) { this.addBlunder(tb.blocker); this.live("teamBlock", vars, t, measures); }
      else if (r.nearMiss) this.emitNearMiss("teamBlock", vars, measures);
    }

    // Near assist: no shot, or no save after the shot, in time → forgotten
    const na = this.nearAssist;
    if (na && ((!na.shotAt && t - na.pickedUpAt > S.nearAssistShotWindowMs) || (na.shotAt && t - na.shotAt > S.nearAssistSaveWindowMs))) this.nearAssist = null;

    if (this.pendingGoal && t - this.pendingGoal.t > S.topCornerWaitMs) this.pendingGoal = null;
  }

  // Ghost: play time without touching the ball (reset by each touch and each kickoff, paused between a goal and the kickoff)
  tickPlayer(p, s, dt, t) {
    const S = this.S;
    if (!s.bHasCar) return;
    p.idleMs += dt;
    const ghostKey = this.teamSize >= 3 ? "ghost3v3Ms" : this.teamSize === 2 ? "ghost2v2Ms" : null;
    // The minute between two ghosts only applies to the ones said out loud
    const vars = { player: p.name, seconds: Math.round(p.idleMs / 1000) };
    if (ghostKey && p.idleMs >= S[ghostKey] && t - p.lastGhostT >= S.ghostCooldownMs &&
        (t - this.lastGhostT >= S.ghostSpacingMs || !this.isTarget("ghost", vars))) {
      const measures = [{ ...condition("sans toucher la balle", ghostKey, p.idleMs, "min", "ms"), threshold: S[ghostKey], ok: true }];
      const r = this.live("ghost", vars, t, measures);
      if (r) p.lastGhostT = t;
      if (r === "spoken") this.lastGhostT = t;
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
    // Ghost: any touch of the ball counts
    for (const p of hit.players) { const pl = this.player(p.name, p.team); pl.lastTouchT = t; pl.idleMs = 0; }

    if (!prev) return;

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

    // Save for the opponent: the first touch after a shot on target is a teammate's (not the shooter's, no opponent)
    const ls = this.lastShot;
    if (ls) {
      this.lastShot = null;
      if (t - ls.t <= S.teamBlockMaxMs && onlyTeam(hit, ls.team) && !has(hit, ls.shooter)) {
        this.teamBlock = { blocker: hit.players[0].name, shooter: ls.shooter, shotAt: ls.t, t, distance: distToOpponentGoal(ls.team, hit.loc.Y) };
      }
    }

    // Near assist to the opponent: a ball played in one's own half, not forward, picked up by an opponent
    if (prev.players.length === 1 && hit.players.length === 1 && prev.players[0].team !== hit.players[0].team) {
      const giver = prev.players[0], taker = hit.players[0];
      const ownGiver = distToOwnGoal(giver.team, prev.loc.Y);
      const wasShot = this.wasShotOrSave(giver.name, prev.t) || prev.t - this.roundStart < S.giveawayKickoffMs;
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
    const wasShot = this.wasShotOrSave(giver.name, prev.t) || prev.t - this.roundStart < S.giveawayKickoffMs;
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

    const g = this.giveaway;
    if (f.type === "Shot" && g && f.team === g.takerTeam && !g.shotAt && t - g.pickedUpAt <= S.giveawayWindowMs) {
      g.shotAt = t;
      g.shooter = f.name;
    }

    if (f.type === "Shot") {
      if (this.teamBlock && f.name === this.teamBlock.blocker && t - this.teamBlock.t <= S.shotDelayMs) this.teamBlock = null;
      else this.lastShot = { shooter: f.name, team: f.team, t };
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
    this.teamBlock = null;
    this.nearGoal = null;
    this.lastShot = null;
    const found = {}; // key → { vars, measures }
    const nearMisses = {}; // family → { key, vars, measures }

    // Tap-in: the scorer's last touch is close to the line, low and slow (a defender touching it after
    // without stopping it changes nothing). The impact point in the goal is only known during the replay:
    // decided then (see onReplayGoal).
    let tapIn = null;
    const iS = findLastIndex(hits, (h) => has(h, scorer));
    if (iS >= 0) {
      const lastS = hits[iS];
      const r = this.evaluate([
        condition("dernière touche à la ligne", "tapInMaxDistance", distToOpponentGoal(TS, lastS.loc.Y), "max", "uu"),
        condition("décalage sur le côté", "tapInMaxSideOffset", Math.abs(lastS.loc.X), "max", "uu"),
        condition("hauteur de la touche", "tapInMaxTouchHeight", lastS.loc.Z, "max", "uu"),
        condition("vitesse après la touche", "tapInMaxSpeed", lastS.post, "max", "kmh"),
      ]);
      if (r.ok) tapIn = { vars: { scorer }, measures: r.measures };
      else if (r.nearMiss) nearMisses.tapIn = { key: "tapIn", vars: { scorer }, measures: r.measures };
    }

    // Goal steal: the scorer's sequence of touches and what comes before it
    if (iS >= 0) {
      let iFirst = iS;
      while (iFirst > 0 && hits[iFirst - 1].players.length === 1 && hits[iFirst - 1].players[0].name === scorer) iFirst--;
      const prev = hits[iFirst - 1];
      const mate = prev && onlyTeam(prev, TS) ? prev.players.find((p) => p.name !== scorer) : null;

      if (mate) {

        const mateShot = this.feed.some((f) => f.type === "Shot" && f.name === mate.name && f.t >= prev.t && f.t <= prev.t + S.shotDelayMs);
        const onlyScorerAfter = hits.slice(iFirst).every((h) => h.players.every((p) => p.name === scorer));
        if (mateShot && onlyScorerAfter) {
          const farthest = Math.max(...hits.slice(iFirst, iS + 1).map((h) => distToOpponentGoal(TS, h.loc.Y)));
          const v = this.evaluate([condition("touches du voleur à la ligne", "stealMaxDistance", farthest, "max", "uu")]);
          if (v.ok) found.steal = { vars: { thief: scorer, victim: mate.name }, measures: v.measures };
        }
      }
    }

    // Own goal: the last touch before the goal is a player of the team that concedes, and the ball was not
    // going in before it (no shot on target by the attackers just before, no attacker touch on the line)
    const last = hits[hits.length - 1];
    if (last && onlyTeam(last, TD)) {
      const defender = last.players[0].name;
      const iAtk = findLastIndex(hits, (h) => h.players.some((p) => p.team === TS));
      // The game sometimes sends "Shot" before the touch itself, and not always for a touch on the line
      const onTarget = iAtk >= 0 && (distToOpponentGoal(TS, hits[iAtk].loc.Y) <= S.ownGoalOnLineDistance ||
        this.feed.some((f) => f.type === "Shot" && f.team === TS && f.t >= last.t - S.ownGoalShotWindowMs && f.t <= last.t));
      const vars = { defender };
      const r = this.evaluate([condition("dernière touche avant le but", "ownGoalMaxMs", t - last.t, "max", "ms")]);
      const measures = [...r.measures, { name: "touche à sa propre ligne", value: distToOwnGoal(TD, last.loc.Y), unit: "uu" }];
      if (!onTarget && r.ok) found.ownGoal = { vars, measures };
      else if (!onTarget && r.nearMiss) nearMisses.ownGoal = { key: "ownGoal", vars, measures };
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
    if (found.steal) this.addBlunder(scorer);
    if (found.adminAssist) this.addBlunder(assister);
    if (found.ownGoal) this.addBlunder(found.ownGoal.vars.defender);

    // Everything counts for the recap (giveaways are counted separately)
    for (const [k, { vars }] of Object.entries(found)) {
      const type = k.split(".")[0];
      if (type !== "giveaway" && this.enabled(k)) this.fact(k, vars[TARGET[type]]);
    }

    // The spiciest situation among those targeting a player of our team is said; all the others are detections
    const key = GOAL_PRIORITY.find((k) => found[k] && this.enabled(k) && this.isTarget(k, found[k].vars));
    if (key) this.emitComment(key, found[key].vars, false, found[key].measures);
    for (const k of GOAL_PRIORITY) {
      if (found[k] && k !== key) this.emitDetection(k, found[k].vars, false, found[k].measures);
    }
    // Wait for the 2nd GoalScored (replay) and its impact point: tap-in, or top corner if nothing was said
    this.pendingGoal = { t, scorer, speed: d.GoalSpeed || 0, tapIn, said: !!key };

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

    // Tap-in: not placed high in the goal (under the crossbar or in the top corner, it is a real finish)
    if (g.tapIn) {
      const low = this.evaluate([condition("hauteur dans la cage", "tapInMaxImpactHeight", Z, "max", "uu")]);
      const measures = [...g.tapIn.measures, ...low.measures];
      if (low.ok) {
        this.addBlunder(g.scorer);
        this.fact("tapIn", g.scorer);
        if (g.said) this.emitDetection("tapIn", vars, false, measures);
        else this.report("tapIn", vars, measures);
        return;
      }
      if (!g.said && low.nearMiss) this.emitNearMiss("tapIn", vars, measures);
    }
    if (g.said) return;

    const topCorner = this.evaluate([
      condition("hauteur dans la cage", "topCornerMinHeight", Z, "min", "uu"),
      condition("écart au centre de la cage", "topCornerMinSideOffset", Math.abs(X), "min", "uu"),
    ]);
    if (topCorner.ok) {
      this.fact("finish.topCorner", g.scorer);
      this.report("finish.topCorner", vars, topCorner.measures);
    } else if (topCorner.nearMiss) {
      this.emitNearMiss("finish.topCorner", vars, topCorner.measures);
    }
  }

  // A shot on the frame (the game sends CrossbarHit for the crossbar, the posts and the top corners)
  onFrame(d, t) {
    const S = this.S;
    // The game sends it twice, and again during the goal replay
    if (!this.inPlay || t - this.lastFrameT < 300) return;
    this.lastFrameT = t;
    const shooter = d.BallLastTouch && d.BallLastTouch.Player && d.BallLastTouch.Player.Name;
    const loc = d.BallLocation || {};
    if (!shooter) return;
    const lastHit = this.hits[this.hits.length - 1];
    if (!lastHit || !has(lastHit, shooter)) return;
    // Only the opponent's frame: a ball sent onto one's own post is not a near goal
    const team = lastHit.players.find((p) => p.name === shooter).team;
    if (distToOpponentGoal(team, loc.Y || 0) > GOAL_LINE) return;
    const r = this.evaluate([
      condition("délai depuis le tir", "nearGoalShotMaxMs", t - lastHit.t, "max", "ms"),
      condition("vitesse de la balle", "nearGoalMinSpeed", d.BallSpeed || 0, "min", "kmh"),
    ]);
    if (!r.ok) return;
    const high = loc.Z >= S.nearGoalCrossbarMinHeight, side = Math.abs(loc.X) >= S.nearGoalPostMinSideOffset;
    const key = high && side ? "nearGoal.topCorner" : high ? "nearGoal.crossbar" : "nearGoal.post";
    const measures = [...r.measures, { name: "hauteur de l'impact", value: loc.Z, unit: "uu" }, { name: "écart au centre", value: Math.abs(loc.X), unit: "uu" }];
    this.nearGoal = { key, shooter, t, measures };
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
