import { RESOURCES, type Resource, type ResourceBag, type ResourceHand } from "../types";
import {
  sampleDeterminization,
  type DeterminizationDiagnostics,
  type DeterminizationErrorCode,
  type DeterminizationOptions
} from "./determinize";
import {
  resolveDiceModelForRules,
  type DiceModel,
  type DiceModelId,
  type DiceModelStatus,
  type DiceRollRecord
} from "./diceModel";
import { createSeededRng, deriveTrialSeed, type SeededRng } from "./rng";
import {
  cloneConcreteSimState,
  computeRoadLengthOnTopology,
  validateConcreteSimState,
  type ConcreteSimulatedGameState,
  type ConcreteSimulatedPlayerState,
  type ObservedDiceState,
  type ObservedGameState
} from "./state";
import {
  applyAction,
  getLegalActions,
  getLegalCityCorners,
  getLegalSettlementCorners,
  isActionLegal,
  validateSupportedVariantAndRuleset,
  type ActionOutcome,
  type LegalActionOptions,
  type SimulatedAction
} from "./transition";

export type RolloutStatus =
  | "completed"
  | "max_turns_reached"
  | "max_actions_reached"
  | "unsupported_phase"
  | "unsupported_action"
  | "invalid_state"
  | "no_legal_actions";

export interface RolloutStepTrace {
  readonly stepIndex: number;
  readonly completedTurns: number;
  readonly phase: string;
  readonly actorId: string;
  readonly action: SimulatedAction;
  readonly outcome?: ActionOutcome;
}

export interface RolloutPolicyContext {
  readonly stepIndex: number;
  readonly bankTradesThisTurn: number;
}

export interface RolloutPolicy {
  readonly id: string;
  selectAction(
    state: ConcreteSimulatedGameState,
    actorId: string,
    legalActions: readonly SimulatedAction[],
    rng: SeededRng,
    context: RolloutPolicyContext
  ): SimulatedAction;
}

export interface RolloutOptions {
  /** Maximum number of turns to simulate beyond `initialState.completedTurns` before returning `"max_turns_reached"`. Default: 240. */
  readonly maxTurns?: number;
  /** Maximum number of action transitions to simulate before returning `"max_actions_reached"`. Default: 1500. */
  readonly maxActions?: number;
  /** Explicit dice model instance to use for `rollDice` outcomes. */
  readonly diceModel?: DiceModel;
  /** Optional dice model ID override when resolving from `initialState.rules.diceMode`. */
  readonly diceModelId?: Exclude<DiceModelId, "unsupported_dice_mode">;
  /** Must be true along with `diceModelId` if `initialState.rules.diceMode` is unknown. */
  readonly allowApproximationForUnknownDiceMode?: boolean;
  /** Prior roll history at the start of the rollout (used by history-aware dice models). */
  readonly initialRollHistory?: ReadonlyArray<number | DiceRollRecord>;
  /** Alignment status of `initialRollHistory` (`"aligned"` by default). */
  readonly diceAlignmentStatus?: ObservedDiceState["alignmentStatus"];
  /** Policy used to select among legal actions. Defaults to ` baselineRolloutPolicy`. */
  readonly policy?: RolloutPolicy;
  /** Options forwarded to `getLegalActions`. */
  readonly legalActionOptions?: LegalActionOptions;
  /** Whether to run `validateConcreteSimState` after every transition step. Default: true. */
  readonly validateEveryStep?: boolean;
  /** Whether to record the full step-by-step action/outcome trace. Default: false. */
  readonly recordTrace?: boolean;
  /**
   * If true, decouples stochastic events into separate deterministic pseudorandom streams
   * for dice rolls, robber victim thefts, and policy random selection, ensuring events in one
   * domain (such as victim theft) do not advance or desynchronize dice roll sequences in another branch.
   * Defaults to false in standalone rollouts for backwards compatibility; enabled in shadow evaluation.
   */
  readonly separateDomainStreams?: boolean;
}

export interface RolloutResult {
  readonly status: RolloutStatus;
  /** True ONLY when `status === "completed"` and the game reached `phase === "game_over"` with a valid winner. */
  readonly completed: boolean;
  /** Winner player ID ONLY when `completed === true`; undefined on cutoffs or failures. */
  readonly winnerId?: string;
  readonly finalState: ConcreteSimulatedGameState;
  readonly initialSeed: number;
  readonly policyId: string;
  readonly diceModelId: DiceModelId;
  readonly diceModelStatus: DiceModelStatus;
  readonly diceModelIsExact: boolean;
  readonly actionsSimulated: number;
  readonly turnsSimulated: number;
  readonly totalCompletedTurns: number;
  readonly sampledDiceRolls: readonly number[];
  readonly reason?: string;
  readonly trace?: readonly RolloutStepTrace[];
}

export interface BatchRolloutOptions {
  /** Number of independent determinized rollout trials to execute. */
  readonly numTrials: number;
  /** Base seed (number or string) from which each trial's independent seed is deterministically derived. */
  readonly baseSeed: number | string;
  /** Options forwarded to `sampleDeterminization` on each trial. */
  readonly determinizationOptions?: DeterminizationOptions;
  /** Options forwarded to `runRollout` on each trial. */
  readonly rolloutOptions?: Omit<RolloutOptions, "initialRollHistory" | "diceAlignmentStatus">;
}

