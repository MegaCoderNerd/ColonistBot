/**
 * Stage 3.5 — Diagnostic rollout policies for offline policy evaluation.
 *
 * ADDITIVE ONLY. This module introduces additional `RolloutPolicy` implementations used
 * exclusively by the Stage 3.5 offline benchmark harness. It does NOT modify
 * `baselineRolloutPolicy`, production recommendations, shadow mode, or any game rule.
 *
 * Every policy here obeys the same contract as `baselineRolloutPolicy`:
 * - Selects ONLY from the `legalActions` array supplied by Stage 3.2 `getLegalActions`.
 * - Takes any immediate legal winning action first (via the shared `findImmediateWinningAction`).
 * - Uses only public board information plus the actor's own hand/devs (never opponent hands
 *   or `devDeckOrder`), so no policy gains an unfair information advantage in comparisons.
 */

import { RESOURCES, type ResourceBag } from "../types";
import { getLegalSettlementCorners, type SimulatedAction } from "./transition";
import {
  computeRoadLengthOnTopology,
  type ConcreteSimulatedGameState,
  type ConcreteSimulatedPlayerState
} from "./state";
import { findImmediateWinningAction, type RolloutPolicy, type RolloutPolicyContext } from "./rollout";
import type { SeededRng } from "./rng";

const COST_CITY: ResourceBag = { grain: 2, ore: 3 };
const COST_SETTLEMENT: ResourceBag = { lumber: 1, brick: 1, wool: 1, grain: 1 };
const COST_DEV: ResourceBag = { wool: 1, grain: 1, ore: 1 };

function sumHand(h: ConcreteSimulatedPlayerState["hand"]): number {
  return RESOURCES.reduce((s, r) => s + h[r], 0);
}

function deficitForCost(hand: ConcreteSimulatedPlayerState["hand"], cost: ResourceBag): number {
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
    if (rate >= 2 && rate <= 4) multiples += Math.floor(surplus / rate);
  }
  return multiples;
}

function robberBlocksActorProduction(
  state: ConcreteSimulatedGameState,
  actorId: string
): boolean {
  const robberHex = state.topology.hexes[state.robberHexIndex];
  if (!robberHex) return false;
  return robberHex.cornerIndices.some((cornerIndex) =>
    state.cornerOwner[cornerIndex] === actorId && state.cornerPiece[cornerIndex] > 0
  );
}

type BankTradeAction = Extract<SimulatedAction, { type: "bankTrade" }>;

function selectBankTradeForTarget(
  player: ConcreteSimulatedPlayerState,
  targetCost: ResourceBag,
  bankTrades: ReadonlyArray<BankTradeAction>,
  allowPartialProgress: boolean
): BankTradeAction | undefined {
  const missing = deficitForCost(player.hand, targetCost);
  if (missing <= 0) return undefined;
  const multiples = tradeableMultiplesOutsideCost(player, targetCost);
  if (multiples <= 0) return undefined;
  if (!allowPartialProgress && multiples < missing) return undefined;

  let best: BankTradeAction | undefined;
  let bestScore = -Infinity;
  for (const trade of bankTrades) {
    const { give, receive } = trade;
    const rate = player.ratios[give];
    const keepGive = targetCost[give] ?? 0;
    const needReceive = targetCost[receive] ?? 0;
    if (player.hand[receive] >= needReceive) continue;
    if (player.hand[give] - rate < keepGive) continue;
    const score = (player.hand[give] - keepGive) / rate + (needReceive - player.hand[receive]) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = trade;
    }
  }
  return best;
}

/**
 * Diagnostic baseline: uniform random choice among the currently legal actions.
 *
 * This is a FLOOR for measurement, not a competitive target. It exists so the benchmark can
 * report how much of a policy's measured win rate comes from actually reasoning about the
 * position rather than from the simulation engine's own forward progress. Random play also
 * surfaces cutoff-heavy behaviour, which is recorded separately from completed-game outcomes.
 */
export const randomLegalRolloutPolicy: RolloutPolicy = {
  id: "random_legal_diagnostic_v1",

  selectAction(
    _state: ConcreteSimulatedGameState,
    _actorId: string,
    legalActions: readonly SimulatedAction[],
    rng: SeededRng,
    _context: RolloutPolicyContext
  ): SimulatedAction {
    if (legalActions.length === 0) {
      // `runRollout` never calls a policy with an empty action set, but stay defensive so this
      // policy can never be the source of an `unsupported_action` failure.
      return { type: "endTurn" };
    }
    if (legalActions.length === 1) return legalActions[0];
    return rng.pick(legalActions);
  }
};

