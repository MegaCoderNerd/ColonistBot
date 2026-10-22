// Recovered from content.js (lines 2613-2852)
import { edgePoints, pointKey } from "../geometry";
import { contextFor, isLegal, occupiedMap, portReportFor, profileOf, scoreSpot, type BoardContext } from "../strategy";
import type { Board, GameEvent, Placements } from "../types";
import { resourcesImprovedByHarbor } from "./ports";
import { bestEdge } from "./value";

const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const edgeCache = new WeakMap<Board, Map<string, { at: string; a: string; b: string }>>();

export function edgesOf(ctx: BoardContext): Map<string, { at: string; a: string; b: string }> {
  const hit = edgeCache.get(ctx.board);
  if (hit) return hit;
  const land = new Set(ctx.board.hexes.map((h) => `${h.x},${h.y}`));
  const coords = [...land];
  for (const key of land) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of [
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
      [1, 0],
      [1, -1]
    ]) {
      const k = `${x + dx},${y + dy}`;
      if (!land.has(k)) coords.push(k);
    }
  }
  const out = new Map<string, { at: string; a: string; b: string }>();
  for (const key of coords) {
    const [x, y] = key.split(",").map(Number);
    for (const z of [0, 1, 2]) {
      const at = `${x},${y},${z}`;
      const pts = edgePoints(at);
      if (!pts) continue;
      const a = ctx.keyToAt.get(pointKey(pts[0]));
      const b = ctx.keyToAt.get(pointKey(pts[1]));
      if (!a || !b || a === b) continue;
      const id = pair(a, b);
      const prev = out.get(id);
      if (!prev || (land.has(key) && !land.has(prev.at.split(",").slice(0, 2).join(",")))) out.set(id, { at, a, b });
    }
  }
  edgeCache.set(ctx.board, out);
  return out;
}

export function endsOf(ctx: BoardContext, at: string): [string, string] | undefined {
  const pts = edgePoints(at);
  if (!pts) return undefined;
  const a = ctx.keyToAt.get(pointKey(pts[0]));
  const b = ctx.keyToAt.get(pointKey(pts[1]));
  return a && b ? [a, b] : undefined;
}

export function roadToward(board: Board, placements: Placements, me: string, target: string, from?: string): { edge: string; dist: number } | undefined {
  return buildNet(board, placements, me, from)?.firstStep(target);
}

export function buildNet(board: Board, placements: Placements, me: string, from?: string, onlyFrom = false) {
  const ctx = contextFor(board);
  const edges = edgesOf(ctx);
  const built = occupiedMap(placements);
  const occupied = new Set<string>();
  for (const [at] of placements.roads) {
    const ends = endsOf(ctx, at);
    if (ends) occupied.add(pair(ends[0], ends[1]));
  }
  const mine = new Set<string>();
  for (const [at, owner] of built) if (owner === me) mine.add(at);
  if (from) mine.add(from);
  const graph = new Map<string, Set<string>>();
  for (const [at, owner] of placements.roads) {
    if (owner !== me) continue;
    const ends = endsOf(ctx, at);
    if (!ends) continue;
    mine.add(ends[0]);
    mine.add(ends[1]);
    for (const [a, b] of [
      [ends[0], ends[1]],
      [ends[1], ends[0]]
    ]) {
      const next = graph.get(a) ?? new Set<string>();
      next.add(b);
      graph.set(a, next);
    }
  }
  if (!mine.size) return undefined;
  const blocked = new Set([...built].filter(([, owner]) => owner !== me).map(([at]) => at));
  const adj = new Map<string, Array<{ to: string; edge: string }>>();
  for (const edge of edges.values()) {
    if (occupied.has(pair(edge.a, edge.b))) continue;
    for (const [a, b] of [
      [edge.a, edge.b],
      [edge.b, edge.a]
    ]) {
      const list = adj.get(a) ?? [];
      list.push({ to: b, edge: edge.at });
      adj.set(a, list);
    }
  }
  const firstStep = (target: string): { edge: string; dist: number } | undefined => {
    if (mine.has(target) || blocked.has(target)) return undefined;
    const roots = onlyFrom && from ? [from] : [...mine];
    const seen = new Set(roots);
    const queue = roots.filter((n) => !blocked.has(n)).map((n) => ({ n, dist: 0, edge: "" }));
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const next of adj.get(cur.n) ?? []) {
        if (seen.has(next.to) || blocked.has(next.to)) continue;
        seen.add(next.to);
        const edge = cur.edge || next.edge;
        if (next.to === target) return { edge, dist: cur.dist + 1 };
        queue.push({ n: next.to, dist: cur.dist + 1, edge });
      }
    }
    return undefined;
  };
  return { firstStep, mine, graph, length: longestRoad(graph, blocked).len, blocked, adj };
}

