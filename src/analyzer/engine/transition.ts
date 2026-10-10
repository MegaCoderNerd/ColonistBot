import { RESOURCES, type DevCardKind, type Resource, type ResourceBag, type ResourceHand } from "../types";
import {
  BANK_RESOURCE_CAP,
  cloneConcreteSimState,
  computeRoadLengthOnTopology,
  MAX_CITIES,
  MAX_ROADS,
  MAX_SETTLEMENTS,
  STANDARD_DEV_DECK_COUNTS,
  validateConcreteSimState,
  type ActionDevCardKind,
  type ConcreteDevCardKind,
  type ConcreteSimulatedGameState,
  type ConcreteSimulatedPlayerState,
  type ConcreteTurnPhase,
  type ObservedGameState
} from "./state";
import type { BoardTopology } from "./topology";

export type SimulatedAction =
  | {
      readonly type: "placeSetupSettlement";
      readonly cornerIndex: number;
    }
  | {
      readonly type: "placeSetupRoad";
      readonly edgeIndex: number;
    }
  | {
      readonly type: "rollDice";
      readonly d1?: number;
      readonly d2?: number;
      readonly total?: number;
    }
  | {
      readonly type: "discard";
      readonly cards: ResourceBag;
    }
  | {
      readonly type: "moveRobber";
      readonly hexIndex: number;
      readonly victimId?: string | null;
    }
  | {
      readonly type: "buildRoad";
      readonly edgeIndex: number;
    }
  | {
      readonly type: "buildSettlement";
      readonly cornerIndex: number;
    }
  | {
      readonly type: "buildCity";
      readonly cornerIndex: number;
    }
  | {
      readonly type: "buyDevCard";
    }
  | {
      readonly type: "playKnight";
    }
  | {
      readonly type: "playRoadBuilding";
    }
  | {
      readonly type: "placeFreeRoad";
      readonly edgeIndex: number;
    }
  | {
      readonly type: "playYearOfPlenty";
      readonly resources: readonly [Resource] | readonly [Resource, Resource];
    }
  | {
      readonly type: "playMonopoly";
      readonly resource: Resource;
    }
  | {
      readonly type: "bankTrade";
      readonly give: Resource;
      readonly receive: Resource;
      readonly giveCount?: number;
      readonly receiveCount?: number;
    }
  | {
      readonly type: "playerTrade";
      readonly partnerId: string;
      readonly give: ResourceBag;
      readonly receive: ResourceBag;
    }
  | {
      readonly type: "endTurn";
    };

export interface ActionOutcome {
  /** Authoritative or sampled dice roll outcome when executing `rollDice`. */
  readonly dice?: {
    readonly d1?: number;
    readonly d2?: number;
    readonly total?: number;
  };
  /** Authoritative or sampled resource stolen from the selected victim when executing `moveRobber`. */
  readonly stolenResource?: Resource;
  /** Optional explicit dev card drawn from `devDeckOrder` when executing `buyDevCard`. */
  readonly drawnDevCard?: ConcreteDevCardKind;
}

export type TransitionErrorCode =
  | "invalid_state"
  | "unsupported_variant"
  | "unsupported_ruleset"
  | "unsupported_phase"
  | "unsupported_action"
  | "game_already_over"
  | "unknown_player"
  | "not_active_player"
  | "wrong_phase"
  | "insufficient_resources"
  | "insufficient_piece_supply"
  | "insufficient_bank_resources"
  | "empty_dev_deck"
  | "invalid_topology_index"
  | "occupied_corner"
  | "occupied_edge"
  | "distance_rule_violation"
  | "unconnected_road"
  | "unconnected_settlement"
  | "blocked_by_opponent_building"
  | "invalid_city_upgrade"
  | "dev_card_not_available"
  | "dev_card_bought_this_turn"
  | "dev_card_already_played_this_turn"
  | "invalid_discard"
  | "no_discard_required"
  | "robber_must_move"
  | "friendly_robber_restriction"
  | "invalid_robber_victim"
  | "invalid_trade"
  | "missing_outcome"
  | "invalid_outcome";

export interface TransitionFailure {
  readonly ok: false;
  readonly state?: undefined;
  readonly error: {
    readonly code: TransitionErrorCode;
    readonly message: string;
    readonly playerId?: string;
    readonly actionType?: string;
    readonly phase?: string;
  };
}

export interface TransitionSuccess {
  readonly ok: true;
  readonly state: ConcreteSimulatedGameState;
  readonly error?: undefined;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

export interface LegalActionOptions {
  /**
   * When true, `getLegalActions` also enumerates legal 1-for-1 domestic trade actions
   * between the active player and seated partners who hold the requested resource.
   * Defaults to false so rollout policy callers are not flooded with combinatorial trade bags.
   */
  readonly includeDomesticTrades?: boolean;
}

export interface ConcreteDeterminizationInput {
  /** Explicit resource hands keyed by player ID (required for any player whose observed `hand.exact` is null). */
  readonly handsByPlayerId?: Readonly<Record<string, ResourceHand>>;
  /** Explicit unrevealed dev cards in hand keyed by player ID (required for any player with `devs.unknownInHand > 0`). */
  readonly unknownDevsByPlayerId?: Readonly<
    Record<
      string,
      {
        readonly ready?: readonly ActionDevCardKind[];
        readonly boughtThisTurn?: readonly ActionDevCardKind[];
        readonly vp?: number;
      }
    >
  >;
  /** Explicit order of remaining dev cards in the bank deck (required if `devDeck.bankRemaining > 0`). */
  readonly devDeckOrder?: readonly ConcreteDevCardKind[];
  /** Explicit phase override if `observed.phase === "unknown"`. */
  readonly phase?: ConcreteTurnPhase;
  /** Explicit active turn player ID if `observed.turnPlayerId` is missing. */
  readonly turnPlayerId?: string;
  /** Explicit robber hex index if `observed.robberHexIndex === null`. */
  readonly robberHexIndex?: number;
}

export interface CreateInitialConcreteStateOptions {
  readonly topology: BoardTopology;
  readonly playerIds: readonly string[];
  readonly devDeckOrder?: readonly ConcreteDevCardKind[];
  readonly robberHexIndex?: number;
  readonly rules?: Partial<ConcreteSimulatedGameState["rules"]>;
}

const emptyHand = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const sumHand = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);
const isResource = (r: unknown): r is Resource => typeof r === "string" && (RESOURCES as readonly string[]).includes(r);

function fail(
  code: TransitionErrorCode,
  message: string,
  ctx?: { playerId?: string; actionType?: string; phase?: string }
): TransitionFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(ctx?.playerId !== undefined ? { playerId: ctx.playerId } : {}),
      ...(ctx?.actionType !== undefined ? { actionType: ctx.actionType } : {}),
      ...(ctx?.phase !== undefined ? { phase: ctx.phase } : {})
    }
  };
}

/**
 * Validates that the topology and ruleset belong to the established, rule-verified domain
 * (standard 19-hex Catan board, 2–4 players, base-game supply, no unvalidated expansions or Special Building Phase).
 * Fails closed on unsupported variants or rulesets rather than approximating their mechanics.
 */
export function validateSupportedVariantAndRuleset(
  topology: BoardTopology,
  playerCount: number,
  rules: ConcreteSimulatedGameState["rules"]
): TransitionFailure | null {
  if (!topology.variant.isStandard19Hex || topology.colonistIdsSource === "none") {
    return fail(
      "unsupported_variant",
      `Unsupported board topology variant (hexes=${topology.variant.hexCount}, corners=${topology.variant.cornerCount}, edges=${topology.variant.edgeCount}, colonistIdsSource=${topology.colonistIdsSource}). Only the standard 19-hex, 54-corner, 72-edge Catan board is currently validated.`
    );
  }
  if (playerCount < 2 || playerCount > 4) {
    return fail(
      "unsupported_ruleset",
      `Unsupported player count ${playerCount}. The rules engine currently supports 2–4 players on the base-game supply; 5–6 player expansion supply and Special Building Phase are not yet validated.`
    );
  }
  if (rules.maxPlayers !== undefined && (rules.maxPlayers < 2 || rules.maxPlayers > 4)) {
    return fail(
      "unsupported_ruleset",
      `Unsupported rules.maxPlayers=${rules.maxPlayers}. Only 2–4 player base-game configurations are validated.`
    );
  }
  if (rules.specialBuildingPhase === true) {
    return fail("unsupported_ruleset", "Special Building Phase (5–6 player expansion) is not supported.");
  }
  if (rules.extensionSetting !== undefined && rules.extensionSetting !== 0) {
    return fail("unsupported_ruleset", `Unsupported extensionSetting=${rules.extensionSetting}. Expansion rulesets are not supported.`);
  }
  if (rules.mapSetting !== undefined && rules.mapSetting !== 0) {
    return fail("unsupported_ruleset", `Unsupported mapSetting=${rules.mapSetting}. Non-standard map variants are not supported.`);
  }
  return null;
}

/**
 * Recomputes `visibleVp`, `observedConfirmedVp`, and `actualSimulatedVp` for all players
 * from the authoritative board state (`cornerOwner`, `cornerPiece`), award flags
 * (`hasLongestRoad`, `hasLargestArmy`), and each player's `vpDevs`.
 *
 * Preserves the distinction between:
 * - `visibleVp`: public board + award VP (used for Friendly Robber checks).
 * - `observedConfirmedVp`: `visibleVp` + observer-confirmed hidden VP prior to sampling.
 * - `actualSimulatedVp`: `visibleVp + vpDevs` (actual total VP inside this concrete simulation sample).
 */
export function recomputePlayerVp(state: ConcreteSimulatedGameState): void {
  const settlementsByPlayer = new Map<string, number>();
  const citiesByPlayer = new Map<string, number>();
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    const owner = state.cornerOwner[ci];
    if (!owner) continue;
    const piece = state.cornerPiece[ci];
    if (piece === 1) settlementsByPlayer.set(owner, (settlementsByPlayer.get(owner) ?? 0) + 1);
    else if (piece === 2) citiesByPlayer.set(owner, (citiesByPlayer.get(owner) ?? 0) + 1);
  }

  for (const p of state.players) {
    const prevVisibleVp = p.visibleVp;
    const confirmedHiddenVp = Math.max(0, p.observedConfirmedVp - prevVisibleVp);
    const settlementsVp = settlementsByPlayer.get(p.id) ?? 0;
    const citiesVp = (citiesByPlayer.get(p.id) ?? 0) * 2;
    const longestRoadVp = p.hasLongestRoad ? 2 : 0;
    const largestArmyVp = p.hasLargestArmy ? 2 : 0;
    const newVisibleVp = settlementsVp + citiesVp + longestRoadVp + largestArmyVp;
    p.visibleVp = newVisibleVp;
    p.observedConfirmedVp = newVisibleVp + confirmedHiddenVp;
    p.actualSimulatedVp = newVisibleVp + p.vpDevs;
  }
}