export interface BatchTrialRecord {
  readonly trialIndex: number;
  readonly trialSeed: number;
  readonly determinizationOk: boolean;
  readonly determinizationErrorCode?: DeterminizationErrorCode;
  readonly determinizationErrorMessage?: string;
  readonly determinizationDiagnostics?: DeterminizationDiagnostics;
  readonly rolloutStatus: RolloutStatus | "determinization_failed";
  readonly completed: boolean;
  readonly winnerId?: string;
  readonly actionsSimulated: number;
  readonly turnsSimulated: number;
  readonly reason?: string;
}

export interface BatchRolloutSummary {
  readonly baseSeed: number | string;
  readonly numTrials: number;
  readonly policyId: string;
  readonly diceModelId: DiceModelId;
  readonly diceModelStatus: DiceModelStatus;
  readonly diceModelIsExact: boolean;
  readonly determinizationSuccessCount: number;
  readonly determinizationFailureCount: number;
  readonly completedCount: number;
  readonly cutoffCount: number;
  readonly maxTurnsCutoffCount: number;
  readonly maxActionsCutoffCount: number;
  readonly failedRolloutCount: number;
  /** Win counts tallied strictly across COMPLETED trials (`completedCount`). Incomplete trials are never counted as wins or losses. */
  readonly winsByPlayerId: Readonly<Record<string, number>>;
  /**
   * Win rate among completed trials (`wins / completedCount`), or `null` if `completedCount === 0`.
   * Always accompanied by `completionRate` and `cutoffCount` so incomplete trials are never hidden.
   */
  readonly winRateAmongCompletedByPlayerId: Readonly<Record<string, number | null>>;
  /** Fraction of total requested trials that reached a terminal game-over state (`completedCount / numTrials`). */
  readonly completionRate: number;
  readonly trials: readonly BatchTrialRecord[];
}

const sumHand = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

const COST_CITY: ResourceBag = { grain: 2, ore: 3 };
const COST_SETTLEMENT: ResourceBag = { lumber: 1, brick: 1, wool: 1, grain: 1 };
const COST_ROAD: ResourceBag = { lumber: 1, brick: 1 };
const COST_DEV: ResourceBag = { wool: 1, grain: 1, ore: 1 };

const RES_BASE_WEIGHT: Readonly<Record<Resource, number>> = {
  ore: 1.25,
  grain: 1.25,
  lumber: 1.05,
  brick: 1.0,
  wool: 0.9
};

/**
 * Checks whether an action is a deterministic immediate winning move for `actorId`
 * using ONLY information observable/known to `actorId` (board state + `actorId`'s own hand and VP).
 * Never peeks at `state.devDeckOrder` for `buyDevCard`.
 */
export function findImmediateWinningAction(
  state: ConcreteSimulatedGameState,
  actorId: string,
  legalActions: readonly SimulatedAction[]
): SimulatedAction | undefined {
  for (const action of legalActions) {
    if (
      action.type !== "buildCity" &&
      action.type !== "buildSettlement" &&
      action.type !== "buildRoad" &&
      action.type !== "placeFreeRoad" &&
      action.type !== "playKnight" &&
      action.type !== "endTurn"
    ) {
      continue;
    }
    const res = applyAction(state, actorId, action);
    if (res.ok && res.state.phase === "game_over" && res.state.winnerId === actorId) {
      return action;
    }
  }
  return undefined;
}

function scoreCornerForPlayer(state: ConcreteSimulatedGameState, cornerIndex: number): number {
  const corner = state.topology.corners[cornerIndex];
  if (!corner) return 0;
  let score = 0;
  const seenRes = new Set<Resource>();
  for (const hi of corner.hexIndices) {
    const hex = state.topology.hexes[hi];
    if (!hex.resource || hex.pips <= 0) continue;
    score += hex.pips * RES_BASE_WEIGHT[hex.resource];
    seenRes.add(hex.resource);
  }
  score += seenRes.size * 0.75;
  if (corner.port === "any") score += 1.5;
  else if (corner.port) score += 2.0;
  return score;
}

function isCornerDistanceOpen(state: ConcreteSimulatedGameState, cornerIndex: number): boolean {
  if (state.cornerPiece[cornerIndex] !== 0) return false;
  for (const adj of state.topology.corners[cornerIndex].adjacentCornerIndices) {
    if (state.cornerPiece[adj] > 0) return false;
  }
  return true;
}

/**
 * Computes the minimum number of additional roads `playerId` needs after placing on `edgeIndex`
 * to reach an open distance-legal settlement corner (0 if `edgeIndex` directly touches an open legal corner).
 */
function minAdditionalRoadsToOpenSettlementFromEdge(
  state: ConcreteSimulatedGameState,
  playerId: string,
  edgeIndex: number,
  maxDepth = 3
): { dist: number; bestCornerScore: number } {
  const edge = state.topology.edges[edgeIndex];
  if (!edge) return { dist: 99, bestCornerScore: 0 };

  let bestDist = 99;
  let bestScore = 0;

  // BFS over corners starting from the endpoints of `edgeIndex`
  const queue: Array<{ cornerIdx: number; d: number }> = [
    { cornerIdx: edge.c1, d: 0 },
    { cornerIdx: edge.c2, d: 0 }
  ];
  const visitedCorner = new Map<number, number>();
  visitedCorner.set(edge.c1, 0);
  visitedCorner.set(edge.c2, 0);

  while (queue.length > 0) {
    const { cornerIdx, d } = queue.shift()!;
    if (d > bestDist) break;

    if (isCornerDistanceOpen(state, cornerIdx)) {
      const sc = scoreCornerForPlayer(state, cornerIdx);
      if (d < bestDist || (d === bestDist && sc > bestScore)) {
        bestDist = d;
        bestScore = sc;
      }
    }

    if (d >= maxDepth) continue;
    // Cannot extend roads through an opponent's building
    const cOwner = state.cornerOwner[cornerIdx];
    if (cOwner !== null && cOwner !== playerId) continue;

    const cNode = state.topology.corners[cornerIdx];
    for (let i = 0; i < cNode.incidentEdgeIndices.length; i++) {
      const nextEdgeIdx = cNode.incidentEdgeIndices[i];
      const nextCornerIdx = cNode.adjacentCornerIndices[i];
      const eOwner = nextEdgeIdx === edgeIndex ? playerId : state.edgeOwner[nextEdgeIdx];
      if (eOwner !== null && eOwner !== playerId) continue;
      const stepCost = eOwner === playerId ? 0 : 1;
      const nextD = d + stepCost;
      if (nextD > maxDepth) continue;
      const prevD = visitedCorner.get(nextCornerIdx);
      if (prevD === undefined || nextD < prevD) {
        visitedCorner.set(nextCornerIdx, nextD);
        queue.push({ cornerIdx: nextCornerIdx, d: nextD });
      }
    }
  }

  return { dist: bestDist, bestCornerScore: bestScore };
}