export function listOpenEdges(
  board: Board,
  placements: Placements,
  me: string,
  from?: string,
  onlyFrom = false
): Array<{ edge: string; from: string; to: string }> {
  const net = buildNet(board, placements, me, from, onlyFrom);
  if (!net) return [];
  const roots = onlyFrom && from ? [from] : [...net.mine];
  const out: Array<{ edge: string; from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (net.blocked.has(root)) continue;
    for (const next of net.adj.get(root) ?? []) {
      if (net.graph.get(root)?.has(next.to) || seen.has(next.edge)) continue;
      seen.add(next.edge);
      out.push({ edge: next.edge, from: root, to: next.to });
    }
  }
  return out;
}

export function networkLength(board: Board, placements: Placements, me: string): number {
  return buildNet(board, placements, me)?.length ?? 0;
}

export function longestExtensions(board: Board, placements: Placements, me: string): Array<{ edge: string; to: string }> {
  const net = buildNet(board, placements, me);
  if (!net) return [];
  const chain = longestRoad(net.graph, net.blocked);
  const out: Array<{ edge: string; to: string }> = [];
  const seen = new Set<string>();
  for (const end of chain.ends) {
    if (!net.mine.has(end) || net.blocked.has(end)) continue;
    for (const next of net.adj.get(end) ?? []) {
      if (net.graph.get(end)?.has(next.to) || seen.has(next.edge)) continue;
      seen.add(next.edge);
      out.push({ edge: next.edge, to: next.to });
    }
  }
  return out;
}