/**
 * Recomputes connected road lengths on the shared board topology for all players
 * (accounting for opponent buildings interrupting road continuations) and updates
 * Longest Road ownership according to official Catan Almanac rules:
 * - Minimum threshold of 5 connected roads.
 * - Incumbent retains the award if their road length is >= 5 and tied for or solely the maximum.
 * - If no player has >= 5 roads, nobody holds Longest Road.
 * - If the incumbent's road is overtaken or broken below the maximum (>= 5):
 *   - Transfers to the unique player achieving the new maximum (>= 5).
 *   - If two or more non-incumbent players tie for the new maximum (>= 5), the award becomes unclaimed.
 */
export function updateLongestRoadAward(state: ConcreteSimulatedGameState): void {
  for (const p of state.players) {
    p.roadLength = computeRoadLengthOnTopology(state.topology, state.cornerOwner, state.edgeOwner, p.id);
  }
  const incumbent = state.players.find((p) => p.hasLongestRoad) ?? null;
  let maxLen = 0;
  for (const p of state.players) {
    if (p.roadLength > maxLen) maxLen = p.roadLength;
  }

  if (maxLen < 5) {
    for (const p of state.players) p.hasLongestRoad = false;
    recomputePlayerVp(state);
    return;
  }

  if (incumbent && incumbent.roadLength === maxLen) {
    for (const p of state.players) {
      p.hasLongestRoad = p.id === incumbent.id;
    }
    recomputePlayerVp(state);
    return;
  }

  const leaders = state.players.filter((p) => p.roadLength === maxLen);
  if (leaders.length === 1) {
    const newHolderId = leaders[0].id;
    for (const p of state.players) {
      p.hasLongestRoad = p.id === newHolderId;
    }
  } else {
    for (const p of state.players) {
      p.hasLongestRoad = false;
    }
  }
  recomputePlayerVp(state);
}

/**
 * Updates Largest Army ownership across all players according to official Catan rules:
 * - Minimum threshold of 3 played Knights.
 * - Incumbent retains the award on a tie.
 * - Transfers only when a player with >= 3 played Knights strictly exceeds the incumbent's Knight count.
 */
export function updateLargestArmyAward(state: ConcreteSimulatedGameState): void {
  const incumbent = state.players.find((p) => p.hasLargestArmy) ?? null;
  let maxArmy = 0;
  for (const p of state.players) {
    if (p.knightsPlayed > maxArmy) maxArmy = p.knightsPlayed;
  }

  if (maxArmy < 3) {
    for (const p of state.players) p.hasLargestArmy = false;
    recomputePlayerVp(state);
    return;
  }

  if (incumbent && incumbent.knightsPlayed === maxArmy) {
    for (const p of state.players) {
      p.hasLargestArmy = p.id === incumbent.id;
    }
    recomputePlayerVp(state);
    return;
  }

  const leaders = state.players.filter((p) => p.knightsPlayed === maxArmy);
  if (leaders.length === 1) {
    const newHolderId = leaders[0].id;
    for (const p of state.players) {
      p.hasLargestArmy = p.id === newHolderId;
    }
  } else {
    for (const p of state.players) {
      p.hasLargestArmy = false;
    }
  }
  recomputePlayerVp(state);
}

function applyPortRatioToPlayer(player: ConcreteSimulatedPlayerState, topology: BoardTopology, cornerIndex: number): void {
  const port = topology.corners[cornerIndex]?.port;
  if (!port) return;
  if (port === "any") {
    for (const r of RESOURCES) {
      player.ratios[r] = Math.min(player.ratios[r], 3);
    }
  } else {
    player.ratios[port] = Math.min(player.ratios[port], 2);
  }
}

function checkActivePlayerVictory(state: ConcreteSimulatedGameState): boolean {
  const active = state.players[state.turnPlayerIndex];
  if (!active) return false;
  if (active.actualSimulatedVp >= state.rules.victoryPointsToWin) {
    state.phase = "game_over";
    state.winnerId = active.id;
    return true;
  }
  return false;
}

function isCornerDistanceLegal(state: ConcreteSimulatedGameState, cornerIndex: number): boolean {
  const corner = state.topology.corners[cornerIndex];
  if (!corner) return false;
  for (const adj of corner.adjacentCornerIndices) {
    if (state.cornerPiece[adj] > 0) return false;
  }
  return true;
}

/**
 * Determines the setup settlement corner to which the current `setup_road` placement must connect.
 */
function resolvePendingSetupCornerIndex(state: ConcreteSimulatedGameState, playerId: string): number | undefined {
  if (
    state.pendingSetupCornerIndex !== undefined &&
    state.cornerOwner[state.pendingSetupCornerIndex] === playerId &&
    state.cornerPiece[state.pendingSetupCornerIndex] === 1
  ) {
    return state.pendingSetupCornerIndex;
  }
  const unattachedOwnedCorners: number[] = [];
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    if (state.cornerOwner[ci] !== playerId) continue;
    const hasOwnedIncidentRoad = state.topology.corners[ci].incidentEdgeIndices.some((ei) => state.edgeOwner[ei] === playerId);
    if (!hasOwnedIncidentRoad) unattachedOwnedCorners.push(ci);
  }
  return unattachedOwnedCorners.length === 1 ? unattachedOwnedCorners[0] : undefined;
}

/**
 * Classifies whether a player can legally place a road on `edgeIndex` during `"main"`, `"road_building_1"`, or `"road_building_2"`.
 * Returns `"ok"` if at least one endpoint connects to the player's building or unblocked road network,
 * `"blocked_by_opponent_building"` if the edge touches the player's road ONLY through a corner occupied by an opponent's building,
 * or `"unconnected_road"` if neither endpoint touches the player's network.
 */
function classifyRoadConnectivity(
  state: ConcreteSimulatedGameState,
  playerId: string,
  edgeIndex: number
): "ok" | "blocked_by_opponent_building" | "unconnected_road" {
  const edge = state.topology.edges[edgeIndex];
  if (!edge) return "unconnected_road";

  let blockedTouch = false;
  for (const c of [edge.c1, edge.c2]) {
    const cornerOwner = state.cornerOwner[c];
    if (cornerOwner === playerId) {
      return "ok";
    }
    const touchesOwnRoadAtC = state.topology.corners[c].incidentEdgeIndices.some(
      (ei) => ei !== edgeIndex && state.edgeOwner[ei] === playerId
    );
    if (touchesOwnRoadAtC) {
      if (cornerOwner === null) {
        return "ok";
      }
      blockedTouch = true;
    }
  }

  return blockedTouch ? "blocked_by_opponent_building" : "unconnected_road";
}

export function getLegalSetupSettlementCorners(state: ConcreteSimulatedGameState, playerId: string): number[] {
  if (state.phase !== "setup_settlement") return [];
  const active = state.players[state.turnPlayerIndex];
  if (!active || active.id !== playerId || active.settlementsLeft <= 0) return [];
  const out: number[] = [];
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    if (state.cornerPiece[ci] === 0 && isCornerDistanceLegal(state, ci)) {
      out.push(ci);
    }
  }
  return out;
}

export function getLegalSetupRoadEdges(state: ConcreteSimulatedGameState, playerId: string): number[] {
  if (state.phase !== "setup_road") return [];
  const active = state.players[state.turnPlayerIndex];
  if (!active || active.id !== playerId || active.roadsLeft <= 0) return [];
  const anchorCorner = resolvePendingSetupCornerIndex(state, playerId);
  if (anchorCorner === undefined) return [];
  const out: number[] = [];
  for (const ei of state.topology.corners[anchorCorner].incidentEdgeIndices) {
    if (state.edgeOwner[ei] === null) out.push(ei);
  }
  return out.sort((a, b) => a - b);
}

export function getLegalRoadEdges(state: ConcreteSimulatedGameState, playerId: string): number[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.roadsLeft <= 0) return [];
  const out: number[] = [];
  for (let ei = 0; ei < state.topology.edges.length; ei++) {
    if (state.edgeOwner[ei] !== null) continue;
    if (classifyRoadConnectivity(state, playerId, ei) === "ok") {
      out.push(ei);
    }
  }
  return out;
}

export function getLegalSettlementCorners(state: ConcreteSimulatedGameState, playerId: string): number[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.settlementsLeft <= 0) return [];
  const out: number[] = [];
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    if (state.cornerPiece[ci] !== 0) continue;
    if (!isCornerDistanceLegal(state, ci)) continue;
    const connectedToOwnRoad = state.topology.corners[ci].incidentEdgeIndices.some((ei) => state.edgeOwner[ei] === playerId);
    if (connectedToOwnRoad) out.push(ci);
  }
  return out;
}

export function getLegalCityCorners(state: ConcreteSimulatedGameState, playerId: string): number[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.citiesLeft <= 0) return [];
  const out: number[] = [];
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    if (state.cornerOwner[ci] === playerId && state.cornerPiece[ci] === 1) {
      out.push(ci);
    }
  }
  return out;
}

function isHexRestrictedByFriendlyRobber(
  state: ConcreteSimulatedGameState,
  actorId: string,
  hexIndex: number
): boolean {
  if (!state.rules.friendlyRobber) return false;
  const hex = state.topology.hexes[hexIndex];
  if (!hex || hex.resource === null) return false; // Desert is never restricted by Friendly Robber
  const minVp = state.rules.friendlyRobberMinVisibleVp;
  for (const ci of hex.cornerIndices) {
    const ownerId = state.cornerOwner[ci];
    if (!ownerId || ownerId === actorId) continue;
    const owner = state.players.find((p) => p.id === ownerId);
    if (owner && owner.visibleVp < minVp) {
      return true;
    }
  }
  return false;
}

