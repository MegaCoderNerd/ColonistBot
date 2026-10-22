import { describe, expect, it } from "vitest";
import { assessSettlementRace, DEFAULT_RACE_WEIGHTS, RACE_PORT_INCREMENT } from "../src/analyzer/engine/race";
import {
  baselineDistanceOnlyRolloutPolicy,
  baselineRolloutPolicy,
  createHeuristicRolloutPolicy
} from "../src/analyzer/engine/rollout";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { playBothSeats, type CrossPlayTrial } from "../src/analyzer/benchmark/crossplay";
import { applyAction, createInitialConcreteState, getLegalActions } from "../src/analyzer/engine/transition";
import { createSeededRng } from "../src/analyzer/engine/rng";
import {
  RACE_TUNE_CANDIDATES,
  RACE_TUNE_PROTOCOL,
  bootstrapMeanDifference,
  confirmationSeedList,
  developmentSeedList,
  seedSetsAreDisjoint,
  selectRaceCandidate,
  type CandidateEvaluation,
  type SeedPair
} from "../src/analyzer/benchmark/race-tune";

function raceInput(weights?: { lostPenalty: number; uncertainPenalty: number; urgentBonus: number }) {
  return {
    myRoads: 2,
    opponentRoads: 0,
    myProduction: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
    opponentProduction: { lumber: 10, brick: 10, wool: 5, grain: 5, ore: 0 },
    myHand: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
    opponentKnown: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
    opponentUnknown: 0,
    ...(weights ? { weights } : {})
  };
}

function evaluation(label: string, scores: readonly (number | null)[], cutoffRate: number, meanVpMargin: number | null): CandidateEvaluation {
  const pairs: SeedPair[] = scores.map((score, index) => ({
    seed: `s${index}`,
    c1: {} as CrossPlayTrial,
    c2: {} as CrossPlayTrial,
    bothCompleted: score !== null,
    score
  }));
  return {
    id: label,
    label,
    weights: null,
    pairs,
    games: scores.length * 2,
    completedGames: scores.filter((score) => score !== null).length * 2,
    completedPairs: scores.filter((score) => score !== null).length,
    wins: 0,
    losses: 0,
    draws: 0,
    cutoffs: 0,
    failures: 0,
    cutoffRate,
    meanPairScore: null,
    meanVpMargin,
    meanTurns: null,
    meanDeadEndRoads: null,
    meanBlockedRoads: null,
    meanMainSettlements: null,
    elapsedMs: 0
  };
}