export function adviseRoad(
  board: Board,
  placements: Placements,
  me: string,
  opts: {
    from?: string;
    onlyFrom?: boolean;
    toward?: string;
    maxDist?: number;
    myRoadLength?: number;
    oppRoadLength?: number;
    iHold?: boolean;
  } = {}
): { edge: string; toward?: string; reason: string } | undefined {
  const ctx = contextFor(board);
  const built = occupiedMap(placements);
  const net = buildNet(board, placements, me, opts.from, opts.onlyFrom);
  if (!net) return undefined;
  const { firstStep, mine, graph, blocked, adj } = net;
  const forced = opts.toward ? firstStep(opts.toward) : undefined;
  const forcedOk = Boolean(forced && (opts.maxDist === undefined || forced.dist <= opts.maxDist));
  if (!forcedOk) {
    const pick = bestEdge(board, placements, me, { from: opts.from, onlyFrom: opts.onlyFrom, maxDist: opts.maxDist ?? 2 });
    if (pick) {
      const setup = Boolean(opts.onlyFrom || opts.from);
      return { edge: pick.edge, toward: pick.toward, reason: setup ? `Point this road toward your second spot. ${pick.reason}` : pick.reason };
    }
  }
  const spotText = (at: string) => {
    const c = ctx.byAt.get(at);
    if (!c) return "the spot";
    const nums = c.numbers.join("/");
    return `${c.pips} pips${nums ? ` (${nums})` : ""}`;
  };
  const left = (d: number) => (d === 1 ? "This road reaches it." : `It is the first of ${d} roads.`);
  let best: { step: { edge: string; dist: number }; score: number; reason: string; toward: string } | undefined;
  const consider = (toward: string, scoreOf: (s: { edge: string; dist: number }) => number, reason: (s: { edge: string; dist: number }) => string) => {
    const step = firstStep(toward);
    if (!step || (opts.maxDist !== undefined && step.dist > opts.maxDist)) return;
    const score = scoreOf(step);
    if (!best || score > best.score) best = { step, score, reason: reason(step), toward };
  };
  if (opts.toward) {
    const target = opts.toward;
    consider(
      target,
      () => 40,
      (step) => `Point this road toward your second spot, ${spotText(target)}. ${left(step.dist)}`
    );
  }
  const taken = new Set(built.keys());
  if (opts.from) taken.add(opts.from);
  const own = profileOf(ctx, placements, (o) => o === me);
  const ownedRates = portReportFor(ctx, placements, me).rates.rates;
  for (const corner of ctx.corners) {
    if (!isLegal(ctx, corner.at, taken)) continue;
    const spot = scoreSpot(ctx, corner, own, taken, ownedRates);
    const portNote =
      corner.port && resourcesImprovedByHarbor(ownedRates, corner.port).length > 0
        ? corner.port === "any"
          ? " on a 3:1 port"
          : ` on the 2:1 ${corner.port} port`
        : "";
    consider(
      corner.at,
      (step) => spot.value - step.dist * 1.2,
      (step) => `Build the highlighted road toward ${spotText(corner.at)}${portNote}. ${left(step.dist)}`
    );
  }
  const chain = longestRoad(graph, blocked);
  const mineLen = Math.max(opts.myRoadLength ?? 0, chain.len);
  const oppLen = opts.oppRoadLength ?? 0;
  const takesTrophy = !opts.iHold && mineLen + 1 >= 5 && mineLen + 1 > oppLen;
  if (takesTrophy) {
    for (const end of chain.ends) {
      if (blocked.has(end)) continue;
      for (const next of adj.get(end) ?? []) {
        if (graph.get(end)?.has(next.to)) continue;
        if (!mine.has(end)) continue;
        const score = 11;
        if (!best || score > best.score) {
          best = {
            step: { edge: next.edge, dist: 1 },
            score,
            toward: next.to,
            reason: `Build the highlighted road. It makes your longest road ${mineLen + 1}${oppLen ? `, ahead of his ${oppLen}` : ""}, which is 2 VP.`
          };
        }
      }
    }
  }
  if (!best) return undefined;
  const touch = endsOf(ctx, best.step.edge);
  const canStart = (c: string) => mine.has(c) && !blocked.has(c);
  if (!touch || (!canStart(touch[0]) && !canStart(touch[1]))) return undefined;
  return { edge: best.step.edge, toward: best.toward, reason: best.reason };
}

export function longestRoad(graph: Map<string, Set<string>>, blocked?: Set<string>): { len: number; ends: string[] } {
  const nodes = [...graph.keys()];
  if (!nodes.length) return { len: 0, ends: [] };
  let bestLen = 0;
  const ends = new Set<string>();
  const usedEdges = new Set<string>();
  const walk = (start: string, n: string, d: number) => {
    if (d > bestLen) {
      bestLen = d;
      ends.clear();
    }
    if (d === bestLen) {
      if (!blocked?.has(start)) ends.add(start);
      if (!blocked?.has(n)) ends.add(n);
    }
    if (d > 0 && blocked?.has(n)) return;
    for (const next of graph.get(n) ?? []) {
      const edge = pair(n, next);
      if (usedEdges.has(edge)) continue;
      usedEdges.add(edge);
      walk(start, next, d + 1);
      usedEdges.delete(edge);
    }
  };
  for (const start of nodes) {
    walk(start, start, 0);
  }
  return { len: bestLen, ends: [...ends] };
}

export type SetupStage = "first_settlement" | "first_road" | "second_settlement" | "second_road" | "setup_done";

export interface OpeningRoadGuidance {
  stage: SetupStage;
  anchor?: string;
  /** The one road that can be placed now. */
  current?: { edge: string; reason: string };
  /** Direction after this placement. Never a setup action. */
  later?: { edge: string; reason: string };
  explanation?: string;
  toward?: string;
}

