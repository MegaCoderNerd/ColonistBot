/**
 * Decision-time observation for the offline learner.
 *
 * This is not the live coach. It records what the acting player can see or
 * what the live card counter can derive: the public board, the actor's own
 * hand, and each player's tracked resource counts. The bank is included only
 * when those counts are exact, as 19 minus the cards players hold. Opponent
 * dev-card faces, the dev deck order, and future dice stay out. An unnamed
 * steal or a missed transfer does not copy the simulator's hidden hand or bank.
 */

import { RESOURCES, type Resource } from "../types";
import type { ConcreteSimulatedGameState } from "../engine/state";
import type { SimulatedAction } from "../engine/transition";
import { type PublicResourceLedger, type TrackedResources } from "./ledger";
import { roadExpansionForAction } from "./road-features";

export const OBSERVATION_VERSION = "colonist_observation_v2";

const HAND_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;

/** Public description of one legal action. No opponent hand and no hidden card face. */
export interface ActionPublicFeatures {
  readonly corner_pips: number;
  readonly edge_pips: number;
  readonly hex_pips: number;
  /** -1 when this action has no corner, edge, or hex. */
  readonly corner_index: number;
  readonly edge_index: number;
  readonly hex_index: number;
  readonly lumber_pips: number;
  readonly brick_pips: number;
  readonly wool_pips: number;
  readonly grain_pips: number;
  readonly ore_pips: number;
  readonly port_none: number;
  readonly port_any: number;
  readonly port_lumber: number;
  readonly port_brick: number;
  readonly port_wool: number;
  readonly port_grain: number;
  readonly port_ore: number;
  readonly touches_own_building: number;
  readonly touches_own_road: number;
  readonly touches_opponent: number;
  readonly give_lumber: number;
  readonly give_brick: number;
  readonly give_wool: number;
  readonly give_grain: number;
  readonly give_ore: number;
  readonly receive_lumber: number;
  readonly receive_brick: number;
  readonly receive_wool: number;
  readonly receive_grain: number;
  readonly receive_ore: number;
  readonly cost_lumber: number;
  readonly cost_brick: number;
  readonly cost_wool: number;
  readonly cost_grain: number;
  readonly cost_ore: number;
  /** Zero on non-roads. Road values are public expansion facts, not a teacher label. */
  readonly reach_before: number;
  readonly reach_after: number;
  readonly reach_delta: number;
  readonly reach_before_known: number;
  readonly reach_after_known: number;
  readonly opens_settlement: number;
  readonly newly_opened: number;
  readonly connects_network: number;
}

export interface LegalCandidate {
  readonly action_id: string;
  readonly type: string;
  /** Public geometry of this action. Two roads can differ here. No hidden cards. */
  readonly public_features: ActionPublicFeatures;
  /** Present on full records. Omitted on the summary wire format the learner consumes. */
  readonly simulator?: SimulatedAction;
}

export interface ColonistObservation {
  readonly schema_version: typeof OBSERVATION_VERSION;
  readonly detail?: "full" | "summary";
  readonly actor_id: string;
  readonly player_count: number;
  readonly ruleset: "base";
  readonly phase: string;
  readonly dice_mode: "balanced" | "random";
  readonly victory_points_to_win: number;
  readonly board: {
    readonly hexes: Array<{ id: string; colonist_id: string; x: number; y: number; resource: Resource | null; number: number | null; pips: number }>;
    readonly corners: Array<{ id: string; at: string; hex_ids: string[]; port: string | null }>;
    readonly edges: Array<{ id: string; corners: [string, string] }>;
  };
  readonly placements: {
    readonly corners: Array<{ id: string; owner: string; piece: "settlement" | "city" }>;
    readonly edges: Array<{ id: string; owner: string }>;
  };
  readonly robber_hex_id: string;
  /** Present only when every tracked hand is exact. Otherwise null. */
  readonly bank: Record<(typeof HAND_KEYS)[number], number> | null;
  readonly bank_exact: boolean;
  readonly bank_confidence: "derived_from_exact_hands" | "uncertain";
  readonly robber_resource: Resource | "desert" | null;
  readonly actor: {
    readonly hand: Record<(typeof HAND_KEYS)[number], number>;
    readonly dev_cards: Record<string, number>;
    /** Public production pips. Cities count twice. The robber hex contributes nothing. */
    readonly production: Record<(typeof HAND_KEYS)[number], number>;
    readonly public_vp: number;
    readonly settlements_left: number;
    readonly cities_left: number;
    readonly roads_left: number;
  };
  readonly opponents: Array<{
    readonly id: string;
    readonly public_vp: number;
    readonly hand_size: number;
    /** Known cards from the live counter, plus how many cards are still unnamed. */
    readonly tracked_resources: TrackedResources;
    readonly settlements: number;
    readonly cities: number;
    readonly road_length: number;
    readonly knights_played: number;
    readonly has_longest_road: boolean;
    readonly has_largest_army: boolean;
  }>;
  readonly candidates: LegalCandidate[];
}

