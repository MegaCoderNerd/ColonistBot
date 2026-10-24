/**
 * Frozen offline comparison of `production_aware_dev_card_v1` against
 * `baseline_heuristic_v1`.
 *
 * Development seeds may be inspected. They are not used to change the rule or
 * to decide adoption. Holdout seeds are disjoint from those development seeds
 * and from `progress-holdout-0` through `progress-holdout-19`.
 *
 * A pair is one seed played from both seats. The pair score is the mean of the
 * two seat scores (win 1, draw 0.5, loss 0) from the candidate's point of view.
 * If either seat does not complete, the pair score is null and that seed is
 * excluded from the interval. A cutoff is not a win, loss, or draw.
 *
 * Acceptance was fixed before the holdout was measured:
 * adopt only when the holdout bootstrap 95% interval of (pair score - 0.5)
 * lies entirely above 0, the matchup cutoff rate is at most 0.45, completed-game
 * VP margin is at least -1, completed-game cities are not more than 0.25 behind
 * the baseline opponent, and the candidate still buys more than 0.25 dev cards
 * per game. Otherwise retain `baseline_heuristic_v1`.
 */

import { STANDARD_DEV_DECK_COUNTS, type ConcreteDevCardKind, type ConcreteSimulatedGameState } from "../engine/state";
import { createInitialConcreteState } from "../engine/transition";
import { createSeededRng, deriveTrialSeed } from "../engine/rng";
import {
  baselineRolloutPolicy,
  devCardLeavesCityReserve,
  devCardResourceCost,
  productionAwareDevCardRolloutPolicy,
  runRollout,
  type RolloutPolicy,
  type RolloutStatus
} from "../engine/rollout";
import { buildGeneratedOpening } from "./generated-board";
import { bootstrapMean } from "./race-tune";
import { holdoutSeedList as progressHoldoutSeedList } from "./progress-diag";

const PLAYERS = ["c1", "c2"] as const;
const STANDARD_DECK: ConcreteDevCardKind[] = (Object.entries(STANDARD_DEV_DECK_COUNTS) as Array<[ConcreteDevCardKind, number]>).flatMap(
  ([kind, count]) => Array.from({ length: count }, () => kind)
);

export const DEVCARD_RULE_PROTOCOL = {
  candidateId: "production_aware_dev_card_v1",
  controlId: "baseline_heuristic_v1",
  developmentSeeds: 8,
  developmentPrefix: "race-tune-dev",
  holdoutSeeds: 100,
  holdoutPrefix: "devcard-rule-holdout",
  victoryPointsToWin: 10,
  maxTurns: 70,
  maxActions: 450,
  cutoffRateCeiling: 0.45,
  vpMarginFloor: -1,
  cityRegressionFloor: -0.25,
  minMeanDevs: 0.25,
  bootstrapDraws: 2000,
  bootstrapSeed: "devcard-rule-bootstrap-v1"
} as const;

export function developmentSeedList(): string[] {
  return Array.from({ length: DEVCARD_RULE_PROTOCOL.developmentSeeds }, (_, index) => `${DEVCARD_RULE_PROTOCOL.developmentPrefix}-${index}`);
}

export function devCardHoldoutSeedList(): string[] {
  return Array.from({ length: DEVCARD_RULE_PROTOCOL.holdoutSeeds }, (_, index) => `${DEVCARD_RULE_PROTOCOL.holdoutPrefix}-${index}`);
}

export function devCardSeedSetsAreDisjoint(): boolean {
  const development = new Set(developmentSeedList());
  const holdout = devCardHoldoutSeedList();
  const progress = new Set(progressHoldoutSeedList());
  return holdout.every((seed) => !development.has(seed) && !progress.has(seed));
}

interface BuyRecord {
  readonly policyId: string;
  readonly actorId: string;
  readonly preservesCity: boolean;
}