function deficitForCost(hand: ResourceHand, cost: ResourceBag): number {
  let missing = 0;
  for (const r of RESOURCES) {
    const need = cost[r] ?? 0;
    if (hand[r] < need) missing += need - hand[r];
  }
  return missing;
}

function tradeableMultiplesOutsideCost(player: ConcreteSimulatedPlayerState, cost: ResourceBag): number {
  let multiples = 0;
  for (const r of RESOURCES) {
    const keep = cost[r] ?? 0;
    const surplus = Math.max(0, player.hand[r] - keep);
    const rate = player.ratios[r];
    if (rate >= 2 && rate <= 4) {
      multiples += Math.floor(surplus / rate);
    }
  }
  return multiples;
}

function selectBankTradeForTarget(
  player: ConcreteSimulatedPlayerState,
  targetCost: ResourceBag,
  bankTradeActions: ReadonlyArray<Extract<SimulatedAction, { type: "bankTrade" }>>,
  allowPartialProgress: boolean
): Extract<SimulatedAction, { type: "bankTrade" }> | undefined {
  const missing = deficitForCost(player.hand, targetCost);
  if (missing <= 0) return undefined;
  const multiples = tradeableMultiplesOutsideCost(player, targetCost);
  if (!allowPartialProgress && multiples < missing) return undefined;
  if (multiples <= 0) return undefined;

  let bestTrade: Extract<SimulatedAction, { type: "bankTrade" }> | undefined;
  let bestScore = -Infinity;

  for (const trade of bankTradeActions) {
    const { give, receive } = trade;
    const rate = player.ratios[give];
    const keepGive = targetCost[give] ?? 0;
    const needReceive = targetCost[receive] ?? 0;
    if (player.hand[receive] >= needReceive) continue;
    if (player.hand[give] - rate < keepGive) continue;
    const score = ( player.hand[give] - keepGive ) / rate + (needReceive - player.hand[receive]) * 2;
    if (score > bestScore) {
      bestScore = score;
      bestTrade = trade;
    }
  }
  return bestTrade;
}

/**
 * Simple, documented, deterministic-under-seed baseline rollout policy.
 *
 * Design principles:
 * - Selects only from `legalActions` returned by `getLegalActions`.
 * - Takes any immediate legal winning action first.
 * - Uses only public board information and `actorId`'s own hand/devs (never peeks at opponent hands or `devDeckOrder`).
 * - Prevents aimless road spam and bank-trade loops so rollouts make forward VP progress and terminate reliably.
 */