export function actionId(action: SimulatedAction): string {
  switch (action.type) {
    case "buildRoad":
    case "placeFreeRoad":
    case "placeSetupRoad":
      return `${action.type}:e${action.edgeIndex}`;
    case "buildSettlement":
    case "buildCity":
    case "placeSetupSettlement":
      return `${action.type}:c${action.cornerIndex}`;
    case "moveRobber":
      return `${action.type}:h${action.hexIndex}${action.victimId ? `:${action.victimId}` : ""}`;
    case "bankTrade":
      return `bankTrade:${action.give}:${action.giveCount ?? 4}:${action.receive}:${action.receiveCount ?? 1}`;
    case "playYearOfPlenty":
      return `playYearOfPlenty:${action.resources.join("+")}`;
    case "playMonopoly":
      return `playMonopoly:${action.resource}`;
    case "discard":
      return `discard:${HAND_KEYS.map((key) => `${key}${action.cards[key] ?? 0}`).join(".")}`;
    case "playerTrade":
      return `playerTrade:${action.partnerId}:${HAND_KEYS.map((key) => `${key}${action.give[key] ?? 0}-${action.receive[key] ?? 0}`).join(".")}`;
    case "rollDice":
      return action.total !== undefined ? `rollDice:${action.total}` : "rollDice";
    default:
      return action.type;
  }
}

/** Stable ids. A repeated base id gets a suffix so two legal actions cannot share one label. */
export function identifyActions(state: ConcreteSimulatedGameState, actions: readonly SimulatedAction[], actorId: string): LegalCandidate[] {
  const seen = new Map<string, number>();
  return actions.map((action) => {
    const base = actionId(action);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      action_id: count === 0 ? base : `${base}#${count}`,
      type: action.type,
      public_features: publicActionFeatures(state, action, actorId),
      simulator: action
    };
  });
}

const PAID_COST: Partial<Record<string, Partial<Record<(typeof HAND_KEYS)[number], number>>>> = {
  buildRoad: { lumber: 1, brick: 1 },
  buildSettlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
  buildCity: { grain: 2, ore: 3 },
  buyDevCard: { wool: 1, grain: 1, ore: 1 }
};