export function getEligibleRobberVictims(
  state: ConcreteSimulatedGameState,
  actorId: string,
  hexIndex: number
): string[] {
  const hex = state.topology.hexes[hexIndex];
  if (!hex) return [];
  const minVp = state.rules.friendlyRobberMinVisibleVp;
  const seen = new Set<string>();
  const victims: string[] = [];
  for (const ci of hex.cornerIndices) {
    const ownerId = state.cornerOwner[ci];
    if (!ownerId || ownerId === actorId || seen.has(ownerId)) continue;
    seen.add(ownerId);
    const owner = state.players.find((p) => p.id === ownerId);
    if (!owner) continue;
    if (sumHand(owner.hand) <= 0) continue;
    if (state.rules.friendlyRobber && owner.visibleVp < minVp) continue;
    victims.push(ownerId);
  }
  return victims;
}

export function getLegalRobberMoves(
  state: ConcreteSimulatedGameState,
  actorId: string
): Array<{ hexIndex: number; eligibleVictimIds: string[] }> {
  const nonCurrentHexes: number[] = [];
  for (let hi = 0; hi < state.topology.hexes.length; hi++) {
    if (hi !== state.robberHexIndex) nonCurrentHexes.push(hi);
  }
  const unrestricted = nonCurrentHexes.filter((hi) => !isHexRestrictedByFriendlyRobber(state, actorId, hi));
  const candidateHexes = unrestricted.length > 0 ? unrestricted : nonCurrentHexes;
  return candidateHexes.map((hexIndex) => ({
    hexIndex,
    eligibleVictimIds: getEligibleRobberVictims(state, actorId, hexIndex)
  }));
}

function enumerateDiscardBags(hand: ResourceHand, targetCount: number): ResourceBag[] {
  if (targetCount <= 0 || sumHand(hand) < targetCount) return [];
  const results: ResourceBag[] = [];
  const current: ResourceHand = emptyHand();

  const walk = (resIdx: number, remaining: number) => {
    if (resIdx === RESOURCES.length - 1) {
      const r = RESOURCES[resIdx];
      if (remaining >= 0 && remaining <= hand[r]) {
        current[r] = remaining;
        const bag: ResourceBag = {};
        for (const k of RESOURCES) {
          if (current[k] > 0) bag[k] = current[k];
        }
        results.push(bag);
      }
      return;
    }
    const r = RESOURCES[resIdx];
    const maxHere = Math.min(hand[r], remaining);
    let maxAfter = 0;
    for (let j = resIdx + 1; j < RESOURCES.length; j++) {
      maxAfter += hand[RESOURCES[j]];
    }
    const minHere = Math.max(0, remaining - maxAfter);
    for (let c = maxHere; c >= minHere; c--) {
      current[r] = c;
      walk(resIdx + 1, remaining - c);
    }
  };

  walk(0, targetCount);
  return results;
}

function enumerateYearOfPlentyPicks(bank: ResourceHand): Array<readonly [Resource] | readonly [Resource, Resource]> {
  const totalBank = sumHand(bank);
  if (totalBank <= 0) return [];
  if (totalBank === 1) {
    const r = RESOURCES.find((res) => bank[res] > 0);
    return r ? [[r]] : [];
  }
  const pairs: Array<readonly [Resource, Resource]> = [];
  for (let i = 0; i < RESOURCES.length; i++) {
    const r1 = RESOURCES[i];
    if (bank[r1] <= 0) continue;
    for (let j = i; j < RESOURCES.length; j++) {
      const r2 = RESOURCES[j];
      if (i === j) {
        if (bank[r1] >= 2) pairs.push([r1, r1]);
      } else if (bank[r2] >= 1) {
        pairs.push([r1, r2]);
      }
    }
  }
  return pairs;
}

function appendLegalDevPlayActions(
  state: ConcreteSimulatedGameState,
  actor: ConcreteSimulatedPlayerState,
  out: SimulatedAction[]
): void {
  if (actor.hasUsedDevThisTurn || actor.readyDevs.length === 0) return;
  const distinctReady = new Set(actor.readyDevs);

  if (distinctReady.has("knight")) {
    out.push({ type: "playKnight" });
  }
  if (distinctReady.has("roadBuilding")) {
    if (actor.roadsLeft > 0 && getLegalRoadEdges(state, actor.id).length > 0) {
      out.push({ type: "playRoadBuilding" });
    }
  }
  if (distinctReady.has("yearOfPlenty")) {
    for (const resources of enumerateYearOfPlentyPicks(state.bank)) {
      out.push({ type: "playYearOfPlenty", resources });
    }
  }
  if (distinctReady.has("monopoly")) {
    for (const resource of RESOURCES) {
      out.push({ type: "playMonopoly", resource });
    }
  }
}

/**
 * Generates all rule-legal actions for `playerId` (or the next required actor when `playerId` is omitted)
 * in the given `ConcreteSimulatedGameState`.
 *
 * Every action returned by `getLegalActions` is guaranteed to be accepted by `applyAction`
 * (when supplied a valid outcome for stochastic `rollDice` or multi-resource `moveRobber` actions).
 */
export function getLegalActions(
  state: ConcreteSimulatedGameState,
  playerId?: string,
  options?: LegalActionOptions
): SimulatedAction[] {
  if (validateSupportedVariantAndRuleset(state.topology, state.players.length, state.rules) !== null) {
    return [];
  }
  if (state.phase === "game_over" || (state.phase as string) === "unknown" || state.phase === "setup_waiting") {
    return [];
  }

  if (state.phase === "discard") {
    let discardActor: ConcreteSimulatedPlayerState | undefined;
    if (playerId !== undefined) {
      discardActor = state.players.find((p) => p.id === playerId);
      if (!discardActor || discardActor.pendingDiscardCount <= 0) return [];
    } else {
      for (let offset = 0; offset < state.players.length; offset++) {
        const candidate = state.players[(state.turnPlayerIndex + offset) % state.players.length];
        if (candidate && candidate.pendingDiscardCount > 0) {
          discardActor = candidate;
          break;
        }
      }
      if (!discardActor) return [];
    }
    return enumerateDiscardBags(discardActor.hand, discardActor.pendingDiscardCount).map((cards) => ({
      type: "discard",
      cards
    }));
  }

  const active = state.players[state.turnPlayerIndex];
  if (!active) return [];
  if (playerId !== undefined && playerId !== active.id) return [];
  const actorId = active.id;

  switch (state.phase) {
    case "setup_settlement": {
      const expectedBefore = state.completedTurns < state.players.length ? 0 : 1;
      const ownedSettlements = state.cornerOwner.reduce(
        (acc, o, idx) => acc + (o === actorId && state.cornerPiece[idx] === 1 ? 1 : 0),
        0
      );
      if (ownedSettlements !== expectedBefore) return [];
      return getLegalSetupSettlementCorners(state, actorId).map((cornerIndex) => ({
        type: "placeSetupSettlement",
        cornerIndex
      }));
    }

    case "setup_road": {
      return getLegalSetupRoadEdges(state, actorId).map((edgeIndex) => ({
        type: "placeSetupRoad",
        edgeIndex
      }));
    }

    case "pre_roll": {
      if (state.dice.thrown) return [];
      const out: SimulatedAction[] = [{ type: "rollDice" }];
      appendLegalDevPlayActions(state, active, out);
      return out;
    }

    case "robber_move": {
      const out: SimulatedAction[] = [];
      for (const move of getLegalRobberMoves(state, actorId)) {
        if (move.eligibleVictimIds.length === 0) {
          out.push({ type: "moveRobber", hexIndex: move.hexIndex, victimId: null });
        } else {
          for (const victimId of move.eligibleVictimIds) {
            out.push({ type: "moveRobber", hexIndex: move.hexIndex, victimId });
          }
        }
      }
      return out;
    }

    case "road_building_1":
    case "road_building_2": {
      return getLegalRoadEdges(state, actorId).map((edgeIndex) => ({
        type: "placeFreeRoad",
        edgeIndex
      }));
    }

    case "year_of_plenty": {
      if (!active.hasUsedDevThisTurn && !active.readyDevs.includes("yearOfPlenty")) return [];
      return enumerateYearOfPlentyPicks(state.bank).map((resources) => ({
        type: "playYearOfPlenty",
        resources
      }));
    }

    case "monopoly": {
      if (!active.hasUsedDevThisTurn && !active.readyDevs.includes("monopoly")) return [];
      return RESOURCES.map((resource) => ({
        type: "playMonopoly",
        resource
      }));
    }

    case "main": {
      if (!state.dice.thrown) return [];
      const out: SimulatedAction[] = [];

      // 1. Development card plays (at most one per turn, only cards in readyDevs)
      appendLegalDevPlayActions(state, active, out);

      // 2. City upgrades (2 grain + 3 ore)
      if (active.citiesLeft > 0 && active.hand.grain >= 2 && active.hand.ore >= 3) {
        for (const cornerIndex of getLegalCityCorners(state, actorId)) {
          out.push({ type: "buildCity", cornerIndex });
        }
      }

      // 3. Settlement builds (1 lumber + 1 brick + 1 wool + 1 grain)
      if (
        active.settlementsLeft > 0 &&
        active.hand.lumber >= 1 &&
        active.hand.brick >= 1 &&
        active.hand.wool >= 1 &&
        active.hand.grain >= 1
      ) {
        for (const cornerIndex of getLegalSettlementCorners(state, actorId)) {
          out.push({ type: "buildSettlement", cornerIndex });
        }
      }

      // 4. Road builds (1 lumber + 1 brick)
      if (active.roadsLeft > 0 && active.hand.lumber >= 1 && active.hand.brick >= 1) {
        for (const edgeIndex of getLegalRoadEdges(state, actorId)) {
          out.push({ type: "buildRoad", edgeIndex });
        }
      }

      // 5. Development card purchase (1 wool + 1 grain + 1 ore, non-empty devDeckOrder)
      if (
        state.devDeckOrder.length > 0 &&
        active.hand.wool >= 1 &&
        active.hand.grain >= 1 &&
        active.hand.ore >= 1
      ) {
        out.push({ type: "buyDevCard" });
      }

      // 6. Maritime / Bank trades (respecting player port ratios and remaining bank supply)
      for (const give of RESOURCES) {
        const rate = active.ratios[give];
        if (rate < 2 || rate > 4 || active.hand[give] < rate) continue;
        for (const receive of RESOURCES) {
          if (receive === give || state.bank[receive] < 1) continue;
          out.push({
            type: "bankTrade",
            give,
            receive,
            giveCount: rate,
            receiveCount: 1
          });
        }
      }

      // 7. Optional 1-for-1 domestic trades between active player and any seated partner
      if (options?.includeDomesticTrades) {
        for (const partner of state.players) {
          if (partner.id === actorId) continue;
          for (const giveRes of RESOURCES) {
            if (active.hand[giveRes] < 1) continue;
            for (const recRes of RESOURCES) {
              if (recRes === giveRes || partner.hand[recRes] < 1) continue;
              out.push({
                type: "playerTrade",
                partnerId: partner.id,
                give: { [giveRes]: 1 },
                receive: { [recRes]: 1 }
              });
            }
          }
        }
      }

      // 8. End turn
      out.push({ type: "endTurn" });
      return out;
    }

    default:
      return [];
  }
}