export const baselineRolloutPolicy: RolloutPolicy = {
  id: "baseline_heuristic_v1",

  selectAction(
    state: ConcreteSimulatedGameState,
    actorId: string,
    legalActions: readonly SimulatedAction[],
    rng: SeededRng,
    context: RolloutPolicyContext
  ): SimulatedAction {
    if (legalActions.length === 1) {
      return legalActions[0];
    }

    const immediateWin = findImmediateWinningAction(state, actorId, legalActions);
    if (immediateWin) {
      return immediateWin;
    }

    const actor = state.players.find((p) => p.id === actorId) ?? state.players[state.turnPlayerIndex];

    switch (state.phase) {
      case "setup_settlement": {
        const scored = legalActions
          .filter((a): a is Extract<SimulatedAction, { type: "placeSetupSettlement" }> => a.type === "placeSetupSettlement")
          .map((action) => ({
            action,
            score: scoreCornerForPlayer(state, action.cornerIndex)
          }))
          .sort((a, b) => b.score - a.score);
        if (scored.length >= 2 && scored[0].score - scored[1].score <= 1.25) {
          return scored[rng.weightedIndex([4, 1])].action;
        }
        return scored[0]?.action ?? rng.pick(legalActions);
      }

      case "setup_road": {
        const roadActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "placeSetupRoad" }> => a.type === "placeSetupRoad"
        );
        const scored = roadActions
          .map((action) => {
            const reach = minAdditionalRoadsToOpenSettlementFromEdge(state, actorId, action.edgeIndex, 2);
            const score = (3 - Math.min(3, reach.dist)) * 5 + reach.bestCornerScore * 0.2;
            return { action, score };
          })
          .sort((a, b) => b.score - a.score);
        return scored[0]?.action ?? rng.pick(legalActions);
      }

      case "pre_roll": {
        const knightAction = legalActions.find((a) => a.type === "playKnight");
        if (knightAction) {
          const robberHex = state.topology.hexes[state.robberHexIndex];
          const blocksActor =
            robberHex?.cornerIndices.some((ci) => state.cornerOwner[ci] === actorId) ?? false;
          if (blocksActor) return knightAction;
        }
        return legalActions.find((a) => a.type === "rollDice") ?? rng.pick(legalActions);
      }

      case "discard": {
        const discardActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "discard" }> => a.type === "discard"
        );
        let bestDiscard = discardActions[0];
        let bestRemainingScore = -Infinity;
        const canCity = actor.citiesLeft > 0 && getLegalCityCorners(state, actorId).length > 0;
        const canSettle = actor.settlementsLeft > 0;

        for (const action of discardActions) {
          const rem: ResourceHand = {
            lumber: actor.hand.lumber - (action.cards.lumber ?? 0),
            brick: actor.hand.brick - (action.cards.brick ?? 0),
            wool: actor.hand.wool - (action.cards.wool ?? 0),
            grain: actor.hand.grain - (action.cards.grain ?? 0),
            ore: actor.hand.ore - (action.cards.ore ?? 0)
          };
          let sc = 0;
          if (canCity) sc -= deficitForCost(rem, COST_CITY) * 3.5;
          if (canSettle) sc -= deficitForCost(rem, COST_SETTLEMENT) * 2.5;
          sc -= deficitForCost(rem, COST_DEV) * 1.5;
          if (sc > bestRemainingScore) {
            bestRemainingScore = sc;
            bestDiscard = action;
          }
        }
        return bestDiscard ?? rng.pick(legalActions);
      }

      case "robber_move": {
        const robberMoves = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "moveRobber" }> => a.type === "moveRobber"
        );
        let bestMove = robberMoves[0];
        let bestScore = -Infinity;

        for (const action of robberMoves) {
          const hex = state.topology.hexes[action.hexIndex];
          if (!hex) continue;
          let sc = 0;
          for (const ci of hex.cornerIndices) {
            const ownerId = state.cornerOwner[ci];
            if (!ownerId) continue;
            const weight = state.cornerPiece[ci] === 2 ? 2 : 1;
            if (ownerId === actorId) {
              sc -= 40 * weight;
            } else {
              sc += hex.pips * weight * 3;
            }
          }
          if (action.victimId) {
            const victim = state.players.find((p) => p.id === action.victimId);
            if (victim) {
              sc += 8 + victim.visibleVp * 1.5;
            }
          }
          if (sc > bestScore) {
            bestScore = sc;
            bestMove = action;
          }
        }
        return bestMove ?? rng.pick(legalActions);
      }

      case "road_building_1":
      case "road_building_2": {
        const freeRoads = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "placeFreeRoad" }> => a.type === "placeFreeRoad"
        );
        let bestRoad = freeRoads[0];
        let bestScore = -Infinity;
        for (const action of freeRoads) {
          const reach = minAdditionalRoadsToOpenSettlementFromEdge(state, actorId, action.edgeIndex, 3);
          const nextEdgeOwner = [...state.edgeOwner];
          nextEdgeOwner[action.edgeIndex] = actorId;
          const newLen = computeRoadLengthOnTopology(state.topology, state.cornerOwner, nextEdgeOwner, actorId);
          const lenGain = Math.max(0, newLen - actor.roadLength);
          const sc = (4 - Math.min(4, reach.dist)) * 6 + reach.bestCornerScore * 0.25 + lenGain * 2.5;
          if (sc > bestScore) {
            bestScore = sc;
            bestRoad = action;
          }
        }
        return bestRoad ?? rng.pick(legalActions);
      }

      case "year_of_plenty": {
        return pickBestYearOfPlentyAction(state, actor, legalActions) ?? rng.pick(legalActions);
      }

      case "monopoly": {
        return pickBestMonopolyAction(state, actorId, legalActions) ?? rng.pick(legalActions);
      }

      case "main": {
        // 1. Build a City if legal (highest VP + production upgrade; also returns a settlement piece to supply)
        const cityActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildCity" }> => a.type === "buildCity"
        );
        if (cityActions.length > 0) {
          cityActions.sort((a, b) => scoreCornerForPlayer(state, b.cornerIndex) - scoreCornerForPlayer(state, a.cornerIndex));
          return cityActions[0];
        }

        // 2. Build a Settlement if legal
        const settleActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildSettlement" }> => a.type === "buildSettlement"
        );
        if (settleActions.length > 0) {
          settleActions.sort(
            (a, b) => scoreCornerForPlayer(state, b.cornerIndex) - scoreCornerForPlayer(state, a.cornerIndex)
          );
          return settleActions[0];
        }

        // 3. Play an action dev card if available and beneficial
        const rbAction = legalActions.find((a) => a.type === "playRoadBuilding");
        if (rbAction) return rbAction;

        const yopAction = pickBestYearOfPlentyAction(state, actor, legalActions);
        if (yopAction) return yopAction;

        const monoAction = pickBestMonopolyAction(state, actorId, legalActions);
        if (monoAction) return monoAction;

        const knightAction = legalActions.find((a) => a.type === "playKnight");
        if (knightAction) return knightAction;

        // 4. Check open settlement corners vs road expansion needs
        const openSettlementCorners = getLegalSettlementCorners(state, actorId);
        const hasSettlementOnBoard = getLegalCityCorners(state, actorId).length > 0;
        const canCity = actor.citiesLeft > 0 && hasSettlementOnBoard;
        const canSettleNow = actor.settlementsLeft > 0 && openSettlementCorners.length > 0;

        // 5. Purposeful Bank Trade (capped at 4 trades per turn to prevent any cyclic trading)
        const bankTrades = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "bankTrade" }> => a.type === "bankTrade"
        );
        if (bankTrades.length > 0 && context.bankTradesThisTurn < 4) {
          const overDiscardLimit = sumHand(actor.hand) > state.rules.cardDiscardLimit;
          if (canCity) {
            const trade = selectBankTradeForTarget(actor, COST_CITY, bankTrades, overDiscardLimit);
            if (trade) return trade;
          }
          if (canSettleNow) {
            const trade = selectBankTradeForTarget(actor, COST_SETTLEMENT, bankTrades, overDiscardLimit);
            if (trade) return trade;
          }
          if (actor.settlementsLeft > 0 && openSettlementCorners.length === 0 && actor.roadsLeft > 0) {
            const trade = selectBankTradeForTarget(actor, COST_ROAD, bankTrades, false);
            if (trade) return trade;
          }
          if (state.devDeckOrder.length > 0) {
            const trade = selectBankTradeForTarget(actor, COST_DEV, bankTrades, overDiscardLimit);
            if (trade) return trade;
          }
        }

        // 6. Road Building (`buildRoad`) when needed to reach a new settlement spot or contest Longest Road
        const roadActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildRoad" }> => a.type === "buildRoad"
        );
        if (roadActions.length > 0) {
          const needsExpansionRoad = actor.settlementsLeft > 0 && openSettlementCorners.length === 0;
          const maxOppRoad = state.players.reduce(
            (m, p) => (p.id === actorId ? m : Math.max(m, p.roadLength)),
            0
          );
          const contestingLongestRoad =
            actor.roadLength >= 4 && (!actor.hasLongestRoad || actor.roadLength <= maxOppRoad);

          // Avoid spending our last grain/lumber/brick on extra roads if we already have an open settlement spot
          if (needsExpansionRoad || contestingLongestRoad) {
            let bestRoad: Extract<SimulatedAction, { type: "buildRoad" }> | undefined;
            let bestScore = -Infinity;
            for (const action of roadActions) {
              const reach = minAdditionalRoadsToOpenSettlementFromEdge(state, actorId, action.edgeIndex, 3);
              const nextEdgeOwner = [...state.edgeOwner];
              nextEdgeOwner[action.edgeIndex] = actorId;
              const newLen = computeRoadLengthOnTopology(state.topology, state.cornerOwner, nextEdgeOwner, actorId);
              const lenGain = Math.max(0, newLen - actor.roadLength);
              if (needsExpansionRoad && reach.dist > 3 && lenGain === 0) continue;
              const sc = (4 - Math.min(4, reach.dist)) * 6 + reach.bestCornerScore * 0.25 + lenGain * 4;
              if (sc > bestScore) {
                bestScore = sc;
                bestRoad = action;
              }
            }
            if (bestRoad) return bestRoad;
          }
        }

        // 7. Buy Development Card (`buyDevCard`) if legal and not holding 2 grain + 2 ore right before a city
        const buyDevAction = legalActions.find((a) => a.type === "buyDevCard");
        if (buyDevAction) {
          const almostCity = canCity && actor.hand.grain >= 2 && actor.hand.ore >= 2;
          if (!almostCity || sumHand(actor.hand) > state.rules.cardDiscardLimit) {
            return buyDevAction;
          }
        }

        // 8. End turn
        return legalActions.find((a) => a.type === "endTurn") ?? rng.pick(legalActions);
      }

      default:
        return rng.pick(legalActions);
    }
  }
};