function emptyPips(): Record<(typeof HAND_KEYS)[number], number> {
  return { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
}

function cornerResourcePips(state: ConcreteSimulatedGameState, cornerIndex: number): Record<(typeof HAND_KEYS)[number], number> {
  const totals = emptyPips();
  const corner = state.topology.corners[cornerIndex];
  if (!corner) return totals;
  for (const hexIndex of corner.hexIndices) {
    if (state.robberHexIndex !== null && hexIndex === state.robberHexIndex) continue;
    const hex = state.topology.hexes[hexIndex];
    if (!hex?.resource) continue;
    totals[hex.resource] += hex.pips;
  }
  return totals;
}

function edgeResourcePips(state: ConcreteSimulatedGameState, edgeIndex: number): Record<(typeof HAND_KEYS)[number], number> {
  const totals = emptyPips();
  const edge = state.topology.edges[edgeIndex];
  if (!edge) return totals;
  const seen = new Set<number>();
  for (const cornerIndex of [edge.c1, edge.c2]) {
    const corner = state.topology.corners[cornerIndex];
    if (!corner) continue;
    for (const hexIndex of corner.hexIndices) {
      if (seen.has(hexIndex)) continue;
      seen.add(hexIndex);
      if (state.robberHexIndex !== null && hexIndex === state.robberHexIndex) continue;
      const hex = state.topology.hexes[hexIndex];
      if (!hex?.resource) continue;
      totals[hex.resource] += hex.pips;
    }
  }
  return totals;
}

function actorProduction(state: ConcreteSimulatedGameState, actorId: string): Record<(typeof HAND_KEYS)[number], number> {
  const totals = emptyPips();
  for (let index = 0; index < state.cornerOwner.length; index++) {
    if (state.cornerOwner[index] !== actorId) continue;
    const piece = state.cornerPiece[index];
    if (piece !== 1 && piece !== 2) continue;
    const weight = piece === 2 ? 2 : 1;
    const pips = cornerResourcePips(state, index);
    for (const key of HAND_KEYS) totals[key] += pips[key] * weight;
  }
  return totals;
}

function robberResource(state: ConcreteSimulatedGameState): Resource | "desert" | null {
  if (state.robberHexIndex === null) return null;
  const hex = state.topology.hexes[state.robberHexIndex];
  if (!hex) return null;
  return hex.resource ?? "desert";
}

function publicActionFeatures(state: ConcreteSimulatedGameState, action: SimulatedAction, actorId: string): ActionPublicFeatures {
  let cornerPips = 0;
  let edgePips = 0;
  let hexPips = 0;
  let cornerIndex = -1;
  let edgeIndex = -1;
  let hexIndex = -1;
  let resourcePips = emptyPips();
  let contextCorners: number[] = [];
  if ("cornerIndex" in action && typeof action.cornerIndex === "number") {
    cornerIndex = action.cornerIndex;
    contextCorners = [action.cornerIndex];
    cornerPips = state.topology.corners[action.cornerIndex]?.pips ?? 0;
    resourcePips = cornerResourcePips(state, action.cornerIndex);
  }
  if ("edgeIndex" in action && typeof action.edgeIndex === "number") {
    edgeIndex = action.edgeIndex;
    const edge = state.topology.edges[action.edgeIndex];
    if (edge) {
      contextCorners = [edge.c1, edge.c2];
      edgePips = (state.topology.corners[edge.c1]?.pips ?? 0) + (state.topology.corners[edge.c2]?.pips ?? 0);
      resourcePips = edgeResourcePips(state, action.edgeIndex);
    }
  }
  if (action.type === "moveRobber") {
    hexIndex = action.hexIndex;
    const hex = state.topology.hexes[action.hexIndex];
    hexPips = hex?.pips ?? 0;
    contextCorners = [...(hex?.cornerIndices ?? [])];
    resourcePips = emptyPips();
    if (hex?.resource) resourcePips[hex.resource] = hex.pips;
  }
  const give = emptyPips();
  const receive = emptyPips();
  if (action.type === "bankTrade") {
    give[action.give] = action.giveCount ?? 4;
    receive[action.receive] = action.receiveCount ?? 1;
  } else if (action.type === "discard") {
    for (const key of HAND_KEYS) give[key] = action.cards[key] ?? 0;
  } else if (action.type === "playYearOfPlenty") {
    for (const resource of action.resources) receive[resource] += 1;
  } else if (action.type === "playMonopoly") {
    receive[action.resource] = 1;
  } else if (action.type === "playerTrade") {
    for (const key of HAND_KEYS) {
      give[key] = action.give[key] ?? 0;
      receive[key] = action.receive[key] ?? 0;
    }
  }
  const cost = emptyPips();
  const paid = PAID_COST[action.type];
  if (paid) {
    for (const key of HAND_KEYS) cost[key] = paid[key] ?? 0;
  }
  const ports = { port_none: 1, port_any: 0, port_lumber: 0, port_brick: 0, port_wool: 0, port_grain: 0, port_ore: 0 };
  let touchesOwnBuilding = 0;
  let touchesOwnRoad = 0;
  let touchesOpponent = 0;
  for (const index of contextCorners) {
    const port = state.topology.corners[index]?.port;
    if (port) {
      ports.port_none = 0;
      if (port === "any") ports.port_any = 1;
      else if (port === "lumber") ports.port_lumber = 1;
      else if (port === "brick") ports.port_brick = 1;
      else if (port === "wool") ports.port_wool = 1;
      else if (port === "grain") ports.port_grain = 1;
      else ports.port_ore = 1;
    }
    const owner = state.cornerOwner[index];
    if (owner === actorId && state.cornerPiece[index]) touchesOwnBuilding = 1;
    else if (owner && owner !== actorId) touchesOpponent = 1;
    for (const incident of state.topology.corners[index]?.incidentEdgeIndices ?? []) {
      const edgeOwner = state.edgeOwner[incident];
      if (edgeOwner === actorId) touchesOwnRoad = 1;
      else if (edgeOwner && edgeOwner !== actorId) touchesOpponent = 1;
    }
  }
  return {
    corner_pips: cornerPips,
    edge_pips: edgePips,
    hex_pips: hexPips,
    corner_index: cornerIndex,
    edge_index: edgeIndex,
    hex_index: hexIndex,
    lumber_pips: resourcePips.lumber,
    brick_pips: resourcePips.brick,
    wool_pips: resourcePips.wool,
    grain_pips: resourcePips.grain,
    ore_pips: resourcePips.ore,
    ...ports,
    touches_own_building: touchesOwnBuilding,
    touches_own_road: touchesOwnRoad,
    touches_opponent: touchesOpponent,
    give_lumber: give.lumber,
    give_brick: give.brick,
    give_wool: give.wool,
    give_grain: give.grain,
    give_ore: give.ore,
    receive_lumber: receive.lumber,
    receive_brick: receive.brick,
    receive_wool: receive.wool,
    receive_grain: receive.grain,
    receive_ore: receive.ore,
    cost_lumber: cost.lumber,
    cost_brick: cost.brick,
    cost_wool: cost.wool,
    cost_grain: cost.grain,
    cost_ore: cost.ore,
    ...roadExpansionForAction(state, actorId, action)
  };
}

function handOf(hand: Partial<Record<Resource, number>>): Record<(typeof HAND_KEYS)[number], number> {
  return {
    lumber: hand.lumber ?? 0,
    brick: hand.brick ?? 0,
    wool: hand.wool ?? 0,
    grain: hand.grain ?? 0,
    ore: hand.ore ?? 0
  };
}

function devCounts(player: ConcreteSimulatedGameState["players"][number]): Record<string, number> {
  const counts: Record<string, number> = { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0, victoryPoint: player.vpDevs };
  for (const card of [...player.readyDevs, ...player.boughtDevsThisTurn]) counts[card] = (counts[card] ?? 0) + 1;
  return counts;
}

export function visibleHandSize(hand: Partial<Record<Resource, number>>): number {
  return RESOURCES.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0);
}

