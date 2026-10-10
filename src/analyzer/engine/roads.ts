// Recovered from content.js (lines 2613-2852)
import { edgePoints, pointKey } from "../geometry";
import { contextFor, isLegal, occupiedMap, profileOf, scoreSpot, type BoardContext } from "../strategy";
import type { Board, Placements } from "../types";
import { portAccess } from "./ports";
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
    for (const next of net.adj.get(root) ?? []) {
      if (net.blocked.has(next.to) || net.graph.get(root)?.has(next.to) || seen.has(next.edge)) continue;
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
      if (net.blocked.has(next.to) || net.graph.get(end)?.has(next.to) || seen.has(next.edge)) continue;
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
  for (const corner of ctx.corners) {
    if (!isLegal(ctx, corner.at, taken)) continue;
    const spot = scoreSpot(ctx, corner, own, taken);
    const portNote = corner.port ? (corner.port === "any" ? " on a 3:1 port" : ` on the 2:1 ${corner.port} port`) : "";
    consider(
      corner.at,
      (step) => spot.value - step.dist * 1.2,
      (step) => `Build the highlighted road toward ${spotText(corner.at)}${portNote}. ${left(step.dist)}`
    );
  }
  const dist = new Map<string, number>();
  for (const at of mine) dist.set(at, 0);
  const seen = new Set(mine);
  const queue = [...mine].filter((n) => !blocked.has(n));
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    for (const next of adj.get(at) ?? []) {
      if (seen.has(next.to) || blocked.has(next.to)) continue;
      seen.add(next.to);
      dist.set(next.to, (dist.get(at) ?? 0) + 1);
      queue.push(next.to);
    }
  }
  const ports = portAccess(ctx, dist, own);
  if (ports[0] && ports[0].roads > 0) {
    const port = ports[0];
    consider(
      port.at,
      (step) => port.value * 5 - step.dist * 0.4,
      (step) => `Build the highlighted road toward the ${port.text}. ${left(step.dist)}`
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
        if (blocked.has(next.to) || graph.get(end)?.has(next.to)) continue;
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
  if (!touch || (!mine.has(touch[0]) && !mine.has(touch[1]))) return undefined;
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