function ownBuildings(placements: Placements, me: string): string[] {
  const at: string[] = [];
  for (const [corner, owner] of placements.settlements) if (owner === me) at.push(corner);
  for (const [corner, owner] of placements.cities) if (owner === me && !at.includes(corner)) at.push(corner);
  return at;
}

function roadTouches(board: Board, placements: Placements, me: string, corner: string): boolean {
  const ctx = contextFor(board);
  for (const edge of edgesOf(ctx).values()) {
    if (edge.a !== corner && edge.b !== corner) continue;
    if (placements.roads.get(edge.at) === me) return true;
  }
  return false;
}

function edgeTouches(board: Board, edge: string, corner: string): boolean {
  const ends = endsOf(contextFor(board), edge);
  return Boolean(ends && (ends[0] === corner || ends[1] === corner));
}

function stageFromEvents(events: readonly GameEvent[], me: string): { stage: SetupStage; anchor?: string } | undefined {
  const builds = events.filter((event): event is Extract<GameEvent, { type: "build" }> => event.type === "build" && event.player === me && event.setup);
  if (!builds.length) return undefined;
  const settlements = builds.filter((event) => event.piece === "settlement");
  const roads = builds.filter((event) => event.piece === "road");
  const last = builds[builds.length - 1];
  if (last.piece === "settlement") {
    return { stage: settlements.length <= 1 ? "first_road" : "second_road", anchor: last.at };
  }
  if (settlements.length >= 2 && roads.length >= settlements.length) return { stage: "setup_done" };
  if (settlements.length === 0) return { stage: "first_settlement" };
  if (settlements.length === 1) return { stage: "second_settlement" };
  return { stage: "setup_done" };
}

function stageFromPlacements(board: Board, placements: Placements, me: string): { stage: SetupStage; anchor?: string } {
  const buildings = ownBuildings(placements, me);
  const roadCount = [...placements.roads.values()].filter((owner) => owner === me).length;
  const unattached = buildings.filter((at) => !roadTouches(board, placements, me, at));
  if (buildings.length === 0) return { stage: "first_settlement" };
  if (buildings.length === 1 && unattached.length === 1) return { stage: "first_road", anchor: unattached[0] };
  if (buildings.length === 1) return { stage: "second_settlement" };
  if (roadCount < 2 && unattached.length === 1) return { stage: "second_road", anchor: unattached[0] };
  if (roadCount < 2) return { stage: "second_road" };
  return { stage: "setup_done" };
}

