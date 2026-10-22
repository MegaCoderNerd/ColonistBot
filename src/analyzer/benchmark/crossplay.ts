/**
 * Recording-free cross-play.
 *
 * Two policies play a full game from setup on a generated standard board. Each seat uses
 * only its own policy. The same trial seed rebuilds the same deck and the same initial
 * dice stream. Swapping seats is a separate matchup, not a pooled win rate.
 *
 * Completed games are the only win denominator. Cutoffs stay incomplete.
 */

import type { BoardTopology } from "../engine/topology";
import { STANDARD_DEV_DECK_COUNTS, type ConcreteDevCardKind, type ConcreteSimulatedGameState } from "../engine/state";
import { createInitialConcreteState } from "../engine/transition";
import { createSeededRng, deriveTrialSeed } from "../engine/rng";
import {
  baselineDistanceOnlyRolloutPolicy,
  baselineRolloutPolicy,
  runRollout,
  type RolloutPolicy,
  type RolloutStatus
} from "../engine/rollout";
import {
  aggressiveDevRolloutPolicy,
  longestRoadRolloutPolicy,
  randomLegalRolloutPolicy,
  settlementRacerRolloutPolicy
} from "../engine/policies";
import { computeWilson95Interval, type WilsonConfidenceInterval } from "../engine/shadow";

const PLAYERS = ["c1", "c2"] as const;
const STANDARD_DECK: ConcreteDevCardKind[] = (Object.entries(STANDARD_DEV_DECK_COUNTS) as Array<[ConcreteDevCardKind, number]>).flatMap(
  ([kind, count]) => Array.from({ length: count }, () => kind)
);

export interface CrossPlayPolicies {
  readonly baseline: RolloutPolicy;
  readonly distanceOnly: RolloutPolicy;
  readonly racer: RolloutPolicy;
  readonly dev: RolloutPolicy;
  readonly road: RolloutPolicy;
  readonly random: RolloutPolicy;
}

export function crossPlayRoster(): CrossPlayPolicies {
  return {
    baseline: baselineRolloutPolicy,
    distanceOnly: baselineDistanceOnlyRolloutPolicy,
    racer: settlementRacerRolloutPolicy,
    dev: aggressiveDevRolloutPolicy,
    road: longestRoadRolloutPolicy,
    random: randomLegalRolloutPolicy
  };
}

const MATCHUPS: ReadonlyArray<readonly ["baseline" | "distanceOnly" | "racer" | "dev" | "road" | "random", "baseline" | "distanceOnly" | "racer" | "dev" | "road" | "random"]> = [
  ["baseline", "distanceOnly"],
  ["baseline", "racer"],
  ["baseline", "dev"],
  ["baseline", "road"],
  ["baseline", "random"],
  ["racer", "dev"]
];

export interface CrossPlayOptions {
  readonly topology: BoardTopology;
  readonly seed: number | string;
  readonly trials: number;
  readonly victoryPointsToWin?: number;
  readonly maxTurns?: number;
  readonly maxActions?: number;
  /** Defaults to the full roster. Tests can pass a smaller set. */
  readonly pairs?: ReadonlyArray<readonly [keyof CrossPlayPolicies, keyof CrossPlayPolicies]>;
}

export interface CrossPlayTrial {
  readonly matchupId: string;
  readonly focusPolicyId: string;
  readonly opponentPolicyId: string;
  readonly focusPlayerId: string;
  readonly trialIndex: number;
  readonly seed: number;
  readonly status: RolloutStatus | "invalid_state";
  readonly completed: boolean;
  readonly outcome: "win" | "loss" | "draw" | "incomplete";
  readonly winnerId?: string;
  readonly focusVp: number;
  readonly opponentVp: number;
  readonly vpMargin: number;
  readonly turns: number;
  readonly actions: number;
  readonly elapsedMs: number;
  readonly focusSettlements: number;
  readonly focusCities: number;
  readonly opponentSettlements: number;
  readonly focusRoads: number;
  readonly focusDeadEndRoads: number;
  readonly focusRoadsBlockedByOpponent: number;
  readonly focusMainSettlements: number;
  readonly focusFirstCityTurn: number | null;
  readonly focusDiscards: number;
  readonly focusLongestRoad: boolean;
  readonly focusLargestArmy: boolean;
}