function pickBestYearOfPlentyAction(
  state: ConcreteSimulatedGameState,
  actor: ConcreteSimulatedPlayerState,
  legalActions: readonly SimulatedAction[]
): Extract<SimulatedAction, { type: "playYearOfPlenty" }> | undefined {
  const yopActions = legalActions.filter(
    (a): a is Extract<SimulatedAction, { type: "playYearOfPlenty" }> => a.type === "playYearOfPlenty"
  );
  if (yopActions.length === 0) return undefined;

  const canCity = actor.citiesLeft > 0 && getLegalCityCorners(state, actor.id).length > 0;
  const canSettle = actor.settlementsLeft > 0 && getLegalSettlementCorners(state, actor.id).length > 0;

  let best = yopActions[0];
  let bestScore = -Infinity;

  for (const action of yopActions) {
    const hyp: ResourceHand = { ...actor.hand };
    for (const r of action.resources) hyp[r] += 1;

    let sc = 0;
    if (canCity && deficitForCost(hyp, COST_CITY) === 0) sc += 50;
    else if (canCity) sc -= deficitForCost(hyp, COST_CITY) * 4;

    if (canSettle && deficitForCost(hyp, COST_SETTLEMENT) === 0) sc += 40;
    else if (canSettle) sc -= deficitForCost(hyp, COST_SETTLEMENT) * 3;

    if (deficitForCost(hyp, COST_DEV) === 0) sc += 15;
    if (deficitForCost(hyp, COST_ROAD) === 0 && actor.roadsLeft > 0) sc += 8;

    for (const r of action.resources) sc += RES_BASE_WEIGHT[r];

    if (sc > bestScore) {
      bestScore = sc;
      best = action;
    }
  }
  return best;
}

/**
 * Selects a Monopoly target resource using ONLY publicly observable board production pips
 * and `actorId`'s own build needs — NEVER peeking at opponent private hands!
 */
