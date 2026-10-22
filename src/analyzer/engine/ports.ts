// Recovered from content.js (lines 1197-1252)
import { edgePoints, pointKey } from "../geometry";
import { RESOURCES, type Placements, type PortKind, type Resource, type ResourceHand } from "../types";
import type { BoardContext } from "../strategy";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface NearbyPort {
  at: string;
  kind: PortKind;
  dist: number;
}

export interface PortAccessItem {
  at: string;
  kind: PortKind;
  roads: number;
  value: number;
  contested: boolean;
  text: string;
}

export function portsNear(ctx: BoardContext, at: string, max = 2): NearbyPort[] {
  const out: NearbyPort[] = [];
  const seen = new Set<string>([at]);
  let ring = [at];
  for (let dist = 0; dist <= max; dist++) {
    const next: string[] = [];
    for (const id of ring) {
      const port = ctx.byAt.get(id)?.port;
      if (port) out.push({ at: id, kind: port, dist });
      if (dist === max) continue;
      for (const n of ctx.nbrs.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    ring = next;
  }
  return out;
}

const LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };

function productionOf(kind: PortKind, own: ResourceHand, here: ResourceHand): number {
  if (kind === "any") return RESOURCES.reduce((s, r) => s + own[r] + here[r], 0);
  return own[kind] + here[kind];
}

export function portWorth(kind: PortKind, own: ResourceHand, here: ResourceHand, roads: number, oppRoads?: number): number {
  if (roads > 4) return 0;
  const decay = [1, 0.7, 0.4, 0.2, 0.1][roads] ?? 0;
  const produced = productionOf(kind, own, here);
  const kinds = new Set([...RESOURCES.filter((r) => own[r] > 0), ...RESOURCES.filter((r) => here[r] > 0)]);
  let base = 0;
  if (kind === "any") base = kinds.size >= 3 || own.ore + own.grain + here.ore + here.grain >= 8 ? 1.4 : 0.55;
  else base = produced >= 8 ? 2.4 : produced >= 4 ? 1.5 : produced > 0 ? 0.45 : 0.15;
  let value = base * decay;
  if (oppRoads !== undefined && oppRoads < roads) value *= 0.45;
  return value;
}

export function portAccess(ctx: BoardContext, dist: Map<string, number>, own: ResourceHand, oppDist?: Map<string, number>): PortAccessItem[] {
  const out: PortAccessItem[] = [];
  for (const c of ctx.corners) {
    if (!c.port) continue;
    const roads = dist.get(c.at);
    if (roads === undefined || roads > 4) continue;
    const oppRoads = oppDist?.get(c.at);
    const value = portWorth(c.port, own, { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 }, roads, oppRoads);
    if (value <= 0) continue;
    const contested = oppRoads !== undefined && oppRoads < roads;
    const name = c.port === "any" ? "3:1 port" : `2:1 ${LABEL[c.port]} port`;
    const where =
      roads === 0
        ? "your network reaches it; a road alone does not turn the harbor on"
        : `${roads} road${roads === 1 ? "" : "s"} away`;
    const extra = c.port !== "any" && own[c.port] >= 4 ? ", and it matches what you produce" : "";
    const race = contested ? ", but he is closer" : "";
    out.push({ at: c.at, kind: c.port, roads, value, contested, text: `${name}, ${where}${extra}${race}` });
  }
  return out.sort((a, b) => b.value - a.value);
}

/**
 * A harbor the player already controls. Only a settlement or a city on one of the
 * harbor's vertices activates it. A road that reaches the vertex does not.
 */
export interface ActivePortAccess {
  readonly at: string;
  readonly kind: PortKind;
  readonly piece: "settlement" | "city";
  readonly harborEdgeAt: string;
  readonly siblingAt?: string;
}

export type TradeRateSource = "specific" | "generic" | "bank";

export interface TradeRates {
  readonly rates: ResourceHand;
  readonly source: Readonly<Record<Resource, TradeRateSource>>;
}

/**
 * A harbor vertex the player does not yet occupy.
 * `roadsRemaining` counts only edges that still have to be built. Owned edges cost nothing.
 * `opponentRoadsRemaining` is the opponent's observed road distance, never a guessed hand.
 */
export interface PotentialPortAccess {
  readonly at: string;
  readonly kind: PortKind;
  readonly harborEdgeAt: string;
  readonly roadsRemaining: number | undefined;
  readonly occupiedBy?: string;
  readonly settlementLegal: boolean;
  readonly improvesRate: boolean;
  readonly improvedResources: readonly Resource[];
  readonly opponentRoadsRemaining: number | undefined;
  readonly acquisitionBlocked: boolean;
}

export interface PortAccessReport {
  readonly active: readonly ActivePortAccess[];
  readonly rates: TradeRates;
  readonly potential: readonly PotentialPortAccess[];
}

export interface PortAccessQuery {
  readonly ctx: BoardContext;
  readonly placements: Placements;
  readonly playerId: string;
  readonly myDistance: ReadonlyMap<string, number>;
  readonly opponentDistance?: ReadonlyMap<string, number>;
  readonly settlementLegal: (at: string) => boolean;
}

interface HarborEdge {
  readonly edgeAt: string;
  readonly kind: PortKind;
  readonly corners: readonly [string, string];
}

const bankRates = (): ResourceHand => ({ lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 });

function legalRate(rate: number | undefined): number {
  return rate === 2 || rate === 3 || rate === 4 ? rate : 4;
}

function ownerAt(placements: Placements, at: string): { owner: string; piece: "settlement" | "city" } | undefined {
  const cityOwner = placements.cities.get(at);
  if (cityOwner) return { owner: cityOwner, piece: "city" };
  const settlementOwner = placements.settlements.get(at);
  if (settlementOwner) return { owner: settlementOwner, piece: "settlement" };
  return undefined;
}

/** Harbor edges on the real board. Both vertices of an edge grant the same harbor. */
export function harborEdges(ctx: BoardContext): HarborEdge[] {
  const out: HarborEdge[] = [];
  const seen = new Set<string>();
  for (const port of ctx.board.ports ?? []) {
    if (seen.has(port.at)) continue;
    const pts = edgePoints(port.at);
    if (!pts) continue;
    const a = ctx.keyToAt.get(pointKey(pts[0]));
    const b = ctx.keyToAt.get(pointKey(pts[1]));
    if (!a || !b || a === b) continue;
    seen.add(port.at);
    out.push({ edgeAt: port.at, kind: port.kind, corners: [a, b] });
  }
  return out;
}

export function applyHarborToRates(rates: ResourceHand, kind: PortKind): ResourceHand {
  const next = { ...rates };
  if (kind === "any") {
    for (const resource of RESOURCES) next[resource] = Math.min(legalRate(next[resource]), 3);
  } else {
    next[kind] = Math.min(legalRate(next[kind]), 2);
  }
  return next;
}

export function resourcesImprovedByHarbor(rates: ResourceHand, kind: PortKind): Resource[] {
  const current = bankRates();
  const next = applyHarborToRates(rates, kind);
  for (const resource of RESOURCES) current[resource] = legalRate(rates[resource]);
  return RESOURCES.filter((resource) => next[resource] < current[resource]);
}

/** Best legal bank rate per resource. A quoted 4 does not erase a better rate already held. */
export function mergeTradeRates(a: ResourceHand, b: ResourceHand): ResourceHand {
  const out = bankRates();
  for (const resource of RESOURCES) out[resource] = Math.min(legalRate(a[resource]), legalRate(b[resource]));
  return out;
}

export function ratesFromPlacements(ctx: BoardContext, placements: Placements, owns: (playerId: string) => boolean): ResourceHand {
  let rates = bankRates();
  const seen = new Set<string>();
  for (const harbor of harborEdges(ctx)) {
    if (seen.has(harbor.edgeAt)) continue;
    const owned = harbor.corners.some((at) => {
      const piece = ownerAt(placements, at);
      return piece !== undefined && owns(piece.owner);
    });
    if (!owned) continue;
    seen.add(harbor.edgeAt);
    rates = applyHarborToRates(rates, harbor.kind);
  }
  return rates;
}

function sourcesFor(rates: ResourceHand, kinds: readonly PortKind[]): Record<Resource, TradeRateSource> {
  const specific = new Set(kinds.filter((kind): kind is Resource => kind !== "any"));
  const generic = kinds.includes("any");
  const source = {} as Record<Resource, TradeRateSource>;
  for (const resource of RESOURCES) {
    if (rates[resource] <= 2 && specific.has(resource)) source[resource] = "specific";
    else if (rates[resource] <= 3 && generic) source[resource] = "generic";
    else source[resource] = "bank";
  }
  return source;
}

/**
 * Separates harbors the player already controls from vertices that could still be settled.
 * Distances must come from the existing road graph: owned edges are already priced at zero there.
 */
export function assessPortAccess(query: PortAccessQuery): PortAccessReport {
  const { ctx, placements, playerId, myDistance, opponentDistance, settlementLegal } = query;
  const active: ActivePortAccess[] = [];
  const ownedEdges = new Set<string>();
  const activeKinds: PortKind[] = [];

  for (const harbor of harborEdges(ctx)) {
    const ownedCorners = harbor.corners
      .map((at) => ({ at, piece: ownerAt(placements, at) }))
      .filter((entry): entry is { at: string; piece: { owner: string; piece: "settlement" | "city" } } => entry.piece?.owner === playerId);
    if (!ownedCorners.length || ownedEdges.has(harbor.edgeAt)) continue;
    ownedEdges.add(harbor.edgeAt);
    activeKinds.push(harbor.kind);
    for (const owned of ownedCorners) {
      const sibling = harbor.corners.find((at) => at !== owned.at);
      active.push({
        at: owned.at,
        kind: harbor.kind,
        piece: owned.piece.piece,
        harborEdgeAt: harbor.edgeAt,
        ...(sibling ? { siblingAt: sibling } : {})
      });
    }
  }

  let rates = bankRates();
  for (const kind of activeKinds) rates = applyHarborToRates(rates, kind);

  const potential: PotentialPortAccess[] = [];
  for (const harbor of harborEdges(ctx)) {
    const weOwnHarbor = ownedEdges.has(harbor.edgeAt);
    for (const at of harbor.corners) {
      const occupier = ownerAt(placements, at);
      if (occupier?.owner === playerId) continue;
      const improved = weOwnHarbor ? [] : resourcesImprovedByHarbor(rates, harbor.kind);
      const legal = settlementLegal(at);
      potential.push({
        at,
        kind: harbor.kind,
        harborEdgeAt: harbor.edgeAt,
        roadsRemaining: myDistance.get(at),
        ...(occupier ? { occupiedBy: occupier.owner } : {}),
        settlementLegal: legal,
        improvesRate: improved.length > 0,
        improvedResources: improved,
        opponentRoadsRemaining: opponentDistance?.get(at),
        acquisitionBlocked: !legal
      });
    }
  }

  return {
    active,
    rates: { rates, source: sourcesFor(rates, activeKinds) },
    potential
  };
}

export function viablePortTargets(report: PortAccessReport): PotentialPortAccess[] {
  return report.potential.filter(
    (port) => port.improvesRate && port.settlementLegal && !port.acquisitionBlocked && port.roadsRemaining !== undefined
  );
}

export function describePortTarget(port: PotentialPortAccess): string {
  const name = port.kind === "any" ? "3:1 port" : `2:1 ${LABEL[port.kind]} port`;
  const roads = port.roadsRemaining;
  const where =
    roads === undefined
      ? "not connected to your roads"
      : roads === 0
        ? "your road already reaches it; settle there to turn the harbor on"
        : `${roads} more road${roads === 1 ? "" : "s"}`;
  const race =
    roads !== undefined && port.opponentRoadsRemaining !== undefined && port.opponentRoadsRemaining < roads ? ", and he is closer" : "";
  return `${name}, ${where}${race}`;
}
