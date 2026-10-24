import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import {
  DEVCARD_RULE_PROTOCOL,
  decideDevCardRule,
  devCardHoldoutSeedList,
  devCardSeedSetsAreDisjoint,
  developmentSeedList,
  type DevCardComparison
} from "../src/analyzer/benchmark/devcard-rule";
import { holdoutSeedList } from "../src/analyzer/benchmark/progress-diag";
import { DEFAULT_RACE_WEIGHTS } from "../src/analyzer/engine/race";
import { createSeededRng } from "../src/analyzer/engine/rng";
import {
  baselineRolloutPolicy,
  createHeuristicRolloutPolicy,
  devCardLeavesCityReserve,
  devCardResourceCost,
  productionAwareDevCardRolloutPolicy
} from "../src/analyzer/engine/rollout";
import { createInitialConcreteState, type SimulatedAction } from "../src/analyzer/engine/transition";
import type { ConcreteSimulatedGameState } from "../src/analyzer/engine/state";

const context = { stepIndex: 1, bankTradesThisTurn: 0 };
const root = resolve(__dirname, "..");

function mainState(): ConcreteSimulatedGameState {
  const opening = buildGeneratedOpening("devcard-rule-fixture");
  const created = createInitialConcreteState({
    topology: opening.topology,
    playerIds: ["c1", "c2"],
    rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
  });
  if (!created.ok) throw new Error(created.error.message);
  const state = created.state;
  state.phase = "main";
  state.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
  return state;
}

function cornerProducing(state: ConcreteSimulatedGameState, ore: boolean): number {
  const index = state.topology.corners.findIndex((corner) => {
    const resources = corner.hexIndices.map((hexIndex) => state.topology.hexes[hexIndex]).filter((hex) => hex.resource && hex.pips > 0);
    const hasOre = resources.some((hex) => hex.resource === "ore");
    return ore ? hasOre : resources.length > 0 && !hasOre;
  });
  if (index < 0) throw new Error(ore ? "no ore corner" : "no ore-free corner");
  return index;
}

function seat(state: ConcreteSimulatedGameState, playerId: "c1" | "c2", corner: number, hand: ConcreteSimulatedGameState["players"][number]["hand"], citiesLeft: number) {
  state.cornerOwner[corner] = playerId;
  state.cornerPiece[corner] = 1;
  const player = state.players.find((item) => item.id === playerId);
  if (!player) throw new Error(playerId);
  player.hand = hand;
  player.citiesLeft = citiesLeft;
}

function choose(policy: ReturnType<typeof createHeuristicRolloutPolicy>, state: ConcreteSimulatedGameState, actorId: string, legal: SimulatedAction[]) {
  return policy.selectAction(state, actorId, legal, createSeededRng(1), context);
}

function comparison(patch: Partial<DevCardComparison>): DevCardComparison {
  return {
    label: "synthetic",
    seeds: [],
    games: 10,
    completedGames: 10,
    completedPairs: 5,
    incompletePairs: 0,
    wins: 6,
    losses: 4,
    draws: 0,
    cutoffs: 0,
    cutoffRate: 0.2,
    maxTurnsCutoffs: 0,
    maxActionsCutoffs: 0,
    failures: 0,
    meanTurns: 40,
    meanFocusVp: 8,
    meanVpMargin: 0.4,
    meanFocusCitiesCompleted: 1.4,
    meanOpponentCitiesCompleted: 1.1,
    meanFocusCities: 1.2,
    meanFocusDevs: 2,
    meanOpponentDevs: 3,
    meanFocusDevsSpendingReserve: 0,
    meanOpponentDevsSpendingReserve: 1,
    focusLargestArmy: 1,
    opponentLargestArmy: 1,
    meanFocusFinalOre: 1,
    meanFocusFinalGrain: 1,
    meanFocusOreSpentOnDevs: 2,
    meanFocusGrainSpentOnDevs: 2,
    meanPairScore: 0.6,
    pairInterval: { n: 5, mean: 0.1, low: 0.02, high: 0.2 },
    elapsedMs: 1,
    ...patch
  };
}

