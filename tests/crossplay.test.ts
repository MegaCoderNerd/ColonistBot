import { describe, expect, it } from "vitest";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { runCrossPlay } from "../src/analyzer/benchmark/crossplay";
import { createInitialConcreteState } from "../src/analyzer/engine/transition";
import { createSeededRng } from "../src/analyzer/engine/rng";
import {
  baselineDistanceOnlyRolloutPolicy,
  baselineRolloutPolicy
} from "../src/analyzer/engine/rollout";
import {
  aggressiveDevRolloutPolicy,
  longestRoadRolloutPolicy,
  settlementRacerRolloutPolicy
} from "../src/analyzer/engine/policies";
import type { SimulatedAction } from "../src/analyzer/engine/transition";

describe("Recording-free cross-play", () => {
  it("builds a standard opening without a recording and repeats it from the seed", () => {
    const first = buildGeneratedOpening("crossplay-board");
    const second = buildGeneratedOpening("crossplay-board");
    expect(first.topology.variant.isStandard19Hex).toBe(true);
    expect(first.topology.colonistIdsSource).not.toBe("none");
    expect(first.board.hexes.filter((hex) => hex.resource === "lumber")).toHaveLength(4);
    expect(first.board.hexes.filter((hex) => hex.resource === null)).toHaveLength(1);
    expect(first.board.hexes.filter((hex) => hex.number !== null)).toHaveLength(18);
    expect(first.board.ports?.length).toBeGreaterThan(0);
    expect(first.board.hexes.map((hex) => `${hex.resource}:${hex.number}`)).toEqual(
      second.board.hexes.map((hex) => `${hex.resource}:${hex.number}`)
    );
    const created = createInitialConcreteState({
      topology: first.topology,
      playerIds: ["c1", "c2"],
      rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
    });
    expect(created.ok).toBe(true);
  });

  it("makes the roster choose different legal actions from the same position", () => {
    const opening = buildGeneratedOpening("policy-probe");
    const created = createInitialConcreteState({
      topology: opening.topology,
      playerIds: ["c1", "c2"],
      rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
    });
    if (!created.ok) throw new Error(created.error.message);
    const state = created.state;
    state.phase = "main";
    state.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
    state.players[0].hand = { lumber: 2, brick: 2, wool: 2, grain: 4, ore: 4 };
    const legalActions: SimulatedAction[] = [
      { type: "buildCity", cornerIndex: 0 },
      { type: "buildSettlement", cornerIndex: 4 },
      { type: "buildRoad", edgeIndex: 0 },
      { type: "buyDevCard" },
      { type: "endTurn" }
    ];
    const rng = createSeededRng(1);
    const context = { stepIndex: 0, bankTradesThisTurn: 0 };
    const choices = {
      baseline: baselineRolloutPolicy.selectAction(state, "c1", legalActions, rng, context).type,
      distanceOnly: baselineDistanceOnlyRolloutPolicy.selectAction(state, "c1", legalActions, rng, context).type,
      racer: settlementRacerRolloutPolicy.selectAction(state, "c1", legalActions, rng, context).type,
      dev: aggressiveDevRolloutPolicy.selectAction(state, "c1", legalActions, rng, context).type,
      road: longestRoadRolloutPolicy.selectAction(state, "c1", legalActions, rng, context).type
    };
    expect(choices.baseline).toBe("buildCity");
    expect(choices.distanceOnly).toBe("buildCity");
    expect(choices.racer).toBe("buildSettlement");
    expect(choices.dev).toBe("buyDevCard");
    expect(choices.road).toBe("buildRoad");
    expect(new Set([choices.baseline, choices.racer, choices.dev, choices.road]).size).toBe(4);
  });

  it("trades toward a city once the settlement racer has no settlements left", () => {
    const opening = buildGeneratedOpening("policy-probe");
    const created = createInitialConcreteState({
      topology: opening.topology,
      playerIds: ["c1", "c2"],
      rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
    });
    if (!created.ok) throw new Error(created.error.message);
    const state = created.state;
    state.phase = "main";
    state.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
    state.players[0].settlementsLeft = 0;
    state.players[0].hand = { lumber: 0, brick: 4, wool: 0, grain: 2, ore: 0 };
    const legalActions: SimulatedAction[] = [
      { type: "bankTrade", give: "brick", receive: "wool", giveCount: 4, receiveCount: 1 },
      { type: "bankTrade", give: "brick", receive: "ore", giveCount: 4, receiveCount: 1 },
      { type: "endTurn" }
    ];
    const chosen = settlementRacerRolloutPolicy.selectAction(state, "c1", legalActions, createSeededRng(1), {
      stepIndex: 0,
      bankTradesThisTurn: 0
    });
    expect(chosen).toEqual({ type: "bankTrade", give: "brick", receive: "ore", giveCount: 4, receiveCount: 1 });
  });

  it("repeats a seeded matchup and keeps cutoffs out of the win count", () => {
    const opening = buildGeneratedOpening("crossplay-repeat");
    const options = {
      topology: opening.topology,
      seed: "repeat-seed",
      trials: 1,
      victoryPointsToWin: 10,
      maxTurns: 8,
      maxActions: 40,
      pairs: [["baseline", "racer"]] as const
    };
    const first = runCrossPlay(options);
    const second = runCrossPlay(options);
    expect(first.matchups.map((matchup) => matchup.focusPlayerId).sort()).toEqual(["c1", "c2"]);
    expect(first.trials.map((trial) => [trial.status, trial.outcome, trial.focusVp, trial.turns, trial.winnerId ?? ""])).toEqual(
      second.trials.map((trial) => [trial.status, trial.outcome, trial.focusVp, trial.turns, trial.winnerId ?? ""])
    );
    for (const matchup of first.matchups) {
      expect(matchup.wins + matchup.losses + matchup.draws).toBe(matchup.completed);
      expect(matchup.completed + matchup.cutoffs + matchup.failures).toBe(matchup.trials);
      expect(matchup.establishes.toLowerCase()).toContain("inconclusive");
    }

    const cutoff = runCrossPlay({ ...options, maxTurns: 1, maxActions: 4 });
    for (const trial of cutoff.trials) {
      expect(trial.completed).toBe(false);
      expect(trial.outcome).toBe("incomplete");
    }
    for (const matchup of cutoff.matchups) {
      expect(matchup.wins).toBe(0);
      expect(matchup.completed).toBe(0);
      expect(matchup.cutoffs).toBe(matchup.trials);
    }
  });
});
