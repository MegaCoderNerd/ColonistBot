// Recovered from content.js (lines 5491-5861)
import { coachedOpening } from "../analyzer/engine/opening";
import { buildHints, miniMapSvg, placementsFrom, robberTargets, type MapMark } from "../analyzer/advisor";
import { coachFromOpening, type CoachAdvice } from "../analyzer/engine/actions";
import { adviseRoad, listOpenEdges, roadToward } from "../analyzer/engine/roads";
import { bestEdge, nextRollText, positionWin, sevensText } from "../analyzer/engine/value";
import { bagAligned } from "../analyzer/engine/read";
import { planTurn, type TurnPlan } from "../analyzer/engine/decide";
import { portAccess } from "../analyzer/engine/ports";
import { decodeFrames, type DecodedFrame } from "../analyzer/decode";
import { stateDiffAdapter } from "../analyzer/adapters/stateDiff";
import { typedEventsAdapter } from "../analyzer/adapters/typedEvents";
import { pickPrimary } from "../analyzer/parse";
import { DEFAULT_VIEW } from "../analyzer/geometry";
import { contextFor, planMidgame, profileOf, roadDistance, type OpeningPick, type OpeningPlan } from "../analyzer/strategy";
import { COSTS, emptyHand, type PlayerHandView } from "../analyzer/tracker";
import { RESOURCES, type Resource, type ResourceHand } from "../analyzer/types";
import type { MapView, WsFrame } from "../shared/schema";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface HelperContext {
  meName?: string;
  logNames: string[];
  rolls: number;
  firstPlacedAt: (name: string) => number | undefined;
  loggedSettlements: (name: string) => number;
  mapView?: MapView;
  hook?: { sockets: number; frames: number };
}

export interface HelperView {
  title: string;
  lines: string[];
  sections?: Array<{ title: string; lines: string[] }>;
  coach?: CoachAdvice;
  advice?: { phase: "opening" | "midgame"; text: string; at?: string };
  mapSvg?: string;
  mapLegend?: boolean;
  mapPicks?: boolean;
  mapMarks?: boolean;
  mapRoads?: boolean;
  mapRoadLater?: boolean;
  choose?: string[];
  debug?: string;
}

const MAX_FRAMES = 4000;
const REPARSE_MS = 1000;
const STALE_AFTER_MS = 3000;
const CARD_RESOURCE = RESOURCES;

function isFullState(d: DecodedFrame): boolean {
  const v = d.value as { data?: { type?: number; payload?: { gameState?: unknown } } } | undefined;
  return v?.data?.type === 4 && Boolean(v.data.payload?.gameState);
}

function neededResources(v: PlayerHandView): Resource[] {
  let best: Resource[] | undefined;
  for (const key of ["city", "settlement", "dev"] as const) {
    const missing = RESOURCES.filter((r) => (COSTS[key][r] ?? 0) > v.hand[r]);
    if (missing.length && missing.length <= 2 && (!best || missing.length < best.length)) best = missing;
  }
  return best ?? [];
}