/**
 * Additional testable heuristic: development-card-first policy.
 *
 * Deliberately contrasts with `baselineRolloutPolicy` (which builds before buying dev cards)
 * so the benchmark can measure whether accumulating hidden VP and Knights earlier helps or
 * hurts. Priorities in `main`: immediate win -> buy dev card -> play knight -> city ->
 * settlement -> trade toward a dev card -> road for expansion -> end turn.
 *
 * Robber, discard and setup phases use rule-constrained or defensive logic, because those
 * phases are not the strategic axis this policy is designed to vary.
 */
export const aggressiveDevRolloutPolicy: RolloutPolicy = {
  id: "aggressive_dev_heuristic_v1",

  selectAction(
    state: ConcreteSimulatedGameState,
    actorId: string,
    legalActions: readonly SimulatedAction[],
    rng: SeededRng,
    context: RolloutPolicyContext
  ): SimulatedAction {
    if (legalActions.length === 0) return { type: "endTurn" };
    if (legalActions.length === 1) return legalActions[0];

    const immediateWin = findImmediateWinningAction(state, actorId, legalActions);
    if (immediateWin) return immediateWin;

    const actor = state.players.find((p) => p.id === actorId) ?? state.players[state.turnPlayerIndex];

    switch (state.phase) {
      case "setup_settlement": {
        const scored = legalActions
          .filter(
            (a): a is Extract<SimulatedAction, { type: "placeSetupSettlement" }> =>
              a.type === "placeSetupSettlement"
          )
          .map((action) => {
            const corner = state.topology.corners[action.cornerIndex];
            let score = corner?.pips ?? 0;
            if (corner?.port === "any") score += 6;
            else if (corner?.port) score += 8;
            score += (corner?.resources.length ?? 0) * 2;
            return { action, score };
          })
          .sort((a, b) => b.score - a.score);
        if (scored.length >= 2 && scored[0].score - scored[1].score <= 2) {
          return scored[rng.weightedIndex([4, 1])].action;
        }
        return scored[0]?.action ?? rng.pick(legalActions);
      }

      case "setup_road": {
        const roadActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "placeSetupRoad" }> => a.type === "placeSetupRoad"
        );
        let bestRoad = roadActions[0];
        let bestScore = -Infinity;
        for (const action of roadActions) {
          const edge = state.topology.edges[action.edgeIndex];
          let score = 0;
          for (const ci of edge ? [edge.c1, edge.c2] : []) {
            const corner = state.topology.corners[ci];
            if (state.cornerPiece[ci] !== 0) continue;
            score += corner?.pips ?? 0;
            if (corner?.port === "any") score += 4;
            else if (corner?.port) score += 5;
          }
          if (score > bestScore) {
            bestScore = score;
            bestRoad = action;
          }
        }
        return bestRoad ?? rng.pick(legalActions);
      }

      case "pre_roll": {
        const knightAction = legalActions.find((a) => a.type === "playKnight");
        if (knightAction) return knightAction;
        return legalActions.find((a) => a.type === "rollDice") ?? rng.pick(legalActions);
      }

      case "discard": {
        // Rule-constrained phase: keep the best remaining build shape.
        const discardActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "discard" }> => a.type === "discard"
        );
        let bestDiscard = discardActions[0];
        let bestScore = -Infinity;
        for (const action of discardActions) {
          const rem = {
            lumber: actor.hand.lumber - (action.cards.lumber ?? 0),
            brick: actor.hand.brick - (action.cards.brick ?? 0),
            wool: actor.hand.wool - (action.cards.wool ?? 0),
            grain: actor.hand.grain - (action.cards.grain ?? 0),
            ore: actor.hand.ore - (action.cards.ore ?? 0)
          };
          const sc =
            -deficitForCost(rem, COST_DEV) * 3 -
            deficitForCost(rem, COST_CITY) * 2 -
            deficitForCost(rem, COST_SETTLEMENT);
          if (sc > bestScore) {
            bestScore = sc;
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
            if (ownerId === actorId) sc -= 40 * weight;
            else sc += hex.pips * weight * 3;
          }
          if (action.victimId) {
            const victim = state.players.find((p) => p.id === action.victimId);
            if (victim) sc += 8 + victim.visibleVp * 1.5;
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
          const nextEdgeOwner = [...state.edgeOwner];
          nextEdgeOwner[action.edgeIndex] = actorId;
          const newLen = computeRoadLengthOnTopology(
            state.topology,
            state.cornerOwner,
            nextEdgeOwner,
            actorId
          );
          const lenGain = Math.max(0, newLen - actor.roadLength);
          if (lenGain > bestScore) {
            bestScore = lenGain;
            bestRoad = action;
          }
        }
        return bestRoad ?? rng.pick(legalActions);
      }

      case "year_of_plenty": {
        const yop = legalActions.find(
          (a): a is Extract<SimulatedAction, { type: "playYearOfPlenty" }> =>
            a.type === "playYearOfPlenty"
        );
        return yop ?? rng.pick(legalActions);
      }

      case "monopoly": {
        const mono = legalActions.find(
          (a): a is Extract<SimulatedAction, { type: "playMonopoly" }> => a.type === "playMonopoly"
        );
        return mono ?? rng.pick(legalActions);
      }


      case "main": {
        // A Knight immediately restores the actor's blocked production. This narrowly precedes
        // the dev-card preference; unrelated Knights remain part of the normal priority below.
        const defensiveKnight = legalActions.find((a) => a.type === "playKnight");
        if (defensiveKnight && robberBlocksActorProduction(state, actorId)) {
          return defensiveKnight;
        }

        // 1. Buy a development card first (this policy's defining behaviour).
        const buyDev = legalActions.find((a) => a.type === "buyDevCard");
        if (buyDev && state.devDeckOrder.length > 0 && deficitForCost(actor.hand, COST_DEV) === 0) {
          return buyDev;
        }

        // 2. Spend a Knight for Largest Army pressure.
        const knight = defensiveKnight;
        if (knight) return knight;

        // 3. City, then settlement (VP-first, as in the baseline).
        const cityActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildCity" }> => a.type === "buildCity"
        );
        if (cityActions.length > 0) {
          cityActions.sort((a, b) => {
            const pa = state.topology.corners[a.cornerIndex]?.pips ?? 0;
            const pb = state.topology.corners[b.cornerIndex]?.pips ?? 0;
            return pb - pa;
          });
          return cityActions[0];
        }

        const settleActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildSettlement" }> => a.type === "buildSettlement"
        );
        if (settleActions.length > 0) {
          settleActions.sort((a, b) => {
            const pa = state.topology.corners[a.cornerIndex]?.pips ?? 0;
            const pb = state.topology.corners[b.cornerIndex]?.pips ?? 0;
            return pb - pa;
          });
          return settleActions[0];
        }

        // 4. Trade toward a dev card.
        const bankTrades = legalActions.filter((a): a is BankTradeAction => a.type === "bankTrade");
        if (bankTrades.length > 0 && context.bankTradesThisTurn < 4 && state.devDeckOrder.length > 0) {
          const overDiscardLimit = sumHand(actor.hand) > state.rules.cardDiscardLimit;
          const trade = selectBankTradeForTarget(actor, COST_DEV, bankTrades, overDiscardLimit);
          if (trade) return trade;
        }

        // 5. Road only when it is genuinely needed to reach a new settlement spot.
        const roadActions = legalActions.filter(
          (a): a is Extract<SimulatedAction, { type: "buildRoad" }> => a.type === "buildRoad"
        );
        if (roadActions.length > 0) {
          const canSettleNow =
            actor.settlementsLeft > 0 && getLegalSettlementCorners(state, actorId).length > 0;
          if (!canSettleNow) {
            let bestRoad = roadActions[0];
            let bestScore = -Infinity;
            for (const action of roadActions) {
              const edge = state.topology.edges[action.edgeIndex];
              let score = 0;
              for (const ci of edge ? [edge.c1, edge.c2] : []) {
                if (state.cornerPiece[ci] !== 0) continue;
                score += state.topology.corners[ci]?.pips ?? 0;
              }
              if (score > bestScore) {
                bestScore = score;
                bestRoad = action;
              }
            }
            return bestRoad;
          }
        }

        return legalActions.find((a) => a.type === "endTurn") ?? rng.pick(legalActions);
      }

      default:
        return rng.pick(legalActions);
    }
  }
};

/**
 * All Stage 3.5 diagnostic policies added by this module, in a stable order so generated
 * reports are reproducible. The production `baselineRolloutPolicy` is imported separately by
 * the harness so it is always evaluated alongside these.
 */
export const STAGE_3_5_DIAGNOSTIC_POLICIES: readonly RolloutPolicy[] = [
  aggressiveDevRolloutPolicy,
  randomLegalRolloutPolicy
];