describe("production-aware development-card rule", () => {
  const dev = { type: "buyDevCard" } as const;
  const end = { type: "endTurn" } as const;
  const cost = devCardResourceCost();

  it("keeps the baseline decision when the gate is off", () => {
    const state = mainState();
    const corner = cornerProducing(state, true);
    seat(state, "c1", corner, { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }, 0);
    const plain = createHeuristicRolloutPolicy("baseline_heuristic_v1", true);
    const explicitOff = createHeuristicRolloutPolicy("baseline_heuristic_v1", true, undefined, false, false);
    expect(baselineRolloutPolicy.id).toBe("baseline_heuristic_v1");
    expect(choose(baselineRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
    expect(choose(plain, state, "c1", [dev, end])).toEqual(choose(baselineRolloutPolicy, state, "c1", [dev, end]));
    expect(choose(explicitOff, state, "c1", [dev, end])).toEqual(choose(baselineRolloutPolicy, state, "c1", [dev, end]));
    expect(DEFAULT_RACE_WEIGHTS).toEqual({ lostPenalty: 12, uncertainPenalty: 1.5, urgentBonus: 1.5 });
  });

  it("rejects a dev card that would spend the city reserve when ore production is positive", () => {
    const state = mainState();
    const corner = cornerProducing(state, true);
    seat(state, "c1", corner, { lumber: 0, brick: 0, wool: 1, grain: cost.grain, ore: cost.ore }, 0);
    expect(devCardLeavesCityReserve(state.players[0].hand)).toBe(false);
    expect(choose(baselineRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [dev, end])).toEqual(end);
  });

  it("still buys a dev card when the city reserve remains", () => {
    const state = mainState();
    const corner = cornerProducing(state, true);
    const hand = { lumber: 0, brick: 0, wool: 1, grain: cost.grain + 2, ore: cost.ore + 3 };
    seat(state, "c1", corner, hand, 0);
    expect(devCardLeavesCityReserve(hand)).toBe(true);
    expect(choose(baselineRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
  });

  it("does not add a dev purchase the baseline already refuses", () => {
    const state = mainState();
    const corner = cornerProducing(state, true);
    const hand = { lumber: 0, brick: 0, wool: 1, grain: cost.grain + 2, ore: cost.ore + 3 };
    seat(state, "c1", corner, hand, 4);
    expect(choose(baselineRolloutPolicy, state, "c1", [dev, end])).toEqual(end);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [dev, end])).toEqual(end);
  });

  it("keeps the baseline buy when the seat produces no ore", () => {
    const state = mainState();
    const corner = cornerProducing(state, false);
    seat(state, "c1", corner, { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }, 0);
    expect(choose(baselineRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
  });

  it("uses the acting player's production and hand", () => {
    const state = mainState();
    const ore = cornerProducing(state, true);
    const other = cornerProducing(state, false);
    seat(state, "c1", other, { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }, 0);
    seat(state, "c2", ore, { lumber: 0, brick: 0, wool: 0, grain: 8, ore: 8 }, 4);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [dev, end])).toEqual(dev);
    const blocked = mainState();
    seat(blocked, "c1", cornerProducing(blocked, true), { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 }, 0);
    seat(blocked, "c2", cornerProducing(blocked, false), { lumber: 0, brick: 0, wool: 0, grain: 8, ore: 8 }, 0);
    expect(choose(baselineRolloutPolicy, blocked, "c1", [dev, end])).toEqual(dev);
    expect(choose(productionAwareDevCardRolloutPolicy, blocked, "c1", [dev, end])).toEqual(end);
  });

  it("leaves city selection unchanged and differs only on the gated buy", () => {
    const state = mainState();
    const corner = cornerProducing(state, true);
    seat(state, "c1", corner, { lumber: 0, brick: 0, wool: 1, grain: 2, ore: 3 }, 4);
    const city: SimulatedAction = { type: "buildCity", cornerIndex: corner };
    expect(choose(baselineRolloutPolicy, state, "c1", [city, dev, end])).toEqual(city);
    expect(choose(productionAwareDevCardRolloutPolicy, state, "c1", [city, dev, end])).toEqual(city);
  });

  it("does not enable the rule in the live coach or the default rollout", () => {
    for (const file of ["src/analyzer/engine/decide.ts", "src/extension/helper.ts", "src/analyzer/engine/shadow.ts", "src/analyzer/benchmark/run.ts"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toContain("productionAwareDevCards");
      expect(source).not.toContain("production_aware_dev_card_v1");
    }
    expect(productionAwareDevCardRolloutPolicy.id).toBe("production_aware_dev_card_v1");
    expect(baselineRolloutPolicy.id).not.toBe(productionAwareDevCardRolloutPolicy.id);
  });

  it("freezes the seed lists and the acceptance rule", () => {
    expect(developmentSeedList()).toEqual(["race-tune-dev-0", "race-tune-dev-1", "race-tune-dev-2", "race-tune-dev-3", "race-tune-dev-4", "race-tune-dev-5", "race-tune-dev-6", "race-tune-dev-7"]);
    expect(devCardHoldoutSeedList()).toHaveLength(100);
    expect(devCardHoldoutSeedList()[0]).toBe("devcard-rule-holdout-0");
    expect(devCardHoldoutSeedList()[99]).toBe("devcard-rule-holdout-99");
    expect(devCardSeedSetsAreDisjoint()).toBe(true);
    expect(devCardHoldoutSeedList().some((seed) => holdoutSeedList().includes(seed))).toBe(false);
    expect(DEVCARD_RULE_PROTOCOL.victoryPointsToWin).toBe(10);
    expect(DEVCARD_RULE_PROTOCOL.maxTurns).toBe(70);
    expect(DEVCARD_RULE_PROTOCOL.maxActions).toBe(450);
    expect(decideDevCardRule(comparison({})).decision).toBe("adopt");
    expect(decideDevCardRule(comparison({ pairInterval: { n: 5, mean: -0.1, low: -0.2, high: -0.01 } })).decision).toBe("retain");
    expect(decideDevCardRule(comparison({ pairInterval: { n: 5, mean: 0.01, low: -0.02, high: 0.04 } })).decision).toBe("inconclusive");
    expect(decideDevCardRule(comparison({ cutoffRate: 0.5 })).decision).toBe("retain");
    expect(decideDevCardRule(comparison({ meanVpMargin: -1.2 })).decision).toBe("retain");
    expect(decideDevCardRule(comparison({ meanFocusCitiesCompleted: 0.4, meanOpponentCitiesCompleted: 1.2 })).decision).toBe("retain");
    expect(decideDevCardRule(comparison({ meanFocusDevs: 0 })).decision).toBe("retain");
  });
});