function pickBestMonopolyAction(
  state: ConcreteSimulatedGameState,
  actorId: string,
  legalActions: readonly SimulatedAction[]
): Extract<SimulatedAction, { type: "playMonopoly" }> | undefined {
  const monoActions = legalActions.filter(
    (a): a is Extract<SimulatedAction, { type: "playMonopoly" }> => a.type === "playMonopoly"
  );
  if (monoActions.length === 0) return undefined;

  const oppProdPips: ResourceHand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (let ci = 0; ci < state.topology.corners.length; ci++) {
    const owner = state.cornerOwner[ci];
    if (!owner || owner === actorId) continue;
    const weight = state.cornerPiece[ci] === 2 ? 2 : 1;
    for (const hi of state.topology.corners[ci].hexIndices) {
      const hex = state.topology.hexes[hi];
      if (hex.resource && hex.pips > 0) {
        oppProdPips[hex.resource] += hex.pips * weight;
      }
    }
  }

  let best = monoActions[0];
  let bestScore = -Infinity;
  for (const action of monoActions) {
    const r = action.resource;
    const sc = oppProdPips[r] * 2 + RES_BASE_WEIGHT[r] * 3;
    if (sc > bestScore) {
      bestScore = sc;
      best = action;
    }
  }
  return best;
}

function resolveCurrentActorId(state: ConcreteSimulatedGameState): string | undefined {
  if (state.phase === "discard") {
    for (let offset = 0; offset < state.players.length; offset++) {
      const candidate = state.players[(state.turnPlayerIndex + offset) % state.players.length];
      if (candidate && candidate.pendingDiscardCount > 0) {
        return candidate.id;
      }
    }
    return undefined;
  }
  return state.players[state.turnPlayerIndex]?.id;
}

/**
 * Executes a single reproducible rollout from a concrete state `initialState` using `rng`,
 * calling Stage 3.2's `getLegalActions` and `applyAction` until the game terminates or a cutoff is reached.
 *
 * Never mutates `initialState`.
 */