/** The extra summary-model features. Python `tracked_tail` must produce the same numbers. */
export function trackedFeatureTail(observation: {
  readonly opponents?: ReadonlyArray<{ readonly tracked_resources?: Partial<TrackedResources> }>;
  readonly bank_exact?: boolean;
}): number[] {
  const opponents = [...(observation.opponents ?? [])].slice(0, 2);
  while (opponents.length < 2) opponents.push({});
  const tail: number[] = [];
  for (const opponent of opponents) {
    const tracked = opponent.tracked_resources ?? {};
    for (const resource of RESOURCES) tail.push(Number(tracked[resource] ?? 0) / 10);
    tail.push(Number(tracked.unknown ?? 0) / 10);
    tail.push(tracked.exact ? 1 : 0);
  }
  tail.push(observation.bank_exact ? 1 : 0);
  return tail;
}

const EMPTY_TRACKED: TrackedResources = {
  lumber: 0,
  brick: 0,
  wool: 0,
  grain: 0,
  ore: 0,
  unknown: 0,
  exact: false
};

export function toObservation(
  state: ConcreteSimulatedGameState,
  actorId: string,
  legal: readonly SimulatedAction[],
  ledger: PublicResourceLedger
): ColonistObservation {
  const actor = state.players.find((player) => player.id === actorId);
  if (!actor) throw new Error(`Unknown actor ${actorId}`);
  const publicSizes: Record<string, number> = {};
  for (const player of state.players) publicSizes[player.id] = visibleHandSize(player.hand);
  const tracked = ledger.snapshot(publicSizes);
  const corners = [];
  for (let index = 0; index < state.cornerOwner.length; index++) {
    const owner = state.cornerOwner[index];
    const piece = state.cornerPiece[index];
    if (!owner || piece === 0) continue;
    corners.push({ id: `c${index}`, owner, piece: piece === 2 ? "city" as const : "settlement" as const });
  }
  const edges = [];
  for (let index = 0; index < state.edgeOwner.length; index++) {
    const owner = state.edgeOwner[index];
    if (owner) edges.push({ id: `e${index}`, owner });
  }
  return {
    schema_version: OBSERVATION_VERSION,
    detail: "full",
    actor_id: actorId,
    player_count: state.players.length,
    ruleset: "base",
    phase: state.phase,
    dice_mode: state.rules.diceMode,
    victory_points_to_win: state.rules.victoryPointsToWin,
    board: {
      hexes: state.topology.hexes.map((hex) => ({
        id: `h${hex.index}`,
        colonist_id: hex.colonistId,
        x: hex.x,
        y: hex.y,
        resource: hex.resource,
        number: hex.number,
        pips: hex.pips
      })),
      corners: state.topology.corners.map((corner) => ({
        id: `c${corner.index}`,
        at: corner.at,
        hex_ids: corner.hexIndices.map((index) => `h${index}`),
        port: corner.port ?? null
      })),
      edges: state.topology.edges.map((edge) => ({
        id: `e${edge.index}`,
        corners: [`c${edge.c1}`, `c${edge.c2}`] as [string, string]
      }))
    },
    placements: { corners, edges },
    robber_hex_id: `h${state.robberHexIndex}`,
    robber_resource: robberResource(state),
    bank: tracked.bank_exact ? handOf(tracked.bank ?? {}) : null,
    bank_exact: tracked.bank_exact,
    bank_confidence: tracked.bank_confidence,
    actor: {
      hand: handOf(actor.hand),
      dev_cards: devCounts(actor),
      production: actorProduction(state, actorId),
      public_vp: actor.visibleVp,
      settlements_left: actor.settlementsLeft,
      cities_left: actor.citiesLeft,
      roads_left: actor.roadsLeft
    },
    opponents: state.players
      .filter((player) => player.id !== actorId)
      .map((player) => ({
        id: player.id,
        public_vp: player.visibleVp,
        hand_size: publicSizes[player.id] ?? 0,
        tracked_resources: tracked.hands[player.id] ?? { ...EMPTY_TRACKED, unknown: publicSizes[player.id] ?? 0 },
        settlements: countPieces(state, player.id, 1),
        cities: countPieces(state, player.id, 2),
        road_length: player.roadLength,
        knights_played: player.knightsPlayed,
        has_longest_road: player.hasLongestRoad,
        has_largest_army: player.hasLargestArmy
      })),
    candidates: identifyActions(state, legal, actorId)
  };
}