interface SeatResult {
  readonly seed: string;
  readonly focusPlayerId: (typeof PLAYERS)[number];
  readonly status: RolloutStatus | "invalid_state";
  readonly completed: boolean;
  readonly outcome: "win" | "loss" | "draw" | "incomplete";
  readonly focusVp: number;
  readonly opponentVp: number;
  readonly vpMargin: number;
  readonly turns: number;
  readonly actions: number;
  readonly elapsedMs: number;
  readonly focusCities: number;
  readonly opponentCities: number;
  readonly focusDevs: number;
  readonly opponentDevs: number;
  readonly focusDevsSpendingReserve: number;
  readonly opponentDevsSpendingReserve: number;
  readonly focusLargestArmy: boolean;
  readonly opponentLargestArmy: boolean;
  readonly focusFinalOre: number;
  readonly focusFinalGrain: number;
  readonly focusOreSpentOnDevs: number;
  readonly focusGrainSpentOnDevs: number;
}

export interface DevCardComparison {
  readonly label: string;
  readonly seeds: readonly string[];
  readonly games: number;
  readonly completedGames: number;
  readonly completedPairs: number;
  readonly incompletePairs: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly cutoffs: number;
  readonly cutoffRate: number;
  readonly maxTurnsCutoffs: number;
  readonly maxActionsCutoffs: number;
  readonly failures: number;
  readonly meanTurns: number | null;
  readonly meanFocusVp: number | null;
  readonly meanVpMargin: number | null;
  readonly meanFocusCitiesCompleted: number | null;
  readonly meanOpponentCitiesCompleted: number | null;
  readonly meanFocusCities: number | null;
  readonly meanFocusDevs: number | null;
  readonly meanOpponentDevs: number | null;
  readonly meanFocusDevsSpendingReserve: number | null;
  readonly meanOpponentDevsSpendingReserve: number | null;
  readonly focusLargestArmy: number;
  readonly opponentLargestArmy: number;
  readonly meanFocusFinalOre: number | null;
  readonly meanFocusFinalGrain: number | null;
  readonly meanFocusOreSpentOnDevs: number | null;
  readonly meanFocusGrainSpentOnDevs: number | null;
  readonly meanPairScore: number | null;
  readonly pairInterval: { n: number; mean: number | null; low: number | null; high: number | null };
  readonly elapsedMs: number;
}

export type DevCardDecisionName = "adopt" | "retain" | "inconclusive";

export interface DevCardDecision {
  readonly decision: DevCardDecisionName;
  readonly reason: string;
}

function watchBuys(policy: RolloutPolicy, log: BuyRecord[]): RolloutPolicy {
  return {
    id: policy.id,
    selectAction(state, actorId, legalActions, rng, context) {
      const action = policy.selectAction(state, actorId, legalActions, rng, context);
      if (action.type === "buyDevCard") {
        const actor = state.players.find((player) => player.id === actorId);
        log.push({
          policyId: policy.id,
          actorId,
          preservesCity: actor ? devCardLeavesCityReserve(actor.hand) : false
        });
      }
      return action;
    }
  };
}

function countPieces(state: ConcreteSimulatedGameState, playerId: string): number {
  let cities = 0;
  for (let index = 0; index < state.cornerOwner.length; index++) {
    if (state.cornerOwner[index] === playerId && state.cornerPiece[index] === 2) cities += 1;
  }
  return cities;
}