export function runRollout(
  initialState: ConcreteSimulatedGameState,
  rng: SeededRng,
  options?: RolloutOptions
): RolloutResult {
  const maxTurns = options?.maxTurns ?? 240;
  const maxActions = options?.maxActions ?? 1500;
  const policy = options?.policy ?? baselineRolloutPolicy;
  const validateEveryStep = options?.validateEveryStep ?? true;
  const recordTrace = options?.recordTrace === true;

  const diceResolution = options?.diceModel
    ? { ok: true as const, model: options.diceModel, error: undefined }
    : resolveDiceModelForRules(initialState?.rules?.diceMode ?? ("unknown" as "balanced"), {
        modelId: options?.diceModelId,
        allowApproximationForUnknownMode: options?.allowApproximationForUnknownDiceMode
      });

  const diceModel = diceResolution.model;
  const separateDomainStreams = options?.separateDomainStreams === true;
  const diceRng = separateDomainStreams
    ? createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-dice"))
    : rng;
  const theftRng = separateDomainStreams
    ? createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-theft"))
    : rng;
  const policyRng = separateDomainStreams
    ? createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-policy"))
    : rng;

  const baseResultFields = {
    initialSeed: rng.initialSeed,
    policyId: policy.id,
    diceModelId: diceModel.id,
    diceModelStatus: diceModel.status,
    diceModelIsExact: diceModel.isExact
  };

  if (!initialState || initialState.kind !== "simulated") {
    return {
      ...baseResultFields,
      status: "invalid_state",
      completed: false,
      finalState: initialState,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: 0,
      sampledDiceRolls: [],
      reason: "initialState must be a ConcreteSimulatedGameState (kind === 'simulated')."
    };
  }

  let state = cloneConcreteSimState(initialState);
  const initialCompletedTurns = state.completedTurns;

  if ((state.phase as string) === "unknown" || state.phase === "setup_waiting") {
    return {
      ...baseResultFields,
      status: "unsupported_phase",
      completed: false,
      finalState: state,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: state.completedTurns,
      sampledDiceRolls: [],
      reason: `Cannot run rollout from unsupported phase '${state.phase}'.`
    };
  }

  const variantCheck = validateSupportedVariantAndRuleset(state.topology, state.players.length, state.rules);
  if (variantCheck !== null) {
    return {
      ...baseResultFields,
      status: "invalid_state",
      completed: false,
      finalState: state,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: state.completedTurns,
      sampledDiceRolls: [],
      reason: variantCheck.error.message
    };
  }

  const initialVal = validateConcreteSimState(state);
  if (!initialVal.valid) {
    return {
      ...baseResultFields,
      status: "invalid_state",
      completed: false,
      finalState: state,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: state.completedTurns,
      sampledDiceRolls: [],
      reason: `Initial state failed concrete invariant validation: ${initialVal.errors.join("; ")}`
    };
  }

  if (!diceResolution.ok) {
    return {
      ...baseResultFields,
      status: "unsupported_action",
      completed: false,
      finalState: state,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: state.completedTurns,
      sampledDiceRolls: [],
      reason: diceResolution.error
    };
  }

  if (state.phase === "game_over") {
    const winnerId =
      state.winnerId ??
      state.players.find((p) => p.actualSimulatedVp >= state.rules.victoryPointsToWin)?.id ??
      state.players[state.turnPlayerIndex]?.id;
    return {
      ...baseResultFields,
      status: "completed",
      completed: true,
      ...(winnerId !== undefined ? { winnerId } : {}),
      finalState: state,
      actionsSimulated: 0,
      turnsSimulated: 0,
      totalCompletedTurns: state.completedTurns,
      sampledDiceRolls: [],
      ...(recordTrace ? { trace: [] } : {})
    };
  }

  const rollHistory: number[] = options?.initialRollHistory
    ? options.initialRollHistory.map((r) => (typeof r === "number" ? r : r.total))
    : state.dice.thrown && state.dice.total !== undefined
      ? [state.dice.total]
      : [];
  const alignmentStatus = options?.diceAlignmentStatus ?? "aligned";

  const sampledDiceRolls: number[] = [];
  const trace: RolloutStepTrace[] = [];
  let actionsSimulated = 0;
  let bankTradesThisTurn = 0;
  let lastTurnTracker = state.completedTurns;

  while (state.phase !== "game_over") {
    const turnsSimulated = state.completedTurns - initialCompletedTurns;
    if (turnsSimulated >= maxTurns) {
      return {
        ...baseResultFields,
        status: "max_turns_reached",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `Reached maxTurns limit (${maxTurns}).`,
        ...(recordTrace ? { trace } : {})
      };
    }

    if (actionsSimulated >= maxActions) {
      return {
        ...baseResultFields,
        status: "max_actions_reached",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `Reached maxActions limit (${maxActions}).`,
        ...(recordTrace ? { trace } : {})
      };
    }

    if ((state.phase as string) === "unknown" || state.phase === "setup_waiting") {
      return {
        ...baseResultFields,
        status: "unsupported_phase",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `Encountered unsupported phase '${state.phase}' at step ${actionsSimulated}.`,
        ...(recordTrace ? { trace } : {})
      };
    }

    if (state.completedTurns !== lastTurnTracker) {
      bankTradesThisTurn = 0;
      lastTurnTracker = state.completedTurns;
    }

    const actorId = resolveCurrentActorId(state);
    if (!actorId) {
      return {
        ...baseResultFields,
        status: "no_legal_actions",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `Could not resolve an active player in phase '${state.phase}'.`,
        ...(recordTrace ? { trace } : {})
      };
    }

    const legalActions = getLegalActions(state, actorId, options?.legalActionOptions);
    if (legalActions.length === 0) {
      return {
        ...baseResultFields,
        status: "no_legal_actions",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `No legal actions available for player '${actorId}' in phase '${state.phase}'.`,
        ...(recordTrace ? { trace } : {})
      };
    }

    const chosenAction = policy.selectAction(state, actorId, legalActions, policyRng, {
      stepIndex: actionsSimulated,
      bankTradesThisTurn
    });

    if (!chosenAction || !isActionLegal(state, actorId, chosenAction)) {
      return {
        ...baseResultFields,
        status: "unsupported_action",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `Policy '${policy.id}' selected an illegal or unsupported action '${String(chosenAction?.type)}' for '${actorId}' in phase '${state.phase}'.`,
        ...(recordTrace ? { trace } : {})
      };
    }

    let outcome: ActionOutcome | undefined;
    if (chosenAction.type === "rollDice") {
      if (chosenAction.d1 === undefined && chosenAction.d2 === undefined && chosenAction.total === undefined) {
        const sample = diceModel.sampleOutcome(diceRng, { rollHistory, alignmentStatus });
        if (!sample.ok || !sample.outcome) {
          return {
            ...baseResultFields,
            status: "unsupported_action",
            completed: false,
            finalState: state,
            actionsSimulated,
            turnsSimulated,
            totalCompletedTurns: state.completedTurns,
            sampledDiceRolls,
            reason: sample.error ?? "Dice model failed to sample an outcome.",
            ...(recordTrace ? { trace } : {})
          };
        }
        outcome = { dice: sample.outcome };
        rollHistory.push(sample.outcome.total);
        sampledDiceRolls.push(sample.outcome.total);
      } else {
        const tot = chosenAction.total ?? (chosenAction.d1! + chosenAction.d2!);
        rollHistory.push(tot);
        sampledDiceRolls.push(tot);
      }
    } else if (chosenAction.type === "moveRobber" && typeof chosenAction.victimId === "string") {
      const victim = state.players.find((p) => p.id === chosenAction.victimId);
      if (victim && sumHand(victim.hand) > 0) {
        const cardWeights = RESOURCES.map((r) => Math.max(0, victim.hand[r]));
        const stolenRes = RESOURCES[theftRng.weightedIndex(cardWeights)];
        outcome = { stolenResource: stolenRes };
      }
    }

    if (chosenAction.type === "bankTrade") {
      bankTradesThisTurn += 1;
    }

    const stepPhase = state.phase;
    const stepTurn = state.completedTurns;
    const transition = applyAction(state, actorId, chosenAction, outcome);
    if (!transition.ok) {
      return {
        ...baseResultFields,
        status: "invalid_state",
        completed: false,
        finalState: state,
        actionsSimulated,
        turnsSimulated,
        totalCompletedTurns: state.completedTurns,
        sampledDiceRolls,
        reason: `applyAction failed (${transition.error.code}): ${transition.error.message}`,
        ...(recordTrace ? { trace } : {})
      };
    }

    state = transition.state;
    if (recordTrace) {
      trace.push({
        stepIndex: actionsSimulated,
        completedTurns: stepTurn,
        phase: stepPhase,
        actorId,
        action: chosenAction,
        ...(outcome !== undefined ? { outcome } : {})
      });
    }
    actionsSimulated += 1;

    if (validateEveryStep) {
      const stepVal = validateConcreteSimState(state);
      if (!stepVal.valid) {
        return {
          ...baseResultFields,
          status: "invalid_state",
          completed: false,
          finalState: state,
          actionsSimulated,
          turnsSimulated: state.completedTurns - initialCompletedTurns,
          totalCompletedTurns: state.completedTurns,
          sampledDiceRolls,
          reason: `Post-transition state failed validation at step ${actionsSimulated}: ${stepVal.errors.join("; ")}`,
          ...(recordTrace ? { trace } : {})
        };
      }
    }
  }

  const turnsSimulated = state.completedTurns - initialCompletedTurns;
  const winnerId =
    state.winnerId ??
    state.players.find((p) => p.actualSimulatedVp >= state.rules.victoryPointsToWin)?.id;

  return {
    ...baseResultFields,
    status: "completed",
    completed: true,
    ...(winnerId !== undefined ? { winnerId } : {}),
    finalState: state,
    actionsSimulated,
    turnsSimulated,
    totalCompletedTurns: state.completedTurns,
    sampledDiceRolls,
    ...(recordTrace ? { trace } : {})
  };
}