function countPieces(state: ConcreteSimulatedGameState, playerId: string, piece: number): number {
  let count = 0;
  for (let index = 0; index < state.cornerOwner.length; index++) {
    if (state.cornerOwner[index] === playerId && state.cornerPiece[index] === piece) count += 1;
  }
  return count;
}

const FORBIDDEN = ["opponent_hands", "future_dice", "dev_deck_order", "opponent_dev_identities", "stolen_resource"];

/** Rejects an observation that carries hidden or future information. */
/**
 * The learner's feature vector does not read the board lists. Summary drops them,
 * and drops the simulator action body, so a long game does not resend the map
 * at every decision. Legality is still enforced by action id inside the session.
 */
export function wireObservation(observation: ColonistObservation, detail: "full" | "summary"): ColonistObservation {
  if (detail === "full") return observation;
  return {
    ...observation,
    detail: "summary",
    board: { hexes: [], corners: [], edges: [] },
    placements: { corners: [], edges: [] },
    candidates: observation.candidates.map((candidate) => ({
      action_id: candidate.action_id,
      type: candidate.type,
      public_features: candidate.public_features
    }))
  };
}

export function observationLeaks(value: unknown): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const observation = value as Partial<ColonistObservation>;
    if (observation.bank_exact === false && observation.bank) return "$.bank";
    if (observation.bank_exact === true && !observation.bank) return "$.bank";
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): string | undefined => {
    if (!node || typeof node !== "object") return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        const hit = walk(node[index], `${path}[${index}]`);
        if (hit) return hit;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN.includes(key)) return `${path}.${key}`;
      if (path.includes("opponents") && key === "hand") return `${path}.hand`;
      const hit = walk(child, `${path}.${key}`);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(value, "$");
}