export interface CrossPlayMatchupSummary {
  readonly matchupId: string;
  readonly focusPolicyId: string;
  readonly opponentPolicyId: string;
  readonly focusPlayerId: string;
  readonly trials: number;
  readonly completed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly cutoffs: number;
  readonly failures: number;
  readonly winRateAmongCompleted: number | null;
  readonly wilson95: WilsonConfidenceInterval | null;
  readonly meanVpMarginAmongCompleted: number | null;
  readonly meanTurnsAmongCompleted: number | null;
  readonly meanFocusVpAmongCompleted: number | null;
  readonly meanDeadEndRoads: number | null;
  readonly meanBlockedRoads: number | null;
  readonly meanMainSettlements: number | null;
  readonly meanFirstCityTurn: number | null;
  readonly meanDiscards: number | null;
  readonly longestRoadGames: number;
  readonly largestArmyGames: number;
  readonly elapsedMs: number;
  readonly establishes: string;
}

export interface CrossPlayReport {
  readonly seed: string;
  readonly victoryPointsToWin: number;
  readonly trialsPerSeat: number;
  readonly highNumbersTouch: boolean;
  readonly matchups: readonly CrossPlayMatchupSummary[];
  readonly trials: readonly CrossPlayTrial[];
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boardCounts(state: ConcreteSimulatedGameState, playerId: string) {
  let settlements = 0;
  let cities = 0;
  for (let i = 0; i < state.cornerOwner.length; i++) {
    if (state.cornerOwner[i] !== playerId) continue;
    if (state.cornerPiece[i] === 1) settlements += 1;
    else if (state.cornerPiece[i] === 2) cities += 1;
  }
  const roads: number[] = [];
  for (let i = 0; i < state.edgeOwner.length; i++) {
    if (state.edgeOwner[i] === playerId) roads.push(i);
  }
  const degree = new Map<number, number>();
  for (const edgeIndex of roads) {
    const edge = state.topology.edges[edgeIndex];
    degree.set(edge.c1, (degree.get(edge.c1) ?? 0) + 1);
    degree.set(edge.c2, (degree.get(edge.c2) ?? 0) + 1);
  }
  let deadEnds = 0;
  let blocked = 0;
  for (const edgeIndex of roads) {
    const edge = state.topology.edges[edgeIndex];
    let touchesOpponent = false;
    for (const cornerIndex of [edge.c1, edge.c2]) {
      const owner = state.cornerOwner[cornerIndex];
      if (owner && owner !== playerId && state.cornerPiece[cornerIndex] > 0) touchesOpponent = true;
      const leaf = (degree.get(cornerIndex) ?? 0) === 1 && state.cornerOwner[cornerIndex] !== playerId;
      if (!leaf) continue;
      const corner = state.topology.corners[cornerIndex];
      const besideBuilding = corner?.adjacentCornerIndices.some((next) => state.cornerPiece[next] > 0) ?? false;
      if (besideBuilding || state.cornerPiece[cornerIndex] > 0) deadEnds += 1;
    }
    if (touchesOpponent) blocked += 1;
  }
  return { settlements, cities, roads: roads.length, deadEnds, blocked };
}

function initialState(topology: BoardTopology, trialSeed: number, victoryPointsToWin: number) {
  const deck = createSeededRng(deriveTrialSeed(trialSeed, 0, "deck")).shuffle(STANDARD_DECK);
  return createInitialConcreteState({
    topology,
    playerIds: [...PLAYERS],
    devDeckOrder: deck,
    rules: {
      victoryPointsToWin,
      cardDiscardLimit: 9,
      friendlyRobber: true,
      diceMode: "balanced"
    }
  });
}

function playSeat(
  topology: BoardTopology,
  focus: RolloutPolicy,
  opponent: RolloutPolicy,
  focusPlayerId: (typeof PLAYERS)[number],
  trialIndex: number,
  trialSeed: number,
  victoryPointsToWin: number,
  maxTurns: number,
  maxActions: number
): CrossPlayTrial {
  const created = initialState(topology, trialSeed, victoryPointsToWin);
  if (!created.ok) {
    return {
      matchupId: `${focus.id}@${focusPlayerId}-vs-${opponent.id}`,
      focusPolicyId: focus.id,
      opponentPolicyId: opponent.id,
      focusPlayerId,
      trialIndex,
      seed: trialSeed,
      status: "invalid_state",
      completed: false,
      outcome: "incomplete",
      focusVp: 0,
      opponentVp: 0,
      vpMargin: 0,
      turns: 0,
      actions: 0,
      elapsedMs: 0,
      focusSettlements: 0,
      focusCities: 0,
      opponentSettlements: 0,
      focusRoads: 0,
      focusDeadEndRoads: 0,
      focusRoadsBlockedByOpponent: 0,
      focusMainSettlements: 0,
      focusFirstCityTurn: null,
      focusDiscards: 0,
      focusLongestRoad: false,
      focusLargestArmy: false
    };
  }
  const opponentId = focusPlayerId === "c1" ? "c2" : "c1";
  const started = Date.now();
  const rollout = runRollout(created.state, createSeededRng(deriveTrialSeed(trialSeed, 0, "play")), {
    policy: focus,
    policiesByPlayerId: {
      [focusPlayerId]: focus,
      [opponentId]: opponent
    },
    maxTurns,
    maxActions,
    validateEveryStep: false,
    recordTrace: true,
    separateDomainStreams: true
  });
  const elapsedMs = Date.now() - started;
  const focusPlayer = rollout.finalState.players.find((player) => player.id === focusPlayerId);
  const opponentPlayer = rollout.finalState.players.find((player) => player.id === opponentId);
  const counts = boardCounts(rollout.finalState, focusPlayerId);
  const opponentCounts = boardCounts(rollout.finalState, opponentId);
  let mainSettlements = 0;
  let discards = 0;
  let firstCityTurn: number | null = null;
  for (const step of rollout.trace ?? []) {
    if (step.actorId !== focusPlayerId) continue;
    if (step.action.type === "buildSettlement") mainSettlements += 1;
    if (step.action.type === "discard") discards += 1;
    if (step.action.type === "buildCity" && firstCityTurn === null) firstCityTurn = step.completedTurns;
  }
  const focusVp = focusPlayer?.actualSimulatedVp ?? 0;
  const opponentVp = opponentPlayer?.actualSimulatedVp ?? 0;
  const completed = rollout.completed;
  let outcome: CrossPlayTrial["outcome"] = "incomplete";
  if (completed) {
    if (rollout.winnerId === undefined) outcome = "draw";
    else if (rollout.winnerId === focusPlayerId) outcome = "win";
    else outcome = "loss";
  }
  return {
    matchupId: `${focus.id}@${focusPlayerId}-vs-${opponent.id}`,
    focusPolicyId: focus.id,
    opponentPolicyId: opponent.id,
    focusPlayerId,
    trialIndex,
    seed: trialSeed,
    status: rollout.status,
    completed,
    outcome,
    ...(rollout.winnerId !== undefined ? { winnerId: rollout.winnerId } : {}),
    focusVp,
    opponentVp,
    vpMargin: focusVp - opponentVp,
    turns: rollout.turnsSimulated,
    actions: rollout.actionsSimulated,
    elapsedMs,
    focusSettlements: counts.settlements,
    focusCities: counts.cities,
    opponentSettlements: opponentCounts.settlements,
    focusRoads: counts.roads,
    focusDeadEndRoads: counts.deadEnds,
    focusRoadsBlockedByOpponent: counts.blocked,
    focusMainSettlements: mainSettlements,
    focusFirstCityTurn: firstCityTurn,
    focusDiscards: discards,
    focusLongestRoad: focusPlayer?.hasLongestRoad === true,
    focusLargestArmy: focusPlayer?.hasLargestArmy === true
  };
}

function summarize(trials: readonly CrossPlayTrial[]): CrossPlayMatchupSummary {
  const first = trials[0];
  const completed = trials.filter((trial) => trial.completed);
  const wins = completed.filter((trial) => trial.outcome === "win").length;
  const losses = completed.filter((trial) => trial.outcome === "loss").length;
  const draws = completed.filter((trial) => trial.outcome === "draw").length;
  const cutoffs = trials.filter((trial) => trial.status === "max_turns_reached" || trial.status === "max_actions_reached").length;
  const failures = trials.filter((trial) => !trial.completed && trial.status !== "max_turns_reached" && trial.status !== "max_actions_reached").length;
  const wilson = computeWilson95Interval(wins, completed.length);
  const cityTurns = completed.map((trial) => trial.focusFirstCityTurn).filter((turn): turn is number => turn !== null);
  let establishes = "Inconclusive. The completed-game count is too small to separate these policies.";
  if (completed.length >= 20 && wilson && (wilson.upper < 0.5 || wilson.lower > 0.5)) {
    establishes = "On this sample the Wilson interval for completed games excludes an even split. This is not a significance test against a skilled human, and it is not professional strength.";
  } else if (completed.length > 0) {
    establishes = "Inconclusive. The Wilson interval describes uncertainty in this sample only. It is not a claim of statistical significance or professional strength.";
  }
  return {
    matchupId: first.matchupId,
    focusPolicyId: first.focusPolicyId,
    opponentPolicyId: first.opponentPolicyId,
    focusPlayerId: first.focusPlayerId,
    trials: trials.length,
    completed: completed.length,
    wins,
    losses,
    draws,
    cutoffs,
    failures,
    winRateAmongCompleted: completed.length > 0 ? wins / completed.length : null,
    wilson95: wilson,
    meanVpMarginAmongCompleted: mean(completed.map((trial) => trial.vpMargin)),
    meanTurnsAmongCompleted: mean(completed.map((trial) => trial.turns)),
    meanFocusVpAmongCompleted: mean(completed.map((trial) => trial.focusVp)),
    meanDeadEndRoads: mean(trials.map((trial) => trial.focusDeadEndRoads)),
    meanBlockedRoads: mean(trials.map((trial) => trial.focusRoadsBlockedByOpponent)),
    meanMainSettlements: mean(trials.map((trial) => trial.focusMainSettlements)),
    meanFirstCityTurn: mean(cityTurns),
    meanDiscards: mean(trials.map((trial) => trial.focusDiscards)),
    longestRoadGames: trials.filter((trial) => trial.focusLongestRoad).length,
    largestArmyGames: trials.filter((trial) => trial.focusLargestArmy).length,
    elapsedMs: trials.reduce((sum, trial) => sum + trial.elapsedMs, 0),
    establishes
  };
}

/** One seeded board's two seat assignments. The caller supplies the topology for that seed. */
export function playBothSeats(args: {
  readonly topology: BoardTopology;
  readonly seed: string;
  readonly focus: RolloutPolicy;
  readonly opponent: RolloutPolicy;
  readonly victoryPointsToWin: number;
  readonly maxTurns: number;
  readonly maxActions: number;
}): readonly [CrossPlayTrial, CrossPlayTrial] {
  const trialSeed = deriveTrialSeed(args.seed, 0, "crossplay");
  return [
    playSeat(args.topology, args.focus, args.opponent, "c1", 0, trialSeed, args.victoryPointsToWin, args.maxTurns, args.maxActions),
    playSeat(args.topology, args.focus, args.opponent, "c2", 0, trialSeed, args.victoryPointsToWin, args.maxTurns, args.maxActions)
  ];
}

/** Plays every roster matchup from both seats. */
export function runCrossPlay(options: CrossPlayOptions & { readonly highNumbersTouch?: boolean }): CrossPlayReport {
  const roster = crossPlayRoster();
  const pairs = options.pairs ?? MATCHUPS;
  const victoryPointsToWin = options.victoryPointsToWin ?? 10;
  const maxTurns = options.maxTurns ?? 70;
  const maxActions = options.maxActions ?? 450;
  const trials: CrossPlayTrial[] = [];
  for (let trialIndex = 0; trialIndex < options.trials; trialIndex++) {
    const trialSeed = deriveTrialSeed(options.seed, trialIndex, "crossplay");
    for (const [focusKey, opponentKey] of pairs) {
      const focus = roster[focusKey];
      const opponent = roster[opponentKey];
      for (const focusPlayerId of PLAYERS) {
        trials.push(
          playSeat(
            options.topology,
            focus,
            opponent,
            focusPlayerId,
            trialIndex,
            trialSeed,
            victoryPointsToWin,
            maxTurns,
            maxActions
          )
        );
      }
    }
  }
  const groups = new Map<string, CrossPlayTrial[]>();
  for (const trial of trials) {
    const list = groups.get(trial.matchupId);
    if (list) list.push(trial);
    else groups.set(trial.matchupId, [trial]);
  }
  return {
    seed: String(options.seed),
    victoryPointsToWin,
    trialsPerSeat: options.trials,
    highNumbersTouch: options.highNumbersTouch === true,
    matchups: [...groups.values()].map(summarize),
    trials
  };
}