describe("Race-weight protocol", () => {
  it("keeps development and confirmation seeds disjoint and frozen", () => {
    const development = developmentSeedList();
    const confirmation = confirmationSeedList();
    expect(development).toHaveLength(RACE_TUNE_PROTOCOL.developmentSeeds);
    expect(confirmation).toHaveLength(RACE_TUNE_PROTOCOL.confirmationSeeds);
    expect(RACE_TUNE_PROTOCOL.developmentSeeds).toBe(100);
    expect(RACE_TUNE_PROTOCOL.confirmationSeeds).toBe(200);
    expect(seedSetsAreDisjoint(development, confirmation)).toBe(true);
    expect(development[0].startsWith(RACE_TUNE_PROTOCOL.developmentPrefix)).toBe(true);
    expect(confirmation[0].startsWith(RACE_TUNE_PROTOCOL.confirmationPrefix)).toBe(true);
  });

  it("sends weight overrides into the race adjustment and leaves the port increment out of it", () => {
    const current = assessSettlementRace(raceInput());
    const strong = assessSettlementRace(raceInput({ lostPenalty: 24, uncertainPenalty: 4, urgentBonus: 4 }));
    const urgent = assessSettlementRace({
      ...raceInput(),
      myRoads: 1,
      opponentRoads: 3,
      myProduction: { lumber: 10, brick: 10, wool: 6, grain: 6, ore: 0 },
      weights: { lostPenalty: 12, uncertainPenalty: 0, urgentBonus: 4 }
    });
    expect(current.lost).toBe(true);
    expect(current.adjustment).toBe(-DEFAULT_RACE_WEIGHTS.lostPenalty);
    expect(strong.lost).toBe(true);
    expect(strong.adjustment).toBe(-24);
    expect(urgent.urgent).toBe(true);
    expect(urgent.adjustment).toBe(4);
    expect(current.incrementalPort).toBe(0);
    expect(RACE_PORT_INCREMENT).toBe(1.6);
    expect(RACE_TUNE_CANDIDATES.map((candidate) => candidate.label)).toEqual(["current", "weak", "strong", "lost_only"]);
    expect(RACE_TUNE_CANDIDATES[0].weights).toEqual(DEFAULT_RACE_WEIGHTS);
    expect(RACE_TUNE_CANDIDATES[1].weights.lostPenalty).toBeLessThan(DEFAULT_RACE_WEIGHTS.lostPenalty);
    expect(RACE_TUNE_CANDIDATES[2].weights.lostPenalty).toBeGreaterThan(DEFAULT_RACE_WEIGHTS.lostPenalty);
    expect(RACE_TUNE_CANDIDATES[3].weights.uncertainPenalty).toBe(0);
    expect(baselineRolloutPolicy.id).toBe("baseline_heuristic_v1");
    expect(baselineDistanceOnlyRolloutPolicy.id).toBe("baseline_distance_only_v1");
    expect(createHeuristicRolloutPolicy("baseline_race_strong_v1", true, RACE_TUNE_CANDIDATES[2].weights).id).toBe("baseline_race_strong_v1");
  });

  it("keeps an incomplete seat out of the paired score and does not treat a cutoff as a win", () => {
    const opening = buildGeneratedOpening("race-tune-repro");
    const first = playBothSeats({
      topology: opening.topology,
      seed: "race-tune-repro",
      focus: baselineRolloutPolicy,
      opponent: baselineDistanceOnlyRolloutPolicy,
      victoryPointsToWin: 10,
      maxTurns: 1,
      maxActions: 6
    });
    const second = playBothSeats({
      topology: opening.topology,
      seed: "race-tune-repro",
      focus: baselineRolloutPolicy,
      opponent: baselineDistanceOnlyRolloutPolicy,
      victoryPointsToWin: 10,
      maxTurns: 1,
      maxActions: 6
    });
    expect(first.map((trial) => trial.focusPlayerId)).toEqual(["c1", "c2"]);
    expect(first.map((trial) => [trial.status, trial.completed, trial.outcome, trial.focusVp, trial.turns])).toEqual(
      second.map((trial) => [trial.status, trial.completed, trial.outcome, trial.focusVp, trial.turns])
    );
    for (const trial of first) {
      expect(trial.completed).toBe(false);
      expect(trial.outcome).toBe("incomplete");
    }
    const mixed = bootstrapMeanDifference([1, null, 0], [0, 1, 0], 200, "paired-seed-test");
    expect(mixed.n).toBe(2);
    expect(mixed.mean).toBe(0.5);
  });

  it("selects a candidate only when the paired interval clears the frozen gates", () => {
    const current = evaluation("current", Array.from({ length: 40 }, () => 0.5), 0.1, 1);
    const weak = evaluation("weak", Array.from({ length: 40 }, () => 0.5), 0.1, 1);
    const strong = evaluation("strong", Array.from({ length: 40 }, () => 1), 0.1, 1);
    const cutoff = evaluation("lost_only", Array.from({ length: 40 }, () => 1), 0.2, 1);
    const regression = evaluation("weak", Array.from({ length: 40 }, () => 1), 0.1, -1);
    expect(selectRaceCandidate([current, weak]).adoptedChange).toBe(false);
    expect(selectRaceCandidate([current, strong]).selectedLabel).toBe("strong");
    expect(selectRaceCandidate([current, cutoff]).selectedLabel).toBe("current");
    expect(selectRaceCandidate([current, regression]).selectedLabel).toBe("current");
  });

  it("rejects a lost race road that the distance-only policy still plays", () => {
    const current = createHeuristicRolloutPolicy("current", true, DEFAULT_RACE_WEIGHTS);
    const strong = createHeuristicRolloutPolicy("strong", true, { lostPenalty: 24, uncertainPenalty: 4, urgentBonus: 4 });
    const lostOnly = createHeuristicRolloutPolicy("lost_only", true, { lostPenalty: 12, uncertainPenalty: 0, urgentBonus: 0 });
    const off = baselineDistanceOnlyRolloutPolicy;
    const context = { stepIndex: 0, bankTradesThisTurn: 0 };
    let distanceSplit = 0;
    let weightSplit = 0;
    for (let index = 0; index < 12; index++) {
      const opening = buildGeneratedOpening(`race-decision-${index}`);
      const created = createInitialConcreteState({
        topology: opening.topology,
        playerIds: ["c1", "c2"],
        rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
      });
      if (!created.ok) throw new Error(created.error.message);
      let state = created.state;
      for (let step = 0; step < 80; step++) {
        if (state.phase === "game_over") break;
        const actorId = state.players[state.turnPlayerIndex].id;
        const legal = getLegalActions(state, actorId);
        if (legal.length > 1 && (state.phase === "setup_road" || state.phase === "main" || state.phase === "road_building_1")) {
          const chosen = {
            current: current.selectAction(state, actorId, legal, createSeededRng(index + 1), context),
            strong: strong.selectAction(state, actorId, legal, createSeededRng(index + 1), context),
            lostOnly: lostOnly.selectAction(state, actorId, legal, createSeededRng(index + 1), context),
            off: off.selectAction(state, actorId, legal, createSeededRng(index + 1), context)
          };
          const key = (action: { type: string }) => JSON.stringify(action);
          if (key(chosen.current) !== key(chosen.off)) distanceSplit += 1;
          if (key(chosen.current) !== key(chosen.strong) || key(chosen.current) !== key(chosen.lostOnly)) weightSplit += 1;
        }
        const nextAction = current.selectAction(state, actorId, legal, createSeededRng(`step-${index}-${step}`), context);
        const applied = applyAction(state, actorId, nextAction);
        if (!applied.ok) break;
        state = applied.state;
      }
    }
    expect(distanceSplit).toBeGreaterThan(0);
    expect(weightSplit).toBe(0);
  });
});