function playSeat(
  seed: string,
  focusPlayerId: (typeof PLAYERS)[number]
): SeatResult {
  const opening = buildGeneratedOpening(seed);
  const trialSeed = deriveTrialSeed(seed, 0, "crossplay");
  const deck = createSeededRng(deriveTrialSeed(trialSeed, 0, "deck")).shuffle([...STANDARD_DECK]);
  const created = createInitialConcreteState({
    topology: opening.topology,
    playerIds: [...PLAYERS],
    devDeckOrder: deck,
    rules: {
      victoryPointsToWin: DEVCARD_RULE_PROTOCOL.victoryPointsToWin,
      cardDiscardLimit: 9,
      friendlyRobber: true,
      diceMode: "balanced"
    }
  });
  const empty = (): SeatResult => ({
    seed,
    focusPlayerId,
    status: "invalid_state",
    completed: false,
    outcome: "incomplete",
    focusVp: 0,
    opponentVp: 0,
    vpMargin: 0,
    turns: 0,
    actions: 0,
    elapsedMs: 0,
    focusCities: 0,
    opponentCities: 0,
    focusDevs: 0,
    opponentDevs: 0,
    focusDevsSpendingReserve: 0,
    opponentDevsSpendingReserve: 0,
    focusLargestArmy: false,
    opponentLargestArmy: false,
    focusFinalOre: 0,
    focusFinalGrain: 0,
    focusOreSpentOnDevs: 0,
    focusGrainSpentOnDevs: 0
  });
  if (!created.ok) return empty();
  const opponentId = focusPlayerId === "c1" ? "c2" : "c1";
  const buys: BuyRecord[] = [];
  const focus = watchBuys(productionAwareDevCardRolloutPolicy, buys);
  const opponent = watchBuys(baselineRolloutPolicy, buys);
  const started = Date.now();
  const rollout = runRollout(created.state, createSeededRng(deriveTrialSeed(trialSeed, 0, "play")), {
    policy: focus,
    policiesByPlayerId: { [focusPlayerId]: focus, [opponentId]: opponent },
    maxTurns: DEVCARD_RULE_PROTOCOL.maxTurns,
    maxActions: DEVCARD_RULE_PROTOCOL.maxActions,
    validateEveryStep: false,
    recordTrace: false,
    separateDomainStreams: true
  });
  const elapsedMs = Date.now() - started;
  const focusPlayer = rollout.finalState.players.find((player) => player.id === focusPlayerId);
  const opponentPlayer = rollout.finalState.players.find((player) => player.id === opponentId);
  const focusBuys = buys.filter((buy) => buy.actorId === focusPlayerId);
  const opponentBuys = buys.filter((buy) => buy.actorId === opponentId);
  const focusVp = focusPlayer?.actualSimulatedVp ?? 0;
  const opponentVp = opponentPlayer?.actualSimulatedVp ?? 0;
  let outcome: SeatResult["outcome"] = "incomplete";
  if (rollout.completed) {
    if (rollout.winnerId === undefined) outcome = "draw";
    else if (rollout.winnerId === focusPlayerId) outcome = "win";
    else outcome = "loss";
  }
  const devCost = devCardResourceCost();
  return {
    seed,
    focusPlayerId,
    status: rollout.status,
    completed: rollout.completed,
    outcome,
    focusVp,
    opponentVp,
    vpMargin: focusVp - opponentVp,
    turns: rollout.turnsSimulated,
    actions: rollout.actionsSimulated,
    elapsedMs,
    focusCities: countPieces(rollout.finalState, focusPlayerId),
    opponentCities: countPieces(rollout.finalState, opponentId),
    focusDevs: focusBuys.length,
    opponentDevs: opponentBuys.length,
    focusDevsSpendingReserve: focusBuys.filter((buy) => !buy.preservesCity).length,
    opponentDevsSpendingReserve: opponentBuys.filter((buy) => !buy.preservesCity).length,
    focusLargestArmy: focusPlayer?.hasLargestArmy === true,
    opponentLargestArmy: opponentPlayer?.hasLargestArmy === true,
    focusFinalOre: focusPlayer?.hand.ore ?? 0,
    focusFinalGrain: focusPlayer?.hand.grain ?? 0,
    focusOreSpentOnDevs: focusBuys.length * devCost.ore,
    focusGrainSpentOnDevs: focusBuys.length * devCost.grain
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function compareDevCardRule(seeds: readonly string[], label: string): DevCardComparison {
  const seats: SeatResult[] = [];
  const pairScores: Array<number | null> = [];
  for (const seed of seeds) {
    const c1 = playSeat(seed, "c1");
    const c2 = playSeat(seed, "c2");
    seats.push(c1, c2);
    const score = (seat: SeatResult) => (seat.completed ? (seat.outcome === "win" ? 1 : seat.outcome === "draw" ? 0.5 : 0) : null);
    const left = score(c1);
    const right = score(c2);
    pairScores.push(left === null || right === null ? null : (left + right) / 2);
  }
  const completed = seats.filter((seat) => seat.completed);
  const completedPairs = pairScores.filter((score) => score !== null);
  const cutoffs = seats.filter((seat) => seat.status === "max_turns_reached" || seat.status === "max_actions_reached");
  return {
    label,
    seeds,
    games: seats.length,
    completedGames: completed.length,
    completedPairs: completedPairs.length,
    incompletePairs: pairScores.length - completedPairs.length,
    wins: completed.filter((seat) => seat.outcome === "win").length,
    losses: completed.filter((seat) => seat.outcome === "loss").length,
    draws: completed.filter((seat) => seat.outcome === "draw").length,
    cutoffs: cutoffs.length,
    cutoffRate: seats.length === 0 ? 0 : cutoffs.length / seats.length,
    maxTurnsCutoffs: seats.filter((seat) => seat.status === "max_turns_reached").length,
    maxActionsCutoffs: seats.filter((seat) => seat.status === "max_actions_reached").length,
    failures: seats.filter((seat) => !seat.completed && seat.status !== "max_turns_reached" && seat.status !== "max_actions_reached").length,
    meanTurns: mean(completed.map((seat) => seat.turns)),
    meanFocusVp: mean(completed.map((seat) => seat.focusVp)),
    meanVpMargin: mean(completed.map((seat) => seat.vpMargin)),
    meanFocusCitiesCompleted: mean(completed.map((seat) => seat.focusCities)),
    meanOpponentCitiesCompleted: mean(completed.map((seat) => seat.opponentCities)),
    meanFocusCities: mean(seats.map((seat) => seat.focusCities)),
    meanFocusDevs: mean(seats.map((seat) => seat.focusDevs)),
    meanOpponentDevs: mean(seats.map((seat) => seat.opponentDevs)),
    meanFocusDevsSpendingReserve: mean(seats.map((seat) => seat.focusDevsSpendingReserve)),
    meanOpponentDevsSpendingReserve: mean(seats.map((seat) => seat.opponentDevsSpendingReserve)),
    focusLargestArmy: seats.filter((seat) => seat.focusLargestArmy).length,
    opponentLargestArmy: seats.filter((seat) => seat.opponentLargestArmy).length,
    meanFocusFinalOre: mean(seats.map((seat) => seat.focusFinalOre)),
    meanFocusFinalGrain: mean(seats.map((seat) => seat.focusFinalGrain)),
    meanFocusOreSpentOnDevs: mean(seats.map((seat) => seat.focusOreSpentOnDevs)),
    meanFocusGrainSpentOnDevs: mean(seats.map((seat) => seat.focusGrainSpentOnDevs)),
    meanPairScore: mean(completedPairs),
    pairInterval: bootstrapMean(
      pairScores.map((score) => (score === null ? null : score - 0.5)),
      DEVCARD_RULE_PROTOCOL.bootstrapDraws,
      DEVCARD_RULE_PROTOCOL.bootstrapSeed
    ),
    elapsedMs: seats.reduce((sum, seat) => sum + seat.elapsedMs, 0)
  };
}

/**
 * Applies the predeclared holdout rule. Development results are not an input.
 */
export function decideDevCardRule(holdout: DevCardComparison): DevCardDecision {
  const interval = holdout.pairInterval;
  const improved = interval.low !== null && interval.low > 0;
  const worse = interval.high !== null && interval.high < 0;
  const cutoffOk = holdout.cutoffRate <= DEVCARD_RULE_PROTOCOL.cutoffRateCeiling;
  const margin = holdout.meanVpMargin;
  const marginOk = margin !== null && margin >= DEVCARD_RULE_PROTOCOL.vpMarginFloor;
  const focusCities = holdout.meanFocusCitiesCompleted;
  const opponentCities = holdout.meanOpponentCitiesCompleted;
  const cityGap = focusCities === null || opponentCities === null ? null : focusCities - opponentCities;
  const cityOk = cityGap !== null && cityGap >= DEVCARD_RULE_PROTOCOL.cityRegressionFloor;
  const devsOk = holdout.meanFocusDevs !== null && holdout.meanFocusDevs > DEVCARD_RULE_PROTOCOL.minMeanDevs;
  if (improved && cutoffOk && marginOk && cityOk && devsOk) {
    return {
      decision: "adopt",
      reason: "Holdout pair-score interval lies above an even result, and cutoff, VP margin, cities, and dev-card volume stay inside the predeclared bounds."
    };
  }
  if (worse || !cutoffOk || !marginOk || !cityOk || !devsOk) {
    return {
      decision: "retain",
      reason: "Holdout evidence is worse than the baseline or misses a predeclared bound, so baseline_heuristic_v1 stays the default."
    };
  }
  return {
    decision: "inconclusive",
    reason: "The holdout interval does not lie entirely above an even result. Incomplete pairs stay unknown. baseline_heuristic_v1 stays the default."
  };
}

function num(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function formatDevCardComparison(comparison: DevCardComparison): string {
  const interval = comparison.pairInterval;
  const intervalText =
    interval.mean === null || interval.low === null || interval.high === null
      ? "no completed pairs"
      : `n=${interval.n}, mean ${interval.mean.toFixed(3)}, 95% [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
  return [
    `${comparison.label}`,
    `seeds ${comparison.seeds.length}, games ${comparison.games}, completed games ${comparison.completedGames}, completed pairs ${comparison.completedPairs}, incomplete pairs ${comparison.incompletePairs}`,
    `W${comparison.wins} L${comparison.losses} D${comparison.draws} among completed games. Cutoffs are not wins, losses, or draws.`,
    `cutoffs ${comparison.cutoffs} (${(comparison.cutoffRate * 100).toFixed(1)}%): max_turns ${comparison.maxTurnsCutoffs}, max_actions ${comparison.maxActionsCutoffs}, failures ${comparison.failures}`,
    `completed turns ${num(comparison.meanTurns, 1)}, focus VP ${num(comparison.meanFocusVp)}, VP margin ${num(comparison.meanVpMargin)}`,
    `cities completed focus ${num(comparison.meanFocusCitiesCompleted)} opponent ${num(comparison.meanOpponentCitiesCompleted)}, cities all games focus ${num(comparison.meanFocusCities)}`,
    `devs/game focus ${num(comparison.meanFocusDevs)} opponent ${num(comparison.meanOpponentDevs)}, reserve-spending devs/game focus ${num(comparison.meanFocusDevsSpendingReserve)} opponent ${num(comparison.meanOpponentDevsSpendingReserve)}`,
    `largest army games focus ${comparison.focusLargestArmy}, opponent ${comparison.opponentLargestArmy}`,
    `focus final hand ore ${num(comparison.meanFocusFinalOre)} grain ${num(comparison.meanFocusFinalGrain)}, ore spent on devs ${num(comparison.meanFocusOreSpentOnDevs)}, grain spent on devs ${num(comparison.meanFocusGrainSpentOnDevs)}`,
    `pair score ${num(comparison.meanPairScore, 3)}. Pair score minus even: ${intervalText}`,
    `runtime ${comparison.elapsedMs} ms`,
    "Incomplete pairs are excluded from the interval. Their outcomes are unknown."
  ].join("\n");
}