export function createHelper(friendlyBelow = 3) {
  let frames: DecodedFrame[] = [];
  let result: ReturnType<typeof pickPrimary> | undefined;
  let dirty = false;
  let sawFull = false;
  let lastParse = 0;
  let seen = 0;
  let placements = placementsFrom([]);
  let behindSince = 0;
  let planMemo: { key: string; plan: OpeningPlan } | undefined;
  let midMemo: { key: string; plan: TurnPlan } | undefined;

  function feed(frame: WsFrame) {
    if (frame.dir !== "in") return;
    let d: DecodedFrame | undefined;
    try {
      d = decodeFrames([frame]).decoded[0];
    } catch {
      return;
    }
    if (!d || d.value === undefined) return;
    seen++;
    if (isFullState(d)) {
      frames = [];
      sawFull = true;
    }
    frames.push({ ...d, frame: { ...frame, data: "" } });
    if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES);
    dirty = true;
  }

  function reparse(now: number) {
    if (!dirty || now - lastParse < REPARSE_MS) return;
    dirty = false;
    lastParse = now;
    try {
      result = pickPrimary(stateDiffAdapter.parse(frames), typedEventsAdapter.parse(frames));
      placements = placementsFrom(result.events);
    } catch {
      result = undefined;
    }
  }

  const norm = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const sameName = (a: string, b: string) => {
    const x = norm(a);
    const y = norm(b);
    return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
  };

  function identify(ctx: HelperContext): { id?: string; logName?: string; choose?: string[]; notes: string[]; confident?: boolean } {
    const players = result?.players ?? [];
    const notes: string[] = [];
    const logNames = ctx.logNames;
    if (result?.selfId && players.some((p) => p.id === result?.selfId)) {
      const self = players.find((p) => p.id === result?.selfId)!;
      const logName = logNames.find((n) => sameName(n, self.name)) ?? (logNames.includes("You") ? "You" : self.name);
      return { id: result.selfId, logName, notes, confident: true };
    }
    const fromName = ctx.meName ? logNames.find((n) => sameName(n, ctx.meName!)) : undefined;
    const logName = fromName ?? (logNames.includes("You") ? "You" : undefined);
    if (!logName) {
      notes.push(ctx.meName ? `Your username "${ctx.meName}" is not one of the players in the log (${logNames.join(", ") || "none yet"}).` : "Your username is not set.");
      return { choose: logNames.length >= 2 ? logNames : undefined, notes };
    }
    const opponents = logNames.filter((n) => n !== logName);
    const byName = logName === "You" ? undefined : players.find((p) => sameName(p.name, logName));
    if (byName) return { id: byName.id, logName, notes, confident: true };
    const notOpponent = players.filter((p) => !opponents.some((o) => sameName(p.name, o)));
    if (notOpponent.length === 1 && players.length >= 2) return { id: notOpponent[0].id, logName, notes, confident: false };
    const placedAt = ctx.firstPlacedAt(logName);
    if (placedAt !== undefined && result) {
      const firstBuild = new Map<string, number>();
      for (const e of result.events) if (e.type === "build" && !firstBuild.has(e.player)) firstBuild.set(e.player, e.t);
      const ranked = [...firstBuild].map(([id, t]) => ({ id, d: Math.abs(t - placedAt) })).sort((a, b) => a.d - b.d);
      if (ranked[0] && ranked[0].d < 4000 && (!ranked[1] || ranked[1].d - ranked[0].d > 1000)) return { id: ranked[0].id, logName, notes, confident: false };
    }
    notes.push(`Could not match "${logName}" to a network player (network names: ${players.map((p) => p.name).join(", ") || "none"}).`);
    return { logName, notes };
  }

  function debugReport(who: { id?: string; logName?: string }, ctx: HelperContext): string {
    const board = result?.board;
    return JSON.stringify({
      messages: seen,
      kept: frames.length,
      sawFullState: sawFull,
      self: result?.selfId,
      identifiedAs: who.id,
      logName: who.logName,
      players: result?.players,
      logNames: ctx.logNames,
      rolls: ctx.rolls,
      view: ctx.mapView,
      hook: ctx.hook ?? "page hook silent",
      hexes: board?.hexes.map((h) => `${h.x},${h.y}:${h.resource ?? "desert"}${h.number ?? ""}`),
      ports: board?.ports?.map((p) => `${p.at}:${p.kind}`),
      settlements: [...placements.settlements],
      cities: [...placements.cities],
      roads: [...placements.roads],
      loggedSettlements: who.logName ? ctx.loggedSettlements(who.logName) : undefined,
      selfCards: result?.selfCards
    });
  }

  function selfHand(now = Date.now()): { name?: string; hand: ResourceHand } | undefined {
    reparse(now);
    const cards = result?.selfCards;
    if (!cards) return undefined;
    const hand = emptyHand();
    for (const c of cards) {
      const r = CARD_RESOURCE[c - 1];
      if (r) hand[r]++;
      else return undefined;
    }
    const self = result?.players.find((p) => p.id === result?.selfId);
    return { name: self?.name, hand };
  }

  function handSizes(now = Date.now()): Array<{ name: string; size: number }> {
    reparse(now);
    const sizes = result?.handSizes ?? {};
    return (result?.players ?? []).flatMap((p) => (sizes[p.id] === undefined ? [] : [{ name: p.name, size: sizes[p.id] }]));
  }

  function view(views: PlayerHandView[], ctx: HelperContext, now = Date.now()): HelperView {
    reparse(now);
    const mapView = ctx.mapView ?? DEFAULT_VIEW;
    const title = "Hints (opt-in, estimates)";
    const players = result?.players ?? [];
    const diag = `Network data: ${result?.board ? `${result.board.hexes.length} hexes read` : "no board"}, ${players.length} players (${players.map((p) => p.name).join(", ") || "none"}), ${seen} messages${result?.selfId ? ", you identified by the game" : ""}.`;
    const who = identify(ctx);
    const debug = debugReport(who, ctx);
    if (!result?.board) {
      let why: string;
      if (sawFull) why = "A game state arrived but no board was in it.";
      else if (seen === 0 && !ctx.hook)
        why =
          "The extension's page hook is not running in this tab, so no game traffic can be read. Reload the Colonist tab. If this stays, your Firefox may be older than 128, or the add-on was loaded without reloading the tab.";
      else if (seen === 0 && ctx.hook && ctx.hook.sockets === 0)
        why = "The page hook is running but Colonist has not opened a game connection yet. Join or start a game; if you are already in one, reload the tab.";
      else if (seen === 0) why = `Colonist opened ${ctx.hook?.sockets ?? 0} connection(s) but no messages reached the helper. Reload the Colonist tab once.`;
      else why = "The board is only sent when the game loads, and this tab missed it. Reload the Colonist tab once (the game rejoins and the board is sent again).";
      return { title, lines: ["No placement hints yet.", why, diag], choose: who.choose, debug };
    }
    if (!who.id) {
      return {
        title,
        lines: ["Not advising until you pick who you are.", ...who.notes, "Hints need to know which player you are.", diag],
        choose: who.choose ?? (ctx.logNames.length >= 2 ? ctx.logNames : undefined),
        debug
      };
    }
    const mine = [...placements.settlements.values(), ...placements.cities.values()].filter((o) => o === who.id).length;
    const logged = who.logName ? ctx.loggedSettlements(who.logName) : 0;
    if (logged > mine) behindSince ||= now;
    else behindSince = 0;
    if (behindSince && now - behindSince > STALE_AFTER_MS) {
      return {
        title,
        lines: [
          `The board data is behind the game: the log shows ${logged} settlement${logged === 1 ? "" : "s"} by you, the network data only ${mine}. Hints are paused so they cannot mislead you.`,
          "Reload the Colonist tab once; the game rejoins and sends the board again."
        ],
        debug
      };
    }
    const robberNow = () => {
      const moves = result?.events.filter((e): e is Extract<(typeof result.events)[number], { type: "robberMove" }> => e.type === "robberMove") ?? [];
      return moves.at(-1)?.hex ?? result?.board?.robberStart;
    };
    const board = result.board;
    const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;
    const opponent = players.find((p) => p.id !== who.id);
    const oppView = opponent ? views.find((v) => sameName(v.name, opponent.name)) : undefined;
    const oppBuilt = placements.settlements.size + placements.cities.size - mine;
    const lines = [`Advising: ${nameOf(who.id)}.${who.confident ? "" : " This match is a guess; set your username in the popup if it is not you."}`];
    const sections: Array<{ title: string; lines: string[] }> = [];
    let coach: CoachAdvice | undefined;
    const marks: MapMark[] = [];
    let svg: string | undefined;
    let picks: OpeningPick[] = [];
    const opening = ctx.rolls === 0 && (mine < 2 || oppBuilt < 2);
    if (opening) {
      const myTurn = result.turnPlayer ? result.turnPlayer === who.id : undefined;
      const key = JSON.stringify([[...placements.settlements], [...placements.cities], who.id, myTurn]);
      if (planMemo?.key !== key) planMemo = { key, plan: coachedOpening(board, placements, who.id, 3, myTurn) };
      const plan = planMemo.plan;
      const boardCtx = contextFor(board);
      const ports = portAccess(
        boardCtx,
        roadDistance(boardCtx, placements, (o) => o === who.id),
        profileOf(boardCtx, placements, (o) => o === who.id)
      );
      picks = plan.picks;
      lines.push(plan.note);
      const follow = picks[0]?.followUp;
      const placing = picks[0]?.at;
      const secondSpot = plan.mode === "pair" && mine === 0 ? follow?.at : undefined;
      const closeSecond = follow && placing && mine === 0 && plan.mode !== "pair" ? roadToward(board, placements, who.id, follow.at, placing) : undefined;
      const road = placing
        ? adviseRoad(board, placements, who.id, {
            from: placing,
            onlyFrom: true,
            toward: closeSecond && closeSecond.dist <= 2 ? follow!.at : undefined,
            maxDist: 2,
            myRoadLength: result.snapshot?.players.find((p) => p.id === who.id)?.roadLength,
            oppRoadLength: result.snapshot?.players.find((p) => p.id !== who.id)?.roadLength,
            iHold: result.snapshot?.players.find((p) => p.id === who.id)?.hasLongestRoad
          })
        : undefined;
      const secondRoad = secondSpot ? adviseRoad(board, placements, who.id, { from: secondSpot, onlyFrom: true, maxDist: 2 }) : undefined;
      const rolls = result.events.flatMap((e) => (e.type === "roll" ? [{ total: e.total, d1: e.d1, d2: e.d2, player: e.player }] : []));
      const aligned = bagAligned(result.snapshot?.completedTurns, rolls.length);
      const edgePick = placing ? bestEdge(board, placements, who.id, { from: placing, onlyFrom: true, maxDist: 2, rolls, aligned }) : undefined;
      let setupRoad = road;
      if (!setupRoad && edgePick) setupRoad = { edge: edgePick.edge, toward: edgePick.toward, reason: `Point this road toward your second spot. ${edgePick.reason}` };
      if (!setupRoad && placing) {
        const open = listOpenEdges(board, placements, who.id, placing, true)[0];
        if (open) setupRoad = { edge: open.edge, toward: open.to, reason: "This road leaves the settlement you are placing." };
      }
      const myView = views.find((v) => v.name === who.logName);
      const handKnown = Boolean(myView && (myView.exact || (myView.unknown === 0 && myView.total > 0)));
      const hand = handKnown ? myView?.hand : undefined;
      const projected = { settlements: new Map(placements.settlements), cities: new Map(placements.cities), roads: new Map(placements.roads) };
      if (placing && !projected.settlements.has(placing) && !projected.cities.has(placing)) projected.settlements.set(placing, who.id);
      const oppId = opponent?.id ?? "opp";
      for (const w of plan.oppWants.slice(0, 2)) {
        if (w.at !== placing && !projected.settlements.has(w.at) && !projected.cities.has(w.at)) projected.settlements.set(w.at, oppId);
      }
      const meSnap = result.snapshot?.players.find((p) => p.id === who.id);
      const oppSnap = result.snapshot?.players.find((p) => p.id !== who.id);
      const pct = positionWin(board, projected, who.id, {
        hand,
        myVp: meSnap?.vp || Math.max(2, mine + (placing ? 1 : 0)),
        hisVp: oppSnap?.vp || 2,
        rollCount: rolls.length
      });
      const next = nextRollText(rolls, aligned);
      const held = hand ? RESOURCES.reduce((s, r) => s + hand[r], 0) : meSnap?.handSize ?? 0;
      const limit = meSnap?.discardLimit ?? 9;
      const seven =
        held > limit
          ? `You hold ${held} cards. Drop ${Math.floor(held / 2)} if a 7 comes before you can spend them. ${sevensText(rolls, aligned, who.id)}`
          : `${sevensText(rolls, aligned, who.id)}${held >= limit - 2 && held > 0 ? ` You hold ${held}, close to the discard of ${limit}.` : ""}`;
      coach = coachFromOpening(plan, ports[0] && ports[0].value >= 0.5 ? ports[0].text : undefined, { first: setupRoad?.reason, second: secondRoad?.reason });
      coach = {
        ...coach,
        race: `About ${pct}% from here. ${next}`,
        tips: [
          { title: "Win", why: `About ${pct}% from here. This model's share under one shared build policy. Not a promise.` },
          { title: "Next roll", why: next },
          { title: "A 7", why: seven },
          ...coach.tips
        ]
      };
      lines.push(...(picks.length ? picks.map((c, i) => `${i + 1}. ${c.reason}`) : plan.mode === "waiting" ? [] : ["No legal spot found."]));
      if (follow) {
        lines.push(plan.mode === "pair" && mine === 0 ? `Second settlement: ${follow.reason}` : `+ Then: ${follow.reason}`);
        marks.push({ at: follow.at, label: "+", kind: "follow" });
      }
      if (plan.oppWants.length) {
        sections.push({ title: "He is likely to want", lines: plan.oppWants.map((w, i) => `H${i + 1}. ${w.reason}`) });
        plan.oppWants.slice(0, 2).forEach((w, i) => marks.push({ at: w.at, label: `H${i + 1}`, kind: "his" }));
      }
      if (mine >= 1) {
        const weak = planMidgame(board, placements, who.id).weaknesses;
        if (weak.length) sections.push({ title: "Weak points", lines: weak });
      }
      lines.push("W wood, B brick, S sheep, G wheat, O ore.");
      if (setupRoad) {
        sections.unshift({ title: plan.mode === "pair" && secondRoad ? "First road" : "Next road", lines: [setupRoad.reason] });
        marks.push({ at: setupRoad.edge, label: secondRoad ? "1" : "R", kind: "road" });
      }
      if (secondRoad) {
        sections.splice(setupRoad ? 1 : 0, 0, { title: "Second road", lines: [secondRoad.reason] });
        marks.push({ at: secondRoad.edge, label: "2", kind: "road" });
      }
      if (edgePick?.follow && setupRoad && setupRoad.edge === edgePick.edge && edgePick.follow !== setupRoad.edge && !secondRoad) {
        marks.push({ at: edgePick.follow, label: "", kind: "road", later: true });
      }
    } else {
      const myView = views.find((v) => v.name === who.logName);
      if (myView) lines.push(...buildHints(myView));
      const plan = planMidgame(board, placements, who.id);
      const needs = oppView ? neededResources(oppView) : [];
      const handKnown = Boolean(myView && (myView.exact || (myView.unknown === 0 && myView.total > 0)));
      const oppCounted = oppView && oppView.total > 0 ? { hand: oppView.hand, unknown: oppView.unknown } : undefined;
      const finger = result.snapshot?.players
        .map((p) =>
          [
            p.id,
            p.vp,
            p.roadLength,
            p.hasLongestRoad,
            p.knights,
            p.army,
            p.devCards?.join(","),
            p.handSize,
            p.devsInHand,
            p.ratios.lumber,
            p.ratios.brick,
            p.ratios.wool,
            p.ratios.grain,
            p.ratios.ore
          ].join(":")
        )
        .join("|");
      const rolls = result.events.flatMap((e) => (e.type === "roll" ? [e.total] : []));
      const midKey = JSON.stringify([
        [...placements.settlements],
        [...placements.cities],
        [...placements.roads],
        who.id,
        handKnown ? myView?.hand : undefined,
        result.snapshot?.robberHex,
        result.snapshot?.dice?.thrown,
        result.snapshot?.completedTurns,
        rolls,
        finger,
        needs,
        oppCounted
      ]);
      if (midMemo?.key !== midKey) {
        midMemo = {
          key: midKey,
          plan: planTurn({
            board,
            placements,
            me: who.id,
            hand: handKnown ? myView?.hand : undefined,
            handKnown,
            snapshot: result.snapshot,
            events: result.events,
            oppNeeds: needs,
            oppHand: oppCounted?.hand,
            oppUnknown: oppCounted?.unknown
          })
        };
      }
      const turn = midMemo.plan;
      coach = {
        phase: "midgame",
        headline: turn.headline,
        why: turn.why,
        race: turn.race,
        tips: turn.tips,
        next: turn.settle ? [turn.settle.reason] : [],
        at: turn.settle?.mark ? turn.settle.at : undefined
      };
      const grow: string[] = [];
      if (/city/i.test(turn.headline) && plan.upgrade) grow.push(plan.upgrade);
      const aimed = turn.settle?.mark ? turn.settle.at : undefined;
      if (turn.settle) grow.push(`${turn.settle.mark ? "This turn: " : "Next settlement: "}${turn.settle.reason}`);
      if (turn.alt && turn.alt.at !== aimed) grow.push(`Also: ${turn.alt.reason}`);
      if (aimed) picks = [{ at: aimed, score: 0, pips: 0, resources: [], numbers: [], reason: turn.settle?.reason ?? "Settle here." }];
      if (plan.upgrade && !grow.includes(plan.upgrade) && !/city/i.test(turn.headline)) grow.push(plan.upgrade);
      if (grow.length) sections.push({ title: "Where to settle", lines: grow });
      const block: string[] = [];
      if (oppView) {
        const can = (["city", "settlement", "dev"] as const).filter((k) => oppView.afford[k] === "yes");
        if (can.length) block.push(`${oppView.name} can pay for a ${can.join(" or ")} right now.`);
      }
      block.push(...plan.oppWants.map((w, i) => `H${i + 1}. ${w.reason}`));
      plan.oppWants.forEach((w, i) => marks.push({ at: w.at, label: `H${i + 1}`, kind: "his" }));
      if (block.length) sections.push({ title: "What he is heading for", lines: block });
      const robber = robberTargets(board, placements, who.id, robberNow(), friendlyBelow, 2, needs);
      if (robber.length) {
        sections.push({
          title: "If you move the robber",
          lines: [
            "Friendly robber applies.",
            ...robber.map((r) => `${r.number}${r.resource ? ` ${r.resource}` : ""} hits ${r.targets.map(nameOf).join("/")}${r.note ? ` (${r.note})` : ""}`)
          ]
        });
      }
      if (plan.weaknesses.length) sections.push({ title: "Weak points", lines: plan.weaknesses });
      if (turn.road) {
        const pair = Boolean(turn.road2);
        sections.unshift({ title: pair ? "First road" : "Next road", lines: [turn.road.reason] });
        marks.push({ at: turn.road.edge, label: pair ? "1" : "R", kind: "road" });
      }
      if (turn.road2) {
        sections.splice(1, 0, { title: "Second road", lines: [turn.road2.reason] });
        marks.push({ at: turn.road2.edge, label: "2", kind: "road" });
      }
      if (turn.roadLater && !turn.road2) marks.push({ at: turn.roadLater.edge, label: "", kind: "road", later: true });
      if (!lines.length && !sections.length) lines.push("Nothing to suggest right now.");
    }
    svg = miniMapSvg(board, placements, picks, who.id, mapView, robberNow(), marks);
    const advice = coach ? { phase: coach.phase, text: coach.headline, at: coach.at } : undefined;
    return {
      title,
      lines,
      sections,
      coach,
      advice,
      mapSvg: svg,
      mapLegend: true,
      mapPicks: picks.length > 0,
      mapMarks: marks.some((m) => m.kind !== "road"),
      mapRoads: marks.some((m) => m.kind === "road" && !m.later),
      mapRoadLater: marks.some((m) => m.kind === "road" && m.later),
      debug
    };
  }

  return {
    feed,
    view,
    selfHand,
    handSizes,
    reset() {
      frames = [];
      sawFull = false;
      result = undefined;
      dirty = false;
      seen = 0;
      behindSince = 0;
      planMemo = undefined;
      midMemo = undefined;
      placements = placementsFrom([]);
    }
  };
}