/**
 * Checks whether a candidate action is legal for `playerId` in `state` (independent of stochastic outcome values).
 */
export function isActionLegal(
  state: ConcreteSimulatedGameState,
  playerId: string,
  action: SimulatedAction
): boolean {
  let dummyOutcome: ActionOutcome | undefined;
  if (action.type === "rollDice" && action.total === undefined && action.d1 === undefined && action.d2 === undefined) {
    dummyOutcome = { dice: { d1: 3, d2: 4, total: 7 } };
  } else if (action.type === "moveRobber" && typeof action.victimId === "string") {
    const victim = state.players.find((p) => p.id === action.victimId);
    const firstRes = victim ? RESOURCES.find((r) => victim.hand[r] > 0) : undefined;
    if (firstRes) dummyOutcome = { stolenResource: firstRes };
  }
  return applyAction(state, playerId, action, dummyOutcome).ok;
}

/**
 * Applies a validated action for `playerId` to a deep clone of `state`, returning either
 * `{ ok: true, state: nextState }` or a structured `{ ok: false, error }` without ever mutating `state`.
 */
export function applyAction(
  state: ConcreteSimulatedGameState,
  playerId: string,
  action: SimulatedAction,
  outcome?: ActionOutcome
): TransitionResult {
  const ctx = { playerId, actionType: action?.type, phase: state?.phase };
  if (!state || state.kind !== "simulated") {
    return fail("invalid_state", "Expected a ConcreteSimulatedGameState (kind === 'simulated').", ctx);
  }
  if (!action || typeof action.type !== "string") {
    return fail("unsupported_action", "Action must be an object with a valid type string.", ctx);
  }

  const variantCheck = validateSupportedVariantAndRuleset(state.topology, state.players.length, state.rules);
  if (variantCheck !== null) return variantCheck;

  if (state.turnPlayerIndex < 0 || state.turnPlayerIndex >= state.players.length) {
    return fail("invalid_state", `Invalid turnPlayerIndex ${state.turnPlayerIndex}.`, ctx);
  }

  if (state.phase === "game_over") {
    return fail("game_already_over", "Cannot apply actions after the game has ended.", ctx);
  }

  if ((state.phase as string) === "unknown" || state.phase === "setup_waiting") {
    return fail(
      "unsupported_phase",
      `Cannot apply actions in unresolved or unsupported phase '${state.phase}'.`,
      ctx
    );
  }

  const actorIndex = state.players.findIndex((p) => p.id === playerId);
  if (actorIndex < 0) {
    return fail("unknown_player", `Player '${playerId}' is not seated in this game.`, ctx);
  }

  // In all phases other than "discard", only the active turn player may act
  if (state.phase !== "discard" && actorIndex !== state.turnPlayerIndex) {
    return fail(
      "not_active_player",
      `Player '${playerId}' is not the active turn player ('${state.players[state.turnPlayerIndex].id}').`,
      ctx
    );
  }

  // Clone before any state mutation so rejected actions can never partially mutate the input state
  const next = cloneConcreteSimState(state);
  const actor = next.players[actorIndex];
  const { topology } = next;

  switch (action.type) {
    case "placeSetupSettlement": {
      if (next.phase !== "setup_settlement") {
        return fail("wrong_phase", `placeSetupSettlement is only legal in 'setup_settlement', not '${next.phase}'.`, ctx);
      }
      const nPlayers = next.players.length;
      if (next.completedTurns < 0 || next.completedTurns >= 2 * nPlayers) {
        return fail("invalid_state", `Setup phase invalid at completedTurns=${next.completedTurns}.`, ctx);
      }
      const expectedBefore = next.completedTurns < nPlayers ? 0 : 1;
      const ownedSettlements = next.cornerOwner.reduce(
        (acc, o, idx) => acc + (o === playerId && next.cornerPiece[idx] === 1 ? 1 : 0),
        0
      );
      if (ownedSettlements !== expectedBefore) {
        return fail(
          "invalid_state",
          `Player '${playerId}' has ${ownedSettlements} setup settlements, expected ${expectedBefore} at completedTurns=${next.completedTurns}.`,
          ctx
        );
      }
      if (actor.settlementsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no settlements left in supply.`, ctx);
      }
      const { cornerIndex } = action;
      if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex >= topology.corners.length) {
        return fail("invalid_topology_index", `Invalid cornerIndex ${cornerIndex}.`, ctx);
      }
      if (next.cornerPiece[cornerIndex] !== 0) {
        return fail("occupied_corner", `Corner ${cornerIndex} is already occupied.`, ctx);
      }
      if (!isCornerDistanceLegal(next, cornerIndex)) {
        return fail("distance_rule_violation", `Corner ${cornerIndex} violates the settlement distance rule.`, ctx);
      }

      next.cornerOwner[cornerIndex] = playerId;
      next.cornerPiece[cornerIndex] = 1;
      actor.settlementsLeft -= 1;
      applyPortRatioToPlayer(actor, topology, cornerIndex);

      // Second setup settlement grants 1 resource from the bank for each adjacent non-desert hex
      if (expectedBefore === 1) {
        for (const hi of topology.corners[cornerIndex].hexIndices) {
          const res = topology.hexes[hi].resource;
          if (res !== null && next.bank[res] > 0) {
            next.bank[res] -= 1;
            actor.hand[res] += 1;
          }
        }
      }

      next.pendingSetupCornerIndex = cornerIndex;
      updateLongestRoadAward(next);
      next.phase = "setup_road";
      return { ok: true, state: next };
    }

    case "placeSetupRoad": {
      if (next.phase !== "setup_road") {
        return fail("wrong_phase", `placeSetupRoad is only legal in 'setup_road', not '${next.phase}'.`, ctx);
      }
      const nPlayers = next.players.length;
      if (next.completedTurns < 0 || next.completedTurns >= 2 * nPlayers) {
        return fail("invalid_state", `Setup phase invalid at completedTurns=${next.completedTurns}.`, ctx);
      }
      if (actor.roadsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no roads left in supply.`, ctx);
      }
      const { edgeIndex } = action;
      if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= topology.edges.length) {
        return fail("invalid_topology_index", `Invalid edgeIndex ${edgeIndex}.`, ctx);
      }
      if (next.edgeOwner[edgeIndex] !== null) {
        return fail("occupied_edge", `Edge ${edgeIndex} is already occupied.`, ctx);
      }

      const anchorCorner = resolvePendingSetupCornerIndex(next, playerId);
      if (anchorCorner === undefined) {
        return fail("invalid_state", `Could not resolve the newly placed setup settlement for '${playerId}'.`, ctx);
      }
      const edge = topology.edges[edgeIndex];
      if (edge.c1 !== anchorCorner && edge.c2 !== anchorCorner) {
        return fail(
          "unconnected_road",
          `Setup road on edge ${edgeIndex} must attach to the newly placed settlement at corner ${anchorCorner}.`,
          ctx
        );
      }

      next.edgeOwner[edgeIndex] = playerId;
      actor.roadsLeft -= 1;
      next.pendingSetupCornerIndex = undefined;
      updateLongestRoadAward(next);

      const nextCompletedTurns = next.completedTurns + 1;
      next.completedTurns = nextCompletedTurns;
      if (nextCompletedTurns < nPlayers) {
        next.turnPlayerIndex = nextCompletedTurns;
        next.phase = "setup_settlement";
      } else if (nextCompletedTurns < 2 * nPlayers) {
        next.turnPlayerIndex = 2 * nPlayers - 1 - nextCompletedTurns;
        next.phase = "setup_settlement";
      } else {
        next.turnPlayerIndex = 0;
        next.phase = "pre_roll";
        next.dice = { thrown: false };
      }
      return { ok: true, state: next };
    }

    case "rollDice": {
      if (next.phase !== "pre_roll" || next.dice.thrown) {
        return fail("wrong_phase", `rollDice is only legal in 'pre_roll' before dice are thrown.`, ctx);
      }
      const d1 = action.d1 ?? outcome?.dice?.d1;
      const d2 = action.d2 ?? outcome?.dice?.d2;
      const rawTotal = action.total ?? outcome?.dice?.total;

      let total: number;
      if (d1 !== undefined || d2 !== undefined) {
        if (
          d1 === undefined ||
          d2 === undefined ||
          !Number.isInteger(d1) ||
          !Number.isInteger(d2) ||
          d1 < 1 ||
          d1 > 6 ||
          d2 < 1 ||
          d2 > 6
        ) {
          return fail("invalid_outcome", `Invalid individual dice values d1=${d1}, d2=${d2}. Must be integers in 1..6.`, ctx);
        }
        if (rawTotal !== undefined && rawTotal !== d1 + d2) {
          return fail("invalid_outcome", `Dice total=${rawTotal} does not match d1 + d2 (${d1} + ${d2} = ${d1 + d2}).`, ctx);
        }
        total = d1 + d2;
      } else if (rawTotal !== undefined) {
        if (!Number.isInteger(rawTotal) || rawTotal < 2 || rawTotal > 12) {
          return fail("invalid_outcome", `Invalid dice total=${rawTotal}. Must be an integer in 2..12.`, ctx);
        }
        total = rawTotal;
      } else {
        return fail("missing_outcome", "rollDice requires an explicit dice outcome (d1/d2 or total).", ctx);
      }

      next.dice = {
        thrown: true,
        ...(d1 !== undefined ? { d1 } : {}),
        ...(d2 !== undefined ? { d2 } : {}),
        total
      };

      if (total === 7) {
        let anyDiscardRequired = false;
        for (const p of next.players) {
          const sz = sumHand(p.hand);
          if (sz > next.rules.cardDiscardLimit) {
            p.pendingDiscardCount = Math.floor(sz / 2);
            if (p.pendingDiscardCount > 0) anyDiscardRequired = true;
          } else {
            p.pendingDiscardCount = 0;
          }
        }
        next.phase = anyDiscardRequired ? "discard" : "robber_move";
        return { ok: true, state: next };
      }

      // Resource production for roll !== 7
      // Only the hex at next.robberHexIndex is blocked; other hexes sharing the same dice number produce normally.
      const matchingHexIndices = topology.hexIndicesByDiceNumber.get(total) ?? [];
      for (const r of RESOURCES) {
        const owedByPlayer = new Array<number>(next.players.length).fill(0);
        for (const hi of matchingHexIndices) {
          if (hi === next.robberHexIndex) continue;
          const hex = topology.hexes[hi];
          if (hex.resource !== r) continue;
          for (const ci of hex.cornerIndices) {
            const ownerId = next.cornerOwner[ci];
            if (!ownerId) continue;
            const pIdx = next.players.findIndex((p) => p.id === ownerId);
            if (pIdx < 0) continue;
            const amount = next.cornerPiece[ci] === 2 ? 2 : 1;
            owedByPlayer[pIdx] += amount;
          }
        }

        const totalOwed = owedByPlayer.reduce((a, b) => a + b, 0);
        if (totalOwed === 0) continue;

        const claimants = owedByPlayer
          .map((amt, pIdx) => ({ pIdx, amt }))
          .filter((x) => x.amt > 0);

        if (totalOwed <= next.bank[r]) {
          for (const { pIdx, amt } of claimants) {
            next.players[pIdx].hand[r] += amt;
          }
          next.bank[r] -= totalOwed;
        } else if (claimants.length === 1) {
          // Catan Almanac bank shortage rule: if only a single player is owed resource r,
          // that player receives all remaining copies of r in the bank.
          const available = next.bank[r];
          next.players[claimants[0].pIdx].hand[r] += available;
          next.bank[r] = 0;
        }
        // If claimants.length > 1 and totalOwed > next.bank[r], no player receives resource r on this roll.
      }

      next.phase = "main";
      return { ok: true, state: next };
    }

    case "discard": {
      if (next.phase !== "discard") {
        return fail("wrong_phase", `discard is only legal in 'discard' phase, not '${next.phase}'.`, ctx);
      }
      if (actor.pendingDiscardCount <= 0) {
        return fail("no_discard_required", `Player '${playerId}' does not have a pending discard.`, ctx);
      }
      if (!action.cards || typeof action.cards !== "object") {
        return fail("invalid_discard", "Discard action requires a valid cards resource bag.", ctx);
      }
      let totalDiscarded = 0;
      for (const [k, rawVal] of Object.entries(action.cards)) {
        if (!isResource(k)) {
          return fail("invalid_discard", `Unknown resource '${k}' in discard bag.`, ctx);
        }
        if (rawVal === undefined) continue;
        if (!Number.isInteger(rawVal) || rawVal < 0) {
          return fail("invalid_discard", `Invalid discard count ${rawVal} for '${k}'.`, ctx);
        }
        if (rawVal > actor.hand[k]) {
          return fail(
            "insufficient_resources",
            `Player '${playerId}' cannot discard ${rawVal} ${k} (only holds ${actor.hand[k]}).`,
            ctx
          );
        }
        totalDiscarded += rawVal;
      }
      if (totalDiscarded !== actor.pendingDiscardCount) {
        return fail(
          "invalid_discard",
          `Player '${playerId}' must discard exactly ${actor.pendingDiscardCount} cards, got ${totalDiscarded}.`,
          ctx
        );
      }

      for (const r of RESOURCES) {
        const amt = action.cards[r] ?? 0;
        if (amt > 0) {
          actor.hand[r] -= amt;
          next.bank[r] += amt;
        }
      }
      actor.pendingDiscardCount = 0;

      if (next.players.every((p) => p.pendingDiscardCount === 0)) {
        next.phase = "robber_move";
      }
      return { ok: true, state: next };
    }

    case "moveRobber": {
      if (next.phase !== "robber_move") {
        return fail("wrong_phase", `moveRobber is only legal in 'robber_move' phase, not '${next.phase}'.`, ctx);
      }
      const { hexIndex, victimId } = action;
      if (!Number.isInteger(hexIndex) || hexIndex < 0 || hexIndex >= topology.hexes.length) {
        return fail("invalid_topology_index", `Invalid robber hexIndex ${hexIndex}.`, ctx);
      }
      if (hexIndex === next.robberHexIndex) {
        return fail("robber_must_move", `Robber must be moved to a different hex than ${hexIndex}.`, ctx);
      }

      // Friendly Robber check using observable visibleVp (never opponent hidden VP cards)
      if (isHexRestrictedByFriendlyRobber(next, playerId, hexIndex)) {
        const hasAnyUnrestricted = topology.hexes.some(
          (h) => h.index !== next.robberHexIndex && !isHexRestrictedByFriendlyRobber(next, playerId, h.index)
        );
        if (hasAnyUnrestricted) {
          return fail(
            "friendly_robber_restriction",
            `Friendly Robber forbids moving the robber to hex ${hexIndex} because an adjacent opponent has fewer than ${next.rules.friendlyRobberMinVisibleVp} visible VP.`,
            ctx
          );
        }
      }

      const eligibleVictims = getEligibleRobberVictims(next, playerId, hexIndex);
      if (eligibleVictims.length === 0) {
        if (victimId !== undefined && victimId !== null) {
          return fail(
            "invalid_robber_victim",
            `Player '${victimId}' is not an eligible victim on hex ${hexIndex} (no eligible victims exist).`,
            ctx
          );
        }
        if (outcome?.stolenResource !== undefined) {
          return fail("invalid_outcome", "stolenResource outcome must not be supplied when no victim is robbed.", ctx);
        }
      } else {
        let resolvedVictimId: string | undefined;
        if (victimId === null) {
          return fail(
            "invalid_robber_victim",
            `Must select one of the eligible victims (${eligibleVictims.join(", ")}) on hex ${hexIndex}.`,
            ctx
          );
        } else if (victimId === undefined) {
          if (eligibleVictims.length === 1) {
            resolvedVictimId = eligibleVictims[0];
          } else {
            return fail(
              "invalid_robber_victim",
              `Multiple eligible victims (${eligibleVictims.join(", ")}) exist on hex ${hexIndex}; victimId must be specified.`,
              ctx
            );
          }
        } else {
          if (!eligibleVictims.includes(victimId)) {
            return fail(
              "invalid_robber_victim",
              `Player '${victimId}' is not an eligible robber victim on hex ${hexIndex}. Eligible: [${eligibleVictims.join(", ")}].`,
              ctx
            );
          }
          resolvedVictimId = victimId;
        }

        const victim = next.players.find((p) => p.id === resolvedVictimId)!;
        const availableResources = RESOURCES.filter((r) => victim.hand[r] > 0);
        let stolenRes: Resource;
        if (outcome?.stolenResource !== undefined) {
          if (!isResource(outcome.stolenResource) || victim.hand[outcome.stolenResource] <= 0) {
            return fail(
              "invalid_outcome",
              `Victim '${victim.id}' does not hold any '${outcome.stolenResource}' to steal.`,
              ctx
            );
          }
          stolenRes = outcome.stolenResource;
        } else if (availableResources.length === 1) {
          stolenRes = availableResources[0];
        } else {
          return fail(
            "missing_outcome",
            `Victim '${victim.id}' holds multiple distinct resource types (${availableResources.join(", ")}); outcome.stolenResource must be supplied.`,
            ctx
          );
        }

        victim.hand[stolenRes] -= 1;
        actor.hand[stolenRes] += 1;
      }

      next.robberHexIndex = hexIndex;
      if (!checkActivePlayerVictory(next)) {
        next.phase = next.dice.thrown ? "main" : "pre_roll";
      }
      return { ok: true, state: next };
    }

    case "buildRoad": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `buildRoad is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      const { edgeIndex } = action;
      if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= topology.edges.length) {
        return fail("invalid_topology_index", `Invalid edgeIndex ${edgeIndex}.`, ctx);
      }
      if (next.edgeOwner[edgeIndex] !== null) {
        return fail("occupied_edge", `Edge ${edgeIndex} is already occupied.`, ctx);
      }
      if (actor.roadsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no roads left in supply.`, ctx);
      }
      if (actor.hand.lumber < 1 || actor.hand.brick < 1) {
        return fail("insufficient_resources", `Player '${playerId}' lacks 1 lumber + 1 brick to build a road.`, ctx);
      }
      const conn = classifyRoadConnectivity(next, playerId, edgeIndex);
      if (conn === "blocked_by_opponent_building") {
        return fail(
          "blocked_by_opponent_building",
          `Cannot build road on edge ${edgeIndex}: connection is blocked by an opponent's settlement or city.`,
          ctx
        );
      }
      if (conn !== "ok") {
        return fail("unconnected_road", `Edge ${edgeIndex} does not connect to '${playerId}'s road or building network.`, ctx);
      }

      actor.hand.lumber -= 1;
      actor.hand.brick -= 1;
      next.bank.lumber += 1;
      next.bank.brick += 1;
      next.edgeOwner[edgeIndex] = playerId;
      actor.roadsLeft -= 1;

      updateLongestRoadAward(next);
      checkActivePlayerVictory(next);
      return { ok: true, state: next };
    }

    case "buildSettlement": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `buildSettlement is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      const { cornerIndex } = action;
      if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex >= topology.corners.length) {
        return fail("invalid_topology_index", `Invalid cornerIndex ${cornerIndex}.`, ctx);
      }
      if (next.cornerPiece[cornerIndex] !== 0) {
        return fail("occupied_corner", `Corner ${cornerIndex} is already occupied.`, ctx);
      }
      if (!isCornerDistanceLegal(next, cornerIndex)) {
        return fail("distance_rule_violation", `Corner ${cornerIndex} violates the settlement distance rule.`, ctx);
      }
      const connectedToOwnRoad = topology.corners[cornerIndex].incidentEdgeIndices.some(
        (ei) => next.edgeOwner[ei] === playerId
      );
      if (!connectedToOwnRoad) {
        return fail(
          "unconnected_settlement",
          `Corner ${cornerIndex} is not connected to any road owned by '${playerId}'.`,
          ctx
        );
      }
      if (actor.settlementsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no settlements left in supply.`, ctx);
      }
      if (actor.hand.lumber < 1 || actor.hand.brick < 1 || actor.hand.wool < 1 || actor.hand.grain < 1) {
        return fail(
          "insufficient_resources",
          `Player '${playerId}' lacks 1 lumber + 1 brick + 1 wool + 1 grain to build a settlement.`,
          ctx
        );
      }

      actor.hand.lumber -= 1;
      actor.hand.brick -= 1;
      actor.hand.wool -= 1;
      actor.hand.grain -= 1;
      next.bank.lumber += 1;
      next.bank.brick += 1;
      next.bank.wool += 1;
      next.bank.grain += 1;

      next.cornerOwner[cornerIndex] = playerId;
      next.cornerPiece[cornerIndex] = 1;
      actor.settlementsLeft -= 1;
      applyPortRatioToPlayer(actor, topology, cornerIndex);

      // Recompute road lengths for all players because this settlement may split an opponent's road network
      updateLongestRoadAward(next);
      checkActivePlayerVictory(next);
      return { ok: true, state: next };
    }

    case "buildCity": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `buildCity is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      const { cornerIndex } = action;
      if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex >= topology.corners.length) {
        return fail("invalid_topology_index", `Invalid cornerIndex ${cornerIndex}.`, ctx);
      }
      if (next.cornerOwner[cornerIndex] !== playerId || next.cornerPiece[cornerIndex] !== 1) {
        return fail(
          "invalid_city_upgrade",
          `Corner ${cornerIndex} does not contain a settlement owned by '${playerId}'.`,
          ctx
        );
      }
      if (actor.citiesLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no cities left in supply.`, ctx);
      }
      if (actor.hand.grain < 2 || actor.hand.ore < 3) {
        return fail("insufficient_resources", `Player '${playerId}' lacks 2 grain + 3 ore to build a city.`, ctx);
      }

      actor.hand.grain -= 2;
      actor.hand.ore -= 3;
      next.bank.grain += 2;
      next.bank.ore += 3;

      next.cornerPiece[cornerIndex] = 2;
      actor.citiesLeft -= 1;
      const maxSettlements = next.rules.maxSettlementsPerPlayer ?? MAX_SETTLEMENTS;
      actor.settlementsLeft = Math.min(maxSettlements, actor.settlementsLeft + 1);

      recomputePlayerVp(next);
      checkActivePlayerVictory(next);
      return { ok: true, state: next };
    }

    case "buyDevCard": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `buyDevCard is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      if (next.devDeckOrder.length === 0) {
        return fail("empty_dev_deck", "Cannot buy a development card: the development deck is empty.", ctx);
      }
      if (actor.hand.wool < 1 || actor.hand.grain < 1 || actor.hand.ore < 1) {
        return fail("insufficient_resources", `Player '${playerId}' lacks 1 wool + 1 grain + 1 ore to buy a dev card.`, ctx);
      }

      let drawn: ConcreteDevCardKind;
      if (outcome?.drawnDevCard !== undefined) {
        const idx = next.devDeckOrder.indexOf(outcome.drawnDevCard);
        if (idx < 0) {
          return fail(
            "invalid_outcome",
            `Specified drawnDevCard '${outcome.drawnDevCard}' is not remaining in devDeckOrder.`,
            ctx
          );
        }
        [drawn] = next.devDeckOrder.splice(idx, 1);
      } else {
        drawn = next.devDeckOrder.shift()!;
      }

      actor.hand.wool -= 1;
      actor.hand.grain -= 1;
      actor.hand.ore -= 1;
      next.bank.wool += 1;
      next.bank.grain += 1;
      next.bank.ore += 1;

      if (drawn === "victoryPoint") {
        actor.vpDevs += 1;
        recomputePlayerVp(next);
        checkActivePlayerVictory(next);
      } else {
        actor.boughtDevsThisTurn.push(drawn);
      }
      return { ok: true, state: next };
    }

    case "playKnight": {
      if (next.phase !== "pre_roll" && next.phase !== "main") {
        return fail("wrong_phase", `playKnight is only legal in 'pre_roll' or 'main', not '${next.phase}'.`, ctx);
      }
      if (actor.hasUsedDevThisTurn) {
        return fail("dev_card_already_played_this_turn", `Player '${playerId}' has already played a development card this turn.`, ctx);
      }
      const readyIdx = actor.readyDevs.indexOf("knight");
      if (readyIdx < 0) {
        if (actor.boughtDevsThisTurn.includes("knight")) {
          return fail("dev_card_bought_this_turn", "Cannot play a Knight bought on the current turn.", ctx);
        }
        return fail("dev_card_not_available", `Player '${playerId}' does not have a playable Knight card.`, ctx);
      }

      actor.readyDevs.splice(readyIdx, 1);
      actor.playedDevs.push("knight");
      actor.hasUsedDevThisTurn = true;
      actor.knightsPlayed += 1;

      updateLargestArmyAward(next);
      if (!checkActivePlayerVictory(next)) {
        next.phase = "robber_move";
      }
      return { ok: true, state: next };
    }

    case "playRoadBuilding": {
      if (next.phase !== "pre_roll" && next.phase !== "main") {
        return fail("wrong_phase", `playRoadBuilding is only legal in 'pre_roll' or 'main', not '${next.phase}'.`, ctx);
      }
      if (actor.hasUsedDevThisTurn) {
        return fail("dev_card_already_played_this_turn", `Player '${playerId}' has already played a development card this turn.`, ctx);
      }
      const readyIdx = actor.readyDevs.indexOf("roadBuilding");
      if (readyIdx < 0) {
        if (actor.boughtDevsThisTurn.includes("roadBuilding")) {
          return fail("dev_card_bought_this_turn", "Cannot play a Road Building card bought on the current turn.", ctx);
        }
        return fail("dev_card_not_available", `Player '${playerId}' does not have a playable Road Building card.`, ctx);
      }
      if (actor.roadsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no roads left in supply for Road Building.`, ctx);
      }
      if (getLegalRoadEdges(next, playerId).length === 0) {
        return fail("unconnected_road", `Player '${playerId}' has no legal road placements available for Road Building.`, ctx);
      }

      actor.readyDevs.splice(readyIdx, 1);
      actor.playedDevs.push("roadBuilding");
      actor.hasUsedDevThisTurn = true;
      next.phase = "road_building_1";
      return { ok: true, state: next };
    }

    case "placeFreeRoad": {
      if (next.phase !== "road_building_1" && next.phase !== "road_building_2") {
        return fail(
          "wrong_phase",
          `placeFreeRoad is only legal in 'road_building_1' or 'road_building_2', not '${next.phase}'.`,
          ctx
        );
      }
      const { edgeIndex } = action;
      if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= topology.edges.length) {
        return fail("invalid_topology_index", `Invalid edgeIndex ${edgeIndex}.`, ctx);
      }
      if (next.edgeOwner[edgeIndex] !== null) {
        return fail("occupied_edge", `Edge ${edgeIndex} is already occupied.`, ctx);
      }
      if (actor.roadsLeft <= 0) {
        return fail("insufficient_piece_supply", `Player '${playerId}' has no roads left in supply.`, ctx);
      }
      const conn = classifyRoadConnectivity(next, playerId, edgeIndex);
      if (conn === "blocked_by_opponent_building") {
        return fail(
          "blocked_by_opponent_building",
          `Cannot place free road on edge ${edgeIndex}: connection is blocked by an opponent's building.`,
          ctx
        );
      }
      if (conn !== "ok") {
        return fail("unconnected_road", `Edge ${edgeIndex} does not connect to '${playerId}'s road or building network.`, ctx);
      }

      const wasFirstFreeRoad = next.phase === "road_building_1";
      next.edgeOwner[edgeIndex] = playerId;
      actor.roadsLeft -= 1;

      updateLongestRoadAward(next);
      if (checkActivePlayerVictory(next)) {
        return { ok: true, state: next };
      }

      if (wasFirstFreeRoad && actor.roadsLeft > 0 && getLegalRoadEdges(next, playerId).length > 0) {
        next.phase = "road_building_2";
      } else {
        next.phase = next.dice.thrown ? "main" : "pre_roll";
      }
      return { ok: true, state: next };
    }

    case "playYearOfPlenty": {
      if (next.phase !== "pre_roll" && next.phase !== "main" && next.phase !== "year_of_plenty") {
        return fail(
          "wrong_phase",
          `playYearOfPlenty is only legal in 'pre_roll', 'main', or 'year_of_plenty', not '${next.phase}'.`,
          ctx
        );
      }
      const alreadyConsumedInSubphase =
        next.phase === "year_of_plenty" &&
        actor.hasUsedDevThisTurn &&
        actor.playedDevs[actor.playedDevs.length - 1] === "yearOfPlenty";

      if (!alreadyConsumedInSubphase) {
        if (actor.hasUsedDevThisTurn) {
          return fail(
            "dev_card_already_played_this_turn",
            `Player '${playerId}' has already played a development card this turn.`,
            ctx
          );
        }
        const readyIdx = actor.readyDevs.indexOf("yearOfPlenty");
        if (readyIdx < 0) {
          if (actor.boughtDevsThisTurn.includes("yearOfPlenty")) {
            return fail("dev_card_bought_this_turn", "Cannot play a Year of Plenty card bought on the current turn.", ctx);
          }
          return fail("dev_card_not_available", `Player '${playerId}' does not have a playable Year of Plenty card.`, ctx);
        }
        actor.readyDevs.splice(readyIdx, 1);
        actor.playedDevs.push("yearOfPlenty");
        actor.hasUsedDevThisTurn = true;
      }

      if (!Array.isArray(action.resources) || (action.resources.length !== 1 && action.resources.length !== 2)) {
        return fail("invalid_outcome", "Year of Plenty requires 1 or 2 target resources.", ctx);
      }
      for (const r of action.resources) {
        if (!isResource(r)) {
          return fail("invalid_outcome", `Invalid resource '${String(r)}' in Year of Plenty.`, ctx);
        }
      }

      const totalBank = sumHand(next.bank);
      if (totalBank <= 0) {
        return fail("insufficient_bank_resources", "Cannot play Year of Plenty: the bank has 0 resource cards remaining.", ctx);
      }
      const expectedPickCount = Math.min(2, totalBank);
      if (action.resources.length !== expectedPickCount) {
        return fail(
          "insufficient_bank_resources",
          `Year of Plenty must request ${expectedPickCount} resource(s) when bank has ${totalBank} total card(s) left, got ${action.resources.length}.`,
          ctx
        );
      }

      const req = emptyHand();
      for (const r of action.resources) req[r] += 1;
      for (const r of RESOURCES) {
        if (req[r] > next.bank[r]) {
          return fail(
            "insufficient_bank_resources",
            `Bank only has ${next.bank[r]} '${r}', cannot take ${req[r]} via Year of Plenty.`,
            ctx
          );
        }
      }

      for (const r of RESOURCES) {
        if (req[r] > 0) {
          next.bank[r] -= req[r];
          actor.hand[r] += req[r];
        }
      }

      next.phase = next.dice.thrown ? "main" : "pre_roll";
      return { ok: true, state: next };
    }

    case "playMonopoly": {
      if (next.phase !== "pre_roll" && next.phase !== "main" && next.phase !== "monopoly") {
        return fail(
          "wrong_phase",
          `playMonopoly is only legal in 'pre_roll', 'main', or 'monopoly', not '${next.phase}'.`,
          ctx
        );
      }
      if (!isResource(action.resource)) {
        return fail("invalid_outcome", `Invalid Monopoly resource '${String(action.resource)}'.`, ctx);
      }
      const alreadyConsumedInSubphase =
        next.phase === "monopoly" &&
        actor.hasUsedDevThisTurn &&
        actor.playedDevs[actor.playedDevs.length - 1] === "monopoly";

      if (!alreadyConsumedInSubphase) {
        if (actor.hasUsedDevThisTurn) {
          return fail(
            "dev_card_already_played_this_turn",
            `Player '${playerId}' has already played a development card this turn.`,
            ctx
          );
        }
        const readyIdx = actor.readyDevs.indexOf("monopoly");
        if (readyIdx < 0) {
          if (actor.boughtDevsThisTurn.includes("monopoly")) {
            return fail("dev_card_bought_this_turn", "Cannot play a Monopoly card bought on the current turn.", ctx);
          }
          return fail("dev_card_not_available", `Player '${playerId}' does not have a playable Monopoly card.`, ctx);
        }
        actor.readyDevs.splice(readyIdx, 1);
        actor.playedDevs.push("monopoly");
        actor.hasUsedDevThisTurn = true;
      }

      const targetRes = action.resource;
      for (const other of next.players) {
        if (other.id === playerId) continue;
        const taken = other.hand[targetRes];
        if (taken > 0) {
          other.hand[targetRes] = 0;
          actor.hand[targetRes] += taken;
        }
      }

      next.phase = next.dice.thrown ? "main" : "pre_roll";
      return { ok: true, state: next };
    }

    case "bankTrade": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `bankTrade is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      const { give, receive } = action;
      if (!isResource(give) || !isResource(receive) || give === receive) {
        return fail("invalid_trade", `Invalid bankTrade resources give='${String(give)}', receive='${String(receive)}'.`, ctx);
      }
      const receiveCount = action.receiveCount ?? 1;
      if (!Number.isInteger(receiveCount) || receiveCount < 1) {
        return fail("invalid_trade", `Invalid bankTrade receiveCount=${receiveCount}.`, ctx);
      }
      const rate = actor.ratios[give];
      if (!Number.isInteger(rate) || rate < 2 || rate > 4) {
        return fail("invalid_trade", `Invalid trade ratio ${rate} for '${give}'.`, ctx);
      }
      const expectedGiveCount = rate * receiveCount;
      if (action.giveCount !== undefined && action.giveCount !== expectedGiveCount) {
        return fail(
          "invalid_trade",
          `Player '${playerId}' trades '${give}' at ${rate}:1 (expected giveCount=${expectedGiveCount}, got ${action.giveCount}).`,
          ctx
        );
      }
      if (actor.hand[give] < expectedGiveCount) {
        return fail(
          "insufficient_resources",
          `Player '${playerId}' needs ${expectedGiveCount} '${give}' for bank trade, only holds ${actor.hand[give]}.`,
          ctx
        );
      }
      if (next.bank[receive] < receiveCount) {
        return fail(
          "insufficient_bank_resources",
          `Bank only has ${next.bank[receive]} '${receive}', cannot supply ${receiveCount}.`,
          ctx
        );
      }

      actor.hand[give] -= expectedGiveCount;
      next.bank[give] += expectedGiveCount;
      next.bank[receive] -= receiveCount;
      actor.hand[receive] += receiveCount;
      return { ok: true, state: next };
    }

    case "playerTrade": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `playerTrade is only legal in 'main' phase, not '${next.phase}'.`, ctx);
      }
      const { partnerId, give, receive } = action;
      if (!partnerId || partnerId === playerId) {
        return fail("invalid_trade", "Domestic trade requires a distinct seated partnerId.", ctx);
      }
      const partner = next.players.find((p) => p.id === partnerId);
      if (!partner) {
        return fail("unknown_player", `Trade partner '${partnerId}' is not seated in this game.`, ctx);
      }
      if (!give || typeof give !== "object" || !receive || typeof receive !== "object") {
        return fail("invalid_trade", "Domestic trade requires valid give and receive resource bags.", ctx);
      }

      let totalGive = 0;
      let totalReceive = 0;
      for (const [k, v] of Object.entries(give)) {
        if (!isResource(k)) return fail("invalid_trade", `Unknown resource '${k}' in give bag.`, ctx);
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v < 0) return fail("invalid_trade", `Invalid give count ${v} for '${k}'.`, ctx);
        totalGive += v;
      }
      for (const [k, v] of Object.entries(receive)) {
        if (!isResource(k)) return fail("invalid_trade", `Unknown resource '${k}' in receive bag.`, ctx);
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v < 0) return fail("invalid_trade", `Invalid receive count ${v} for '${k}'.`, ctx);
        totalReceive += v;
      }
      if (totalGive <= 0 || totalReceive <= 0) {
        return fail("invalid_trade", "Domestic trade must exchange at least 1 card from each player.", ctx);
      }

      for (const r of RESOURCES) {
        const g = give[r] ?? 0;
        const rec = receive[r] ?? 0;
        if (g > 0 && rec > 0) {
          return fail("invalid_trade", `Domestic trade cannot exchange identical resource '${r}' on both sides.`, ctx);
        }
        if (actor.hand[r] < g) {
          return fail(
            "insufficient_resources",
            `Player '${playerId}' lacks ${g} '${r}' to give in trade (holds ${actor.hand[r]}).`,
            ctx
          );
        }
        if (partner.hand[r] < rec) {
          return fail(
            "insufficient_resources",
            `Partner '${partnerId}' lacks ${rec} '${r}' to supply in trade (holds ${partner.hand[r]}).`,
            ctx
          );
        }
      }

      for (const r of RESOURCES) {
        const g = give[r] ?? 0;
        const rec = receive[r] ?? 0;
        if (g > 0 || rec > 0) {
          actor.hand[r] = actor.hand[r] - g + rec;
          partner.hand[r] = partner.hand[r] + g - rec;
        }
      }
      return { ok: true, state: next };
    }

    case "endTurn": {
      if (next.phase !== "main" || !next.dice.thrown) {
        return fail("wrong_phase", `endTurn is only legal in 'main' phase after rolling dice.`, ctx);
      }
      for (const p of next.players) {
        if (p.boughtDevsThisTurn.length > 0) {
          p.readyDevs.push(...p.boughtDevsThisTurn);
          p.boughtDevsThisTurn = [];
        }
        p.hasUsedDevThisTurn = false;
        p.pendingDiscardCount = 0;
      }

      next.completedTurns += 1;
      next.turnPlayerIndex = (next.turnPlayerIndex + 1) % next.players.length;
      next.dice = { thrown: false };

      if (!checkActivePlayerVictory(next)) {
        next.phase = "pre_roll";
      }
      return { ok: true, state: next };
    }

    default: {
      return fail("unsupported_action", `Unsupported action type '${String((action as { type?: unknown }).type)}'.`, ctx);
    }
  }
}

/**
 * Materializes a `ConcreteSimulatedGameState` from an `ObservedGameState` ONLY when
 * all hidden information and phase ambiguities are either already authoritative or explicitly
 * provided via `determinization`.
 *
 * Strictly enforces the 3-way epistemic boundary:
 * - Never mutates `observed`.
 * - Never silently promotes a `HandTracker` or `TableRead` inference (`hand.exact === null`) into a concrete hand.
 * - Fails closed (`code: "missing_outcome"` or `"unsupported_phase"`) if any opponent hand, face-down dev card,
 *   remaining dev deck order, robber location, or turn phase is unresolved.
 */
export function materializeConcreteState(
  observed: ObservedGameState,
  determinization?: ConcreteDeterminizationInput
): TransitionResult {
  const rules: ConcreteSimulatedGameState["rules"] = {
    victoryPointsToWin: observed.rules.victoryPointsToWin.value,
    cardDiscardLimit: observed.rules.cardDiscardLimit.value,
    friendlyRobber: observed.rules.friendlyRobber.value,
    friendlyRobberMinVisibleVp: observed.rules.friendlyRobber.minVisibleVp,
    diceMode: observed.rules.diceMode.mode === "random" ? "random" : "balanced",
    maxPlayers: observed.rules.maxPlayers.value,
    bankResourceCap: BANK_RESOURCE_CAP,
    maxSettlementsPerPlayer: MAX_SETTLEMENTS,
    maxCitiesPerPlayer: MAX_CITIES,
    maxRoadsPerPlayer: MAX_ROADS,
    devDeckComposition: { ...STANDARD_DEV_DECK_COUNTS },
    ...(observed.rules.extensionSetting !== undefined ? { extensionSetting: observed.rules.extensionSetting } : {}),
    ...(observed.rules.mapSetting !== undefined ? { mapSetting: observed.rules.mapSetting } : {})
  };

  const variantCheck = validateSupportedVariantAndRuleset(observed.topology, observed.players.length, rules);
  if (variantCheck !== null) return variantCheck;

  const phase = determinization?.phase ?? (observed.phase !== "unknown" ? observed.phase : undefined);
  if (!phase || phase === "setup_waiting") {
    return fail(
      "unsupported_phase",
      `Cannot materialize ConcreteSimulatedGameState with unresolved or unsupported phase '${observed.phase}'.`
    );
  }

  const turnPlayerId = determinization?.turnPlayerId ?? observed.turnPlayerId;
  const turnPlayerIndex = turnPlayerId ? observed.playerOrder.indexOf(turnPlayerId) : -1;
  if (turnPlayerIndex < 0) {
    return fail("invalid_state", "Cannot materialize ConcreteSimulatedGameState without a valid turnPlayerId.");
  }

  const robberHexIndex = determinization?.robberHexIndex ?? observed.robberHexIndex;
  if (robberHexIndex === null || robberHexIndex < 0 || robberHexIndex >= observed.topology.hexes.length) {
    return fail("invalid_state", "Cannot materialize ConcreteSimulatedGameState without a valid robberHexIndex.");
  }

  const concretePlayers: ConcreteSimulatedPlayerState[] = [];
  for (const op of observed.players) {
    const explicitHand = determinization?.handsByPlayerId?.[op.id];
    let concreteHand: ResourceHand;
    if (explicitHand) {
      concreteHand = { ...explicitHand };
      if (sumHand(concreteHand) !== op.hand.handSize) {
        return fail(
          "invalid_outcome",
          `Explicit hand for player '${op.id}' sums to ${sumHand(concreteHand)}, expected handSize=${op.hand.handSize}.`,
          { playerId: op.id }
        );
      }
    } else if (op.hand.exact !== null && op.hand.inferenceSource === "authoritative") {
      concreteHand = { ...op.hand.exact };
    } else {
      return fail(
        "missing_outcome",
        `Player '${op.id}' has an unresolved non-authoritative hand (inferenceSource='${op.hand.inferenceSource}', unknownCount=${op.hand.unknownCount}). Supply explicit handsByPlayerId in determinization; inferred hands are never promoted to exact truth.`,
        { playerId: op.id }
      );
    }

    const readyDevs: ActionDevCardKind[] = [...op.devs.readyActionDevs];
    const boughtDevsThisTurn: ActionDevCardKind[] = [...op.devs.boughtActionDevsThisTurn];
    let vpDevs = op.devs.confirmedVpDevs;

    if (op.devs.unknownInHand > 0) {
      const explicitDevs = determinization?.unknownDevsByPlayerId?.[op.id];
      if (!explicitDevs) {
        return fail(
          "missing_outcome",
          `Player '${op.id}' holds ${op.devs.unknownInHand} face-down dev card(s). Supply unknownDevsByPlayerId in determinization.`,
          { playerId: op.id }
        );
      }
      const addReady = explicitDevs.ready ?? [];
      const addBought = explicitDevs.boughtThisTurn ?? [];
      const addVp = explicitDevs.vp ?? 0;
      if (addReady.length + addBought.length + addVp !== op.devs.unknownInHand) {
        return fail(
          "invalid_outcome",
          `Explicit unknownDevsByPlayerId for '${op.id}' has ${addReady.length + addBought.length + addVp} cards, expected unknownInHand=${op.devs.unknownInHand}.`,
          { playerId: op.id }
        );
      }
      readyDevs.push(...addReady);
      boughtDevsThisTurn.push(...addBought);
      vpDevs += addVp;
    }

    concretePlayers.push({
      id: op.id,
      seatIndex: op.seatIndex,
      hand: concreteHand,
      ratios: { ...op.ratios },
      settlementsLeft: op.supplies.settlementsLeft,
      citiesLeft: op.supplies.citiesLeft,
      roadsLeft: op.supplies.roadsLeft,
      readyDevs,
      boughtDevsThisTurn,
      vpDevs,
      playedDevs: [...op.devs.playedCards],
      knightsPlayed: op.devs.knightsPlayed,
      hasUsedDevThisTurn: op.devs.hasUsedDevThisTurn,
      hasLongestRoad: op.awards.hasLongestRoad,
      hasLargestArmy: op.awards.hasLargestArmy,
      roadLength: op.awards.computedRoadLength,
      visibleVp: op.vp.visibleVp,
      observedConfirmedVp: op.vp.totalConfirmedVp,
      actualSimulatedVp: op.vp.visibleVp + vpDevs,
      pendingDiscardCount: op.pendingDiscardCount
    });
  }

  let devDeckOrder: ConcreteDevCardKind[];
  if (determinization?.devDeckOrder) {
    devDeckOrder = [...determinization.devDeckOrder];
  } else if (observed.devDeck.bankRemaining === 0) {
    devDeckOrder = [];
  } else {
    return fail(
      "missing_outcome",
      `Observed state has ${observed.devDeck.bankRemaining} unrevealed dev cards in the bank; supply devDeckOrder in determinization.`
    );
  }

  const bank: ResourceHand = emptyHand();
  for (const r of RESOURCES) {
    const held = concretePlayers.reduce((s, p) => s + p.hand[r], 0);
    bank[r] = BANK_RESOURCE_CAP - held;
  }

  const simState: ConcreteSimulatedGameState = {
    kind: "simulated",
    topology: observed.topology,
    cornerOwner: [...observed.cornerOwner],
    cornerPiece: new Uint8Array(observed.cornerPiece),
    edgeOwner: [...observed.edgeOwner],
    robberHexIndex,
    bank,
    devDeckOrder,
    players: concretePlayers,
    playerOrder: [...observed.playerOrder],
    turnPlayerIndex,
    phase,
    completedTurns: observed.dice.completedTurns ?? 0,
    dice: {
      thrown: observed.dice.thrown,
      ...(observed.dice.d1 !== undefined ? { d1: observed.dice.d1 } : {}),
      ...(observed.dice.d2 !== undefined ? { d2: observed.dice.d2 } : {}),
      ...(observed.dice.total !== undefined ? { total: observed.dice.total } : {})
    },
    rules
  };

  const val = validateConcreteSimState(simState);
  if (!val.valid) {
    return fail("invalid_state", `Materialized ConcreteSimulatedGameState failed invariant validation: ${val.errors.join("; ")}`);
  }

  return { ok: true, state: simState };
}

/**
 * Creates a clean start-of-game `ConcreteSimulatedGameState` at `completedTurns = 0`,
 * `phase = "setup_settlement"`, for 2–4 players on a validated standard 19-hex board topology.
 */
export function createInitialConcreteState(options: CreateInitialConcreteStateOptions): TransitionResult {
  const { topology, playerIds } = options;
  const rules: ConcreteSimulatedGameState["rules"] = {
    victoryPointsToWin: options.rules?.victoryPointsToWin ?? (playerIds.length === 2 ? 15 : 10),
    cardDiscardLimit: options.rules?.cardDiscardLimit ?? (playerIds.length === 2 ? 9 : 7),
    friendlyRobber: options.rules?.friendlyRobber ?? (playerIds.length === 2),
    friendlyRobberMinVisibleVp: options.rules?.friendlyRobberMinVisibleVp ?? 3,
    diceMode: options.rules?.diceMode ?? "balanced",
    maxPlayers: options.rules?.maxPlayers ?? playerIds.length,
    bankResourceCap: options.rules?.bankResourceCap ?? BANK_RESOURCE_CAP,
    maxSettlementsPerPlayer: options.rules?.maxSettlementsPerPlayer ?? MAX_SETTLEMENTS,
    maxCitiesPerPlayer: options.rules?.maxCitiesPerPlayer ?? MAX_CITIES,
    maxRoadsPerPlayer: options.rules?.maxRoadsPerPlayer ?? MAX_ROADS,
    devDeckComposition: options.rules?.devDeckComposition ?? { ...STANDARD_DEV_DECK_COUNTS },
    ...(options.rules?.specialBuildingPhase !== undefined ? { specialBuildingPhase: options.rules.specialBuildingPhase } : {}),
    ...(options.rules?.extensionSetting !== undefined ? { extensionSetting: options.rules.extensionSetting } : {}),
    ...(options.rules?.mapSetting !== undefined ? { mapSetting: options.rules.mapSetting } : {})
  };

  const variantCheck = validateSupportedVariantAndRuleset(topology, playerIds.length, rules);
  if (variantCheck !== null) return variantCheck;

  const uniqueIds = new Set(playerIds);
  if (uniqueIds.size !== playerIds.length) {
    return fail("invalid_state", "playerIds must be unique.");
  }

  const defaultDeckOrder: ConcreteDevCardKind[] = [];
  const comp = rules.devDeckComposition ?? STANDARD_DEV_DECK_COUNTS;
  for (const kind of ["knight", "victoryPoint", "roadBuilding", "yearOfPlenty", "monopoly"] as const) {
    for (let i = 0; i < comp[kind]; i++) defaultDeckOrder.push(kind);
  }
  const devDeckOrder = options.devDeckOrder ? [...options.devDeckOrder] : defaultDeckOrder;

  const desertHex = topology.hexes.find((h) => h.resource === null);
  const robberHexIndex =
    options.robberHexIndex ??
    (topology.board.robberStart !== undefined
      ? topology.hexIndexByColonistId.get(topology.board.robberStart)
      : undefined) ??
    desertHex?.index ??
    0;

  const cap = rules.bankResourceCap ?? BANK_RESOURCE_CAP;
  const maxS = rules.maxSettlementsPerPlayer ?? MAX_SETTLEMENTS;
  const maxC = rules.maxCitiesPerPlayer ?? MAX_CITIES;
  const maxR = rules.maxRoadsPerPlayer ?? MAX_ROADS;

  const players: ConcreteSimulatedPlayerState[] = playerIds.map((id, idx) => ({
    id,
    seatIndex: idx,
    hand: emptyHand(),
    ratios: { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 },
    settlementsLeft: maxS,
    citiesLeft: maxC,
    roadsLeft: maxR,
    readyDevs: [],
    boughtDevsThisTurn: [],
    vpDevs: 0,
    playedDevs: [],
    knightsPlayed: 0,
    hasUsedDevThisTurn: false,
    hasLongestRoad: false,
    hasLargestArmy: false,
    roadLength: 0,
    visibleVp: 0,
    observedConfirmedVp: 0,
    actualSimulatedVp: 0,
    pendingDiscardCount: 0
  }));

  const state: ConcreteSimulatedGameState = {
    kind: "simulated",
    topology,
    cornerOwner: new Array<string | null>(topology.corners.length).fill(null),
    cornerPiece: new Uint8Array(topology.corners.length),
    edgeOwner: new Array<string | null>(topology.edges.length).fill(null),
    robberHexIndex,
    bank: { lumber: cap, brick: cap, wool: cap, grain: cap, ore: cap },
    devDeckOrder,
    players,
    playerOrder: [...playerIds],
    turnPlayerIndex: 0,
    phase: "setup_settlement",
    completedTurns: 0,
    dice: { thrown: false },
    rules
  };

  const val = validateConcreteSimState(state);
  if (!val.valid) {
    return fail("invalid_state", `Initial state validation failed: ${val.errors.join("; ")}`);
  }

  return { ok: true, state };
}
