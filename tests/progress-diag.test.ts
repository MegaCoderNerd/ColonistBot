import { describe, expect, it } from "vitest";
import { DEFAULT_RACE_WEIGHTS } from "../src/analyzer/engine/race";
import { createHeuristicRolloutPolicy } from "../src/analyzer/engine/rollout";
import { createInitialConcreteState } from "../src/analyzer/engine/transition";
import { createSeededRng } from "../src/analyzer/engine/rng";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { baselineRolloutPolicy } from "../src/analyzer/engine/rollout";
import {
  PROGRESS_DIAG_PROTOCOL,
  diagnoseGame,
  diagnosisSeedList,
  holdoutSeedList
} from "../src/analyzer/benchmark/progress-diag";
import { baselineDistanceOnlyRolloutPolicy } from "../src/analyzer/engine/rollout";
import type { SimulatedAction } from "../src/analyzer/engine/transition";

describe("Game-progression diagnostics", () => {
  it("repeats a seed and keeps a one-turn cutoff incomplete", () => {
    const args = {
      seed: "race-tune-dev-0",
      focus: baselineRolloutPolicy,
      opponent: baselineDistanceOnlyRolloutPolicy,
      focusPlayerId: "c1" as const,
      maxTurns: 1,
      maxActions: 8
    };
    const first = diagnoseGame(args);
    const second = diagnoseGame(args);
    expect(first.status).toBe("max_turns_reached");
    expect(first.completed).toBe(false);
    expect(first.winnerId).toBeUndefined();
    expect(first).toEqual(second);
    expect(PROGRESS_DIAG_PROTOCOL.maxTurns).toBe(70);
    expect(PROGRESS_DIAG_PROTOCOL.maxActions).toBe(450);
    expect(diagnosisSeedList().some((seed) => holdoutSeedList().includes(seed))).toBe(false);
    expect(DEFAULT_RACE_WEIGHTS).toEqual({ lostPenalty: 12, uncertainPenalty: 1.5, urgentBonus: 1.5 });
  });

  it("keeps VP and resource totals consistent on a real trajectory", () => {
    const game = diagnoseGame({
      seed: "race-tune-dev-0",
      focus: baselineRolloutPolicy,
      opponent: baselineDistanceOnlyRolloutPolicy,
      focusPlayerId: "c2",
      maxTurns: 12,
      maxActions: 80
    });
    expect(game.replayOk).toBe(true);
    expect(game.resourceConserved).toBe(true);
    expect(game.players.every((player) => player.consistentVp)).toBe(true);
    expect(game.players.every((player) => player.vp === player.settlements + player.cities * 2 + (player.longestRoad ? 2 : 0) + (player.largestArmy ? 2 : 0) + player.vpDevs)).toBe(true);
  });

  it("keeps the current city-trade gate, which ends the turn one ore short", () => {
    const opening = buildGeneratedOpening("city-trade-probe");
    const created = createInitialConcreteState({
      topology: opening.topology,
      playerIds: ["c1", "c2"],
      rules: { victoryPointsToWin: 10, cardDiscardLimit: 9, friendlyRobber: true, diceMode: "balanced" }
    });
    if (!created.ok) throw new Error(created.error.message);
    const state = created.state;
    state.phase = "main";
    state.dice = { thrown: true, d1: 3, d2: 3, total: 6 };
    state.cornerOwner[0] = "c1";
    state.cornerPiece[0] = 1;
    state.players[0].hand = { lumber: 4, brick: 0, wool: 0, grain: 3, ore: 0 };
    const legal: SimulatedAction[] = [
      { type: "bankTrade", give: "lumber", receive: "ore", giveCount: 4, receiveCount: 1 },
      { type: "bankTrade", give: "lumber", receive: "brick", giveCount: 4, receiveCount: 1 },
      { type: "endTurn" }
    ];
    const context = { stepIndex: 4, bankTradesThisTurn: 0 };
    const current = baselineRolloutPolicy.selectAction(state, "c1", legal, createSeededRng(1), context);
    const partial = createHeuristicRolloutPolicy("baseline_partial_city_trade_v1", true, undefined, true)
      .selectAction(state, "c1", legal, createSeededRng(1), context);
    expect(current).toEqual({ type: "endTurn" });
    expect(partial).toEqual({ type: "bankTrade", give: "lumber", receive: "ore", giveCount: 4, receiveCount: 1 });
  });
});
