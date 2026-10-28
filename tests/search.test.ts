import { describe, expect, it } from "vitest";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { createSeededRng } from "../src/analyzer/engine/rng";
import { baselineRolloutPolicy, type RolloutPolicy } from "../src/analyzer/engine/rollout";
import {
  createSearchPolicy,
  projectPolicyObservation,
  selectSearchRootCandidates,
  withObservationBoundary
} from "../src/analyzer/engine/search";
import { cloneConcreteSimState, type ConcreteSimulatedGameState } from "../src/analyzer/engine/state";
import { createInitialConcreteState, getLegalActions, isActionLegal, type SimulatedAction } from "../src/analyzer/engine/transition";

const context = { stepIndex: 3, bankTradesThisTurn: 0 };

function openingState(): ConcreteSimulatedGameState {
  const opening = buildGeneratedOpening("search-v1-fixture");
  const created = createInitialConcreteState({
    topology: opening.topology,
    playerIds: ["c1", "c2"],
    rules: { victoryPointsToWin: 15, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.state;
}

function snapshot(state: ConcreteSimulatedGameState): string {
  return JSON.stringify({
    phase: state.phase,
    turn: state.turnPlayerIndex,
    robber: state.robberHexIndex,
    hands: state.players.map((player) => player.hand),
    devs: state.players.map((player) => ({ ready: player.readyDevs, bought: player.boughtDevsThisTurn, vp: player.vpDevs })),
    deck: state.devDeckOrder,
    corners: state.cornerOwner,
    edges: state.edgeOwner
  });
}

describe("search_v1", () => {
  it("keeps the baseline id and does not become the default rollout policy", () => {
    expect(baselineRolloutPolicy.id).toBe("baseline_heuristic_v1");
    expect(createSearchPolicy().id).toBe("search_v1");
  });

  it("searches only legal actions, leaves the state unchanged, and repeats under a seed", () => {
    const state = openingState();
    const before = snapshot(state);
    const legal = getLegalActions(state, "c1");
    const policy = createSearchPolicy({
      rootK: 4,
      rolloutsPerCandidate: 4,
      maxSimulatedTurns: 0,
      maxSimulatedActions: 8,
      masterSeed: "search-smoke",
      validateEveryStep: true
    });
    const first = policy.selectAction(state, "c1", legal, createSeededRng(11), context);
    const second = createSearchPolicy({
      rootK: 4,
      rolloutsPerCandidate: 4,
      maxSimulatedTurns: 0,
      maxSimulatedActions: 8,
      masterSeed: "search-smoke",
      validateEveryStep: true
    }).selectAction(cloneConcreteSimState(state), "c1", legal, createSeededRng(11), context);
    expect(snapshot(state)).toBe(before);
    expect(isActionLegal(state, "c1", first)).toBe(true);
    expect(first).toEqual(second);
    const diagnostic = policy.diagnostics();
    expect(diagnostic.simulations).toBeLessThanOrEqual(16);
    expect(diagnostic.simulations).toBeGreaterThan(0);
    expect(diagnostic.last?.candidates.every((candidate) => legal.some((action) => actionKey(action) === candidate.action))).toBe(true);
    expect(diagnostic.last?.candidates.some((candidate) => candidate.cutoffSamples > 0)).toBe(true);
    expect(diagnostic.failedSamples).toBe(0);
  });

  it("stops at the hard simulation budget and falls back when search cannot score", () => {
    const state = openingState();
    const legal = getLegalActions(state, "c1");
    const capped = createSearchPolicy({
      rootK: 4,
      rolloutsPerCandidate: 4,
      maxSimulations: 3,
      maxSimulatedTurns: 0,
      maxSimulatedActions: 4,
      masterSeed: "budget"
    });
    capped.selectAction(state, "c1", legal, createSeededRng(1), context);
    expect(capped.diagnostics().simulations).toBeLessThanOrEqual(3);

    const fallback = createSearchPolicy({ rootK: 4, rolloutsPerCandidate: 4, maxSimulations: 0, masterSeed: "fallback" });
    const selected = fallback.selectAction(state, "c1", legal, createSeededRng(2), context);
    const baseline = baselineRolloutPolicy.selectAction(projectPolicyObservation(state, "c1"), "c1", legal, createSeededRng(2), context);
    expect(selected).toEqual(baseline);
    expect(fallback.diagnostics().last?.fallback).toBe(true);
  });

  it("does not let a concealed opponent hand change a decision when the observation matches", () => {
    const state = openingState();
    state.phase = "main";
    state.dice = { thrown: true, d1: 2, d2: 3, total: 5 };
    state.players[0].hand = { lumber: 0, brick: 0, wool: 4, grain: 1, ore: 1 };
    state.players[1].hand = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 4 };
    const other = cloneConcreteSimState(state);
    other.players[1].hand = { lumber: 4, brick: 0, wool: 0, grain: 0, ore: 0 };
    const legal = getLegalActions(state, "c1");
    expect(legal.some((action) => action.type === "endTurn")).toBe(true);
    expect(legal.length).toBeGreaterThan(1);

    const peeker: RolloutPolicy = {
      id: "peeker",
      selectAction(view, actorId, actions) {
        const opponent = view.players.find((player) => player.id !== actorId);
        const sawOre = (opponent?.hand.ore ?? 0) > 0;
        const end = actions.find((action) => action.type === "endTurn");
        const otherAction = actions.find((action) => action.type !== "endTurn");
        return (sawOre ? end : otherAction) ?? actions[0];
      }
    };
    const wrapped = withObservationBoundary(peeker);
    const left = wrapped.selectAction(state, "c1", legal, createSeededRng(1), context);
    const right = wrapped.selectAction(other, "c1", legal, createSeededRng(1), context);
    expect(left).toEqual(right);
    expect(peeker.selectAction(state, "c1", legal, createSeededRng(1), context)).not.toEqual(
      peeker.selectAction(other, "c1", legal, createSeededRng(1), context)
    );

    const baselineLeft = baselineRolloutPolicy.selectAction(state, "c1", legal, createSeededRng(4), context);
    const baselineRight = baselineRolloutPolicy.selectAction(other, "c1", legal, createSeededRng(4), context);
    expect(baselineLeft).toEqual(baselineRight);
  });

  it("plays the root action through the engine and keeps later phases inside the horizon", () => {
    const state = openingState();
    const legal = getLegalActions(state, "c1");
    const policy = createSearchPolicy({
      rootK: 2,
      rolloutsPerCandidate: 2,
      maxSimulatedTurns: 2,
      maxSimulatedActions: 24,
      masterSeed: "phase-smoke",
      validateEveryStep: true
    });
    const selected = policy.selectAction(state, "c1", legal, createSeededRng(9), context);
    expect(isActionLegal(state, "c1", selected)).toBe(true);
    const diagnostic = policy.diagnostics();
    expect(diagnostic.failedSamples).toBe(0);
    expect(diagnostic.simulations).toBe(4);
    expect(diagnostic.terminalSamples + diagnostic.cutoffSamples).toBe(4);
    expect(state.phase).toBe("setup_settlement");
  });

  it("keeps the baseline action and spreads the candidate budget across action types", () => {
    const legal: SimulatedAction[] = [
      { type: "buildRoad", edgeIndex: 1 },
      { type: "buildRoad", edgeIndex: 2 },
      { type: "buildRoad", edgeIndex: 3 },
      { type: "bankTrade", give: "wool", receive: "ore" },
      { type: "endTurn" },
      { type: "buyDevCard" }
    ];
    const chosen = selectSearchRootCandidates(legal, legal[0], () => 1, 4);
    expect(chosen[0]).toEqual(legal[0]);
    expect(new Set(chosen.map((action) => action.type)).size).toBeGreaterThan(1);
    expect(chosen).toHaveLength(4);
    expect(chosen.every((action) => legal.includes(action))).toBe(true);
  });
});

function actionKey(action: SimulatedAction): string {
  if (action.type === "placeSetupSettlement" || action.type === "buildSettlement" || action.type === "buildCity") {
    return `${action.type}:${action.cornerIndex}`;
  }
  if (action.type === "placeSetupRoad" || action.type === "buildRoad" || action.type === "placeFreeRoad") {
    return `${action.type}:${action.edgeIndex}`;
  }
  return action.type;
}