export function guideOpeningRoads(
  board: Board,
  placements: Placements,
  me: string,
  opts: {
    events?: readonly GameEvent[];
    previewFrom?: string;
    toward?: string;
    myTurn?: boolean;
    rolls?: Array<{ total: number; d1?: number; d2?: number; player?: string }>;
    aligned?: boolean;
    myRoadLength?: number;
    oppRoadLength?: number;
    iHold?: boolean;
  } = {}
): OpeningRoadGuidance {
  const fromEvents = opts.events ? stageFromEvents(opts.events, me) : undefined;
  const located = fromEvents ?? stageFromPlacements(board, placements, me);
  const stage = located.stage;
  const anchor = located.anchor;
  if (opts.myTurn === false) {
    const waiting =
      stage === "first_road" || stage === "second_road"
        ? "Waiting. This setup road is not your placement."
        : stage === "setup_done"
          ? "Both setup roads are already placed. There is no setup road left to play."
          : "Waiting. No road of yours is legal until you place the next settlement.";
    return { stage, explanation: waiting };
  }
  if (stage === "setup_done") {
    return { stage, explanation: "Both setup roads are already placed. There is no setup road left to play." };
  }
  if (stage === "first_road" || stage === "second_road") {
    const owner = anchor ? placements.settlements.get(anchor) ?? placements.cities.get(anchor) : undefined;
    const onBoard = Boolean(anchor && owner === me);
    if (!anchor || !onBoard) {
      return {
        stage,
        explanation: "The setup road has to leave the settlement you just placed. That settlement is not identified, so no road is marked."
      };
    }
    const legal = listOpenEdges(board, placements, me, anchor, true).filter((edge) => edgeTouches(board, edge.edge, anchor));
    const ranked = bestEdge(board, placements, me, { from: anchor, onlyFrom: true, maxDist: 2, rolls: opts.rolls, aligned: opts.aligned });
    const rankedOk = ranked && legal.some((edge) => edge.edge === ranked.edge) ? ranked : undefined;
    const chosen = rankedOk ?? legal[0];
    if (!chosen) return { stage, anchor, explanation: "No open road leaves the settlement you just placed." };
    const rule =
      stage === "first_road"
        ? "First setup road. It has to leave the settlement you just placed."
        : "Second setup road. It has to leave the second settlement. Extending the first road is not legal during setup.";
    const later =
      rankedOk?.follow && rankedOk.follow !== chosen.edge && !legal.some((edge) => edge.edge === rankedOk.follow)
        ? {
            edge: rankedOk.follow,
            reason:
              "Not this placement. The next road toward that settlement comes after setup. Setup allows only the one road touching the settlement you just placed."
          }
        : undefined;
    return {
      stage,
      anchor,
      toward: rankedOk?.toward,
      current: { edge: chosen.edge, reason: `${rule} ${rankedOk?.reason ?? "This is an open edge off that settlement."}` },
      later
    };
  }
  const explanation =
    stage === "first_settlement"
      ? "No road is legal yet. Place the first settlement first. Its setup road then has to leave that settlement."
      : "No road is legal yet. Place the second settlement first. Its setup road has to leave that settlement, not extend the first road.";
  const previewOwner = opts.previewFrom ? placements.settlements.get(opts.previewFrom) ?? placements.cities.get(opts.previewFrom) : undefined;
  const preview =
    opts.previewFrom && (!previewOwner || previewOwner === me)
      ? adviseRoad(board, placements, me, {
          from: opts.previewFrom,
          onlyFrom: true,
          toward: opts.toward,
          maxDist: 2,
          myRoadLength: opts.myRoadLength,
          oppRoadLength: opts.oppRoadLength,
          iHold: opts.iHold
        })
      : undefined;
  const later =
    preview && opts.previewFrom && edgeTouches(board, preview.edge, opts.previewFrom)
      ? {
          edge: preview.edge,
          reason: `Not this placement. After the settlement is placed, this is the setup road to consider. ${preview.reason}`
        }
      : undefined;
  return { stage, explanation, later };
}

export function displayRoadAdvice(args: {
  opening: boolean;
  guidance: OpeningRoadGuidance;
  turnRoad?: { edge: string; reason: string };
  history?: string;
  emptyReason?: string;
}): {
  current?: { edge: string; title: string; reason: string };
  later?: { edge: string; reason: string };
  sections: Array<{ title: string; lines: string[] }>;
} {
  const sections: Array<{ title: string; lines: string[] }> = [];
  if (args.history) sections.push({ title: "Setup context", lines: [args.history] });
  if (!args.opening) {
    if (args.turnRoad) return { current: { edge: args.turnRoad.edge, title: "Next road", reason: args.turnRoad.reason }, sections };
    sections.unshift({ title: "Road", lines: [args.emptyReason ?? "No road to place on this turn."] });
    return { sections };
  }
  if (args.guidance.later) sections.push({ title: "Not this placement", lines: [args.guidance.later.reason] });
  if (args.guidance.current) {
    const title = args.guidance.stage === "second_road" ? "Second setup road" : "First setup road";
    return {
      current: { edge: args.guidance.current.edge, title, reason: args.guidance.current.reason },
      later: args.guidance.later,
      sections
    };
  }
  sections.unshift({ title: "Road", lines: [args.guidance.explanation ?? "No road is legal on this placement."] });
  return { later: args.guidance.later, sections };
}