/**
 * Runs a batch of independent determinized rollouts from an `ObservedGameState`.
 *
 * Each trial `i` uses a deterministically derived independent seed `deriveTrialSeed(baseSeed, i)`,
 * samples hidden state via `sampleDeterminization`, and runs `runRollout`.
 * Incomplete or failed trials are tracked separately and never folded into win/loss counts.
 */
export function runDeterminizedRollouts(
  observed: ObservedGameState,
  options: BatchRolloutOptions
): BatchRolloutSummary {
  const numTrials = Math.max(0, Math.trunc(options.numTrials));
  const policyId = options.rolloutOptions?.policy?.id ?? baselineRolloutPolicy.id;

  const effectiveDiceMode =
    options.determinizationOptions?.diceModeOverride ?? observed.rules.diceMode.mode;
  const diceResolution = options.rolloutOptions?.diceModel
    ? { ok: true as const, model: options.rolloutOptions.diceModel }
    : resolveDiceModelForRules(effectiveDiceMode, {
        modelId: options.rolloutOptions?.diceModelId,
        allowApproximationForUnknownMode: options.rolloutOptions?.allowApproximationForUnknownDiceMode
      });
  const diceModel = diceResolution.model;

  const winsByPlayerId: Record<string, number> = {};
  for (const pid of observed.playerOrder) {
    winsByPlayerId[pid] = 0;
  }

  const trials: BatchTrialRecord[] = [];
  let determinizationSuccessCount = 0;
  let determinizationFailureCount = 0;
  let completedCount = 0;
  let maxTurnsCutoffCount = 0;
  let maxActionsCutoffCount = 0;
  let failedRolloutCount = 0;

  for (let i = 0; i < numTrials; i++) {
    const trialSeed = deriveTrialSeed(options.baseSeed, i);
    const trialRng = createSeededRng(trialSeed);

    const detResult = sampleDeterminization(observed, trialRng.fork("determinize"), options.determinizationOptions);
    if (!detResult.ok) {
      determinizationFailureCount += 1;
      trials.push({
        trialIndex: i,
        trialSeed,
        determinizationOk: false,
        determinizationErrorCode: detResult.error.code,
        determinizationErrorMessage: detResult.error.message,
        rolloutStatus: "determinization_failed",
        completed: false,
        actionsSimulated: 0,
        turnsSimulated: 0,
        reason: detResult.error.message
      });
      continue;
    }

    determinizationSuccessCount += 1;
    const rolloutResult = runRollout(detResult.state, trialRng.fork("rollout"), {
      ...options.rolloutOptions,
      diceModel,
      initialRollHistory: observed.dice.observedRolls,
      diceAlignmentStatus: observed.dice.alignmentStatus
    });

    if (rolloutResult.completed && rolloutResult.status === "completed") {
      completedCount += 1;
      if (rolloutResult.winnerId !== undefined) {
        winsByPlayerId[rolloutResult.winnerId] = (winsByPlayerId[rolloutResult.winnerId] ?? 0) + 1;
      }
    } else if (rolloutResult.status === "max_turns_reached") {
      maxTurnsCutoffCount += 1;
    } else if (rolloutResult.status === "max_actions_reached") {
      maxActionsCutoffCount += 1;
    } else {
      failedRolloutCount += 1;
    }

    trials.push({
      trialIndex: i,
      trialSeed,
      determinizationOk: true,
      determinizationDiagnostics: detResult.diagnostics,
      rolloutStatus: rolloutResult.status,
      completed: rolloutResult.completed,
      ...(rolloutResult.winnerId !== undefined ? { winnerId: rolloutResult.winnerId } : {}),
      actionsSimulated: rolloutResult.actionsSimulated,
      turnsSimulated: rolloutResult.turnsSimulated,
      ...(rolloutResult.reason !== undefined ? { reason: rolloutResult.reason } : {})
    });
  }

  const cutoffCount = maxTurnsCutoffCount + maxActionsCutoffCount;
  const winRateAmongCompletedByPlayerId: Record<string, number | null> = {};
  for (const pid of observed.playerOrder) {
    winRateAmongCompletedByPlayerId[pid] = completedCount > 0 ? (winsByPlayerId[pid] ?? 0) / completedCount : null;
  }

  return {
    baseSeed: options.baseSeed,
    numTrials,
    policyId,
    diceModelId: diceModel.id,
    diceModelStatus: diceModel.status,
    diceModelIsExact: diceModel.isExact,
    determinizationSuccessCount,
    determinizationFailureCount,
    completedCount,
    cutoffCount,
    maxTurnsCutoffCount,
    maxActionsCutoffCount,
    failedRolloutCount,
    winsByPlayerId,
    winRateAmongCompletedByPlayerId,
    completionRate: numTrials > 0 ? completedCount / numTrials : 0,
    trials
  };
}
