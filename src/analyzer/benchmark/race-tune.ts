/**
 * Frozen race-weight experiment.
 *
 * Development seeds choose a candidate. Confirmation seeds are disjoint and are not
 * used to add candidates or change the selection rule. The live coach keeps
 * `DEFAULT_RACE_WEIGHTS` either way.
 *
 * `--trials N` on the policy benchmark is N seed indexes on one shared board, and each
 * index plays both seats. A seed instance here is one generated board. A game is one
 * seat. A paired seed instance is both seats of that board. A pair counts as completed
 * only when both games complete.
 */

import { DEFAULT_RACE_WEIGHTS, type RaceWeights } from "../engine/race";
import {
  baselineDistanceOnlyRolloutPolicy,
  createHeuristicRolloutPolicy,
  type RolloutPolicy
} from "../engine/rollout";
import { aggressiveDevRolloutPolicy, settlementRacerRolloutPolicy } from "../engine/policies";
import { createSeededRng } from "../engine/rng";
import { buildGeneratedOpening } from "./generated-board";
import { playBothSeats, type CrossPlayTrial } from "./crossplay";

export const RACE_TUNE_PROTOCOL = {
  developmentSeeds: 100,
  confirmationSeeds: 200,
  developmentPrefix: "race-tune-dev",
  confirmationPrefix: "race-tune-confirm",
  diagnosticPrefix: "race-racer-diag",
  diagnosticSeeds: 4,
  victoryPointsToWin: 10,
  maxTurns: 70,
  maxActions: 450,
  cutoffSlack: 0.05,
  maxVpMarginRegression: 1,
  bootstrapDraws: 2000,
  bootstrapSeed: "race-tune-bootstrap-v1",
  opponent: "baseline_distance_only_v1"
} as const;

export const RACE_TUNE_CANDIDATES: readonly { readonly id: string; readonly label: string; readonly weights: RaceWeights }[] = [
  { id: "baseline_heuristic_v1", label: "current", weights: DEFAULT_RACE_WEIGHTS },
  { id: "baseline_race_weak_v1", label: "weak", weights: { lostPenalty: 4, uncertainPenalty: 0.5, urgentBonus: 0.5 } },
  { id: "baseline_race_strong_v1", label: "strong", weights: { lostPenalty: 24, uncertainPenalty: 4, urgentBonus: 4 } },
  { id: "baseline_race_lost_only_v1", label: "lost_only", weights: { lostPenalty: 12, uncertainPenalty: 0, urgentBonus: 0 } }
];

export function developmentSeedList(count = RACE_TUNE_PROTOCOL.developmentSeeds): string[] {
  return Array.from({ length: count }, (_, index) => `${RACE_TUNE_PROTOCOL.developmentPrefix}-${index}`);
}

export function confirmationSeedList(count = RACE_TUNE_PROTOCOL.confirmationSeeds): string[] {
  return Array.from({ length: count }, (_, index) => `${RACE_TUNE_PROTOCOL.confirmationPrefix}-${index}`);
}

export function seedSetsAreDisjoint(development: readonly string[], confirmation: readonly string[]): boolean {
  const seen = new Set(development);
  return confirmation.every((seed) => !seen.has(seed));
}

export interface SeedPair {
  readonly seed: string;
  readonly c1: CrossPlayTrial;
  readonly c2: CrossPlayTrial;
  readonly bothCompleted: boolean;
  /** Mean of the two seat scores. Null unless both games completed. */
  readonly score: number | null;
}

export interface CandidateEvaluation {
  readonly id: string;
  readonly label: string;
  readonly weights: RaceWeights | null;
  readonly pairs: readonly SeedPair[];
  readonly games: number;
  readonly completedGames: number;
  readonly completedPairs: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly cutoffs: number;
  readonly failures: number;
  readonly cutoffRate: number;
  readonly meanPairScore: number | null;
  readonly meanVpMargin: number | null;
  readonly meanTurns: number | null;
  readonly meanDeadEndRoads: number | null;
  readonly meanBlockedRoads: number | null;
  readonly meanMainSettlements: number | null;
  readonly elapsedMs: number;
}

export interface IntervalEstimate {
  readonly n: number;
  readonly mean: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

export interface SelectionDecision {
  readonly selectedId: string;
  readonly selectedLabel: string;
  readonly reason: string;
  readonly adoptedChange: boolean;
}

function gameScore(trial: CrossPlayTrial): number | null {
  if (!trial.completed) return null;
  if (trial.outcome === "win") return 1;
  if (trial.outcome === "draw") return 0.5;
  if (trial.outcome === "loss") return 0;
  return null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizePairs(id: string, label: string, weights: RaceWeights | null, pairs: readonly SeedPair[]): CandidateEvaluation {
  const games = pairs.flatMap((pair) => [pair.c1, pair.c2]);
  const completed = games.filter((game) => game.completed);
  const completedPairs = pairs.filter((pair) => pair.bothCompleted);
  const cutoffs = games.filter((game) => game.status === "max_turns_reached" || game.status === "max_actions_reached").length;
  const failures = games.filter((game) => !game.completed && game.status !== "max_turns_reached" && game.status !== "max_actions_reached").length;
  return {
    id,
    label,
    weights,
    pairs,
    games: games.length,
    completedGames: completed.length,
    completedPairs: completedPairs.length,
    wins: completed.filter((game) => game.outcome === "win").length,
    losses: completed.filter((game) => game.outcome === "loss").length,
    draws: completed.filter((game) => game.outcome === "draw").length,
    cutoffs,
    failures,
    cutoffRate: games.length > 0 ? cutoffs / games.length : 0,
    meanPairScore: mean(completedPairs.map((pair) => pair.score ?? 0)),
    meanVpMargin: mean(completed.map((game) => game.vpMargin)),
    meanTurns: mean(completed.map((game) => game.turns)),
    meanDeadEndRoads: mean(games.map((game) => game.focusDeadEndRoads)),
    meanBlockedRoads: mean(games.map((game) => game.focusRoadsBlockedByOpponent)),
    meanMainSettlements: mean(games.map((game) => game.focusMainSettlements)),
    elapsedMs: games.reduce((sum, game) => sum + game.elapsedMs, 0)
  };
}

/** Resamples seed indexes. A seed contributes only when both sides have a completed pair. */
export function bootstrapMeanDifference(
  left: readonly (number | null)[],
  right: readonly (number | null)[],
  draws: number = RACE_TUNE_PROTOCOL.bootstrapDraws,
  seed: string = RACE_TUNE_PROTOCOL.bootstrapSeed
): IntervalEstimate {
  const paired: number[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === null || b === null) continue;
    paired.push(a - b);
  }
  if (paired.length === 0) return { n: 0, mean: null, low: null, high: null };
  const point = paired.reduce((sum, value) => sum + value, 0) / paired.length;
  const rng = createSeededRng(seed);
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    let sum = 0;
    for (let i = 0; i < paired.length; i++) sum += paired[rng.nextInt(paired.length)];
    samples.push(sum / paired.length);
  }
  samples.sort((a, b) => a - b);
  const lowIndex = Math.max(0, Math.ceil(0.025 * draws) - 1);
  const highIndex = Math.min(draws - 1, Math.floor(0.975 * draws));
  return { n: paired.length, mean: point, low: samples[lowIndex], high: samples[highIndex] };
}

export function bootstrapMean(
  scores: readonly (number | null)[],
  draws: number = RACE_TUNE_PROTOCOL.bootstrapDraws,
  seed: string = RACE_TUNE_PROTOCOL.bootstrapSeed
): IntervalEstimate {
  return bootstrapMeanDifference(scores, scores.map((score) => (score === null ? null : 0)), draws, seed);
}

function scoresOf(evaluation: CandidateEvaluation): (number | null)[] {
  return evaluation.pairs.map((pair) => pair.score);
}

/**
 * Predeclared rule. A non-current candidate is adopted only when its cutoff rate is within
 * 5 points of current, its completed-game VP margin is not more than 1 VP worse, and the
 * bootstrap interval for its pair-score minus current's pair-score lies entirely above 0.
 * Otherwise the current weights stay selected.
 */
export function selectRaceCandidate(evaluations: readonly CandidateEvaluation[]): SelectionDecision {
  const current = evaluations.find((evaluation) => evaluation.label === "current");
  if (!current) {
    return { selectedId: "baseline_heuristic_v1", selectedLabel: "current", reason: "Current weights were missing, so they are retained.", adoptedChange: false };
  }
  let best: { evaluation: CandidateEvaluation; difference: IntervalEstimate } | undefined;
  const notes: string[] = [];
  for (const evaluation of evaluations) {
    if (evaluation.label === "current") continue;
    if (evaluation.cutoffRate > current.cutoffRate + RACE_TUNE_PROTOCOL.cutoffSlack) {
      notes.push(`${evaluation.label} cutoff rate ${(evaluation.cutoffRate * 100).toFixed(1)}% exceeds current by more than 5 points.`);
      continue;
    }
    if (
      evaluation.meanVpMargin !== null &&
      current.meanVpMargin !== null &&
      evaluation.meanVpMargin < current.meanVpMargin - RACE_TUNE_PROTOCOL.maxVpMarginRegression
    ) {
      notes.push(`${evaluation.label} VP margin is more than 1 behind current.`);
      continue;
    }
    const difference = bootstrapMeanDifference(scoresOf(evaluation), scoresOf(current));
    if (difference.low === null || difference.high === null || difference.low <= 0) {
      notes.push(`${evaluation.label} interval [${difference.low ?? "n/a"}, ${difference.high ?? "n/a"}] is compatible with no gain over current.`);
      continue;
    }
    if (!best || (difference.mean ?? -Infinity) > (best.difference.mean ?? -Infinity)) {
      best = { evaluation, difference };
    }
  }
  if (!best) {
    return {
      selectedId: current.id,
      selectedLabel: current.label,
      reason: `Retain current weights. ${notes.join(" ")}`.trim(),
      adoptedChange: false
    };
  }
  return {
    selectedId: best.evaluation.id,
    selectedLabel: best.evaluation.label,
    reason: `${best.evaluation.label} pair-score minus current is ${best.difference.mean?.toFixed(3)} with interval [${best.difference.low?.toFixed(3)}, ${best.difference.high?.toFixed(3)}] on ${best.difference.n} paired seeds, and it passed the cutoff and VP-margin gates.`,
    adoptedChange: true
  };
}

function limits() {
  return {
    victoryPointsToWin: RACE_TUNE_PROTOCOL.victoryPointsToWin,
    maxTurns: RACE_TUNE_PROTOCOL.maxTurns,
    maxActions: RACE_TUNE_PROTOCOL.maxActions
  };
}

function evaluateCandidate(
  candidate: { id: string; label: string; weights: RaceWeights | null },
  policy: RolloutPolicy,
  opponent: RolloutPolicy,
  seeds: readonly string[]
): CandidateEvaluation {
  const pairs: SeedPair[] = [];
  for (const seed of seeds) {
    const opening = buildGeneratedOpening(seed);
    const [c1, c2] = playBothSeats({
      topology: opening.topology,
      seed,
      focus: policy,
      opponent,
      ...limits()
    });
    const left = gameScore(c1);
    const right = gameScore(c2);
    const bothCompleted = left !== null && right !== null;
    pairs.push({ seed, c1, c2, bothCompleted, score: bothCompleted ? ((left ?? 0) + (right ?? 0)) / 2 : null });
  }
  return summarizePairs(candidate.id, candidate.label, candidate.weights, pairs);
}

export interface RaceTuneReport {
  readonly protocol: typeof RACE_TUNE_PROTOCOL;
  readonly racerDiagnostic: CandidateEvaluation;
  readonly development: readonly CandidateEvaluation[];
  readonly selection: SelectionDecision;
  readonly confirmation: readonly CandidateEvaluation[];
  readonly developmentIntervals: readonly { readonly label: string; readonly versusCurrent: IntervalEstimate; readonly versusHalf: IntervalEstimate }[];
  readonly confirmationIntervals: readonly { readonly label: string; readonly versusHalf: IntervalEstimate }[];
}

export function runRaceWeightExperiment(): RaceTuneReport {
  const developmentSeeds = developmentSeedList();
  const confirmationSeeds = confirmationSeedList();
  if (!seedSetsAreDisjoint(developmentSeeds, confirmationSeeds)) {
    throw new Error("Development and confirmation seeds overlap.");
  }
  const distanceOnly = baselineDistanceOnlyRolloutPolicy;
  const candidatePolicies = RACE_TUNE_CANDIDATES.map((candidate) => ({
    candidate,
    policy: createHeuristicRolloutPolicy(candidate.id, true, candidate.weights)
  }));
  const currentPolicy = candidatePolicies.find((entry) => entry.candidate.label === "current")?.policy;
  if (!currentPolicy) throw new Error("Current candidate policy is missing.");

  const diagnosticSeeds = Array.from({ length: RACE_TUNE_PROTOCOL.diagnosticSeeds }, (_, index) => `${RACE_TUNE_PROTOCOL.diagnosticPrefix}-${index}`);
  const racerDiagnostic = evaluateCandidate(
    { id: settlementRacerRolloutPolicy.id, label: "racer_vs_dev", weights: null },
    settlementRacerRolloutPolicy,
    aggressiveDevRolloutPolicy,
    diagnosticSeeds
  );

  const development = candidatePolicies.map((entry) => evaluateCandidate(entry.candidate, entry.policy, distanceOnly, developmentSeeds));
  const selection = selectRaceCandidate(development);
  const currentEvaluation = development.find((evaluation) => evaluation.label === "current");
  const developmentIntervals = development
    .filter((evaluation) => evaluation.label !== "current")
    .map((evaluation) => ({
      label: evaluation.label,
      versusCurrent: bootstrapMeanDifference(scoresOf(evaluation), currentEvaluation ? scoresOf(currentEvaluation) : []),
      versusHalf: bootstrapMean(scoresOf(evaluation).map((score) => (score === null ? null : score - 0.5)))
    }));

  const selected = candidatePolicies.find((entry) => entry.candidate.label === selection.selectedLabel) ?? candidatePolicies[0];
  const confirmation: CandidateEvaluation[] = [
    evaluateCandidate(RACE_TUNE_CANDIDATES[0], currentPolicy, distanceOnly, confirmationSeeds)
  ];
  if (selected.candidate.label !== "current") {
    confirmation.push(evaluateCandidate(selected.candidate, selected.policy, distanceOnly, confirmationSeeds));
    confirmation.push(evaluateCandidate(
      { ...selected.candidate, id: `${selected.candidate.id}__vs_current`, label: `${selected.candidate.label}_vs_current` },
      selected.policy,
      currentPolicy,
      confirmationSeeds
    ));
  }
  const confirmationIntervals = confirmation.map((evaluation) => ({
    label: evaluation.label,
    versusHalf: bootstrapMean(scoresOf(evaluation).map((score) => (score === null ? null : score - 0.5)))
  }));

  return { protocol: RACE_TUNE_PROTOCOL, racerDiagnostic, development, selection, confirmation, developmentIntervals, confirmationIntervals };
}

function formatEvaluation(evaluation: CandidateEvaluation): string[] {
  const rate = evaluation.meanPairScore === null ? "n/a" : evaluation.meanPairScore.toFixed(3);
  const margin = evaluation.meanVpMargin === null ? "n/a" : evaluation.meanVpMargin.toFixed(2);
  const turns = evaluation.meanTurns === null ? "n/a" : evaluation.meanTurns.toFixed(1);
  return [
    `${evaluation.label} (${evaluation.id}): games ${evaluation.games}, completed games ${evaluation.completedGames}, completed pairs ${evaluation.completedPairs}, ` +
      `W${evaluation.wins} L${evaluation.losses} D${evaluation.draws}, cutoffs ${evaluation.cutoffs} (${(evaluation.cutoffRate * 100).toFixed(1)}%), failures ${evaluation.failures}`,
    `  pair score ${rate} | VP margin ${margin} | turns ${turns} | dead-end roads ${evaluation.meanDeadEndRoads?.toFixed(2) ?? "n/a"} | ` +
      `roads into an opponent ${evaluation.meanBlockedRoads?.toFixed(2) ?? "n/a"} | main settlements ${evaluation.meanMainSettlements?.toFixed(2) ?? "n/a"} | ${evaluation.elapsedMs.toFixed(0)}ms`
  ];
}

function formatInterval(label: string, interval: IntervalEstimate, baseline: string): string {
  if (interval.mean === null || interval.low === null || interval.high === null) {
    return `${label} vs ${baseline}: n=0, no completed pairs.`;
  }
  const clear = interval.low > 0 ? "interval is above 0" : interval.high < 0 ? "interval is below 0" : "interval includes 0";
  return `${label} vs ${baseline}: n=${interval.n}, mean ${interval.mean.toFixed(3)}, 95% bootstrap [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}], ${clear}.`;
}

export function formatRaceTuneReport(report: RaceTuneReport): string {
  const lines: string[] = [];
  lines.push("Race-weight experiment");
  lines.push(
    `Development seeds ${report.protocol.developmentSeeds} (${report.protocol.developmentPrefix}-0..). ` +
      `Confirmation seeds ${report.protocol.confirmationSeeds} (${report.protocol.confirmationPrefix}-0..). ` +
      `Each seed is one board and two seat games. First to ${report.protocol.victoryPointsToWin} VP, ` +
      `max turns ${report.protocol.maxTurns}, max actions ${report.protocol.maxActions}.`
  );
  lines.push("Pair score uses win=1, draw=0.5, loss=0 and is omitted unless both seats complete. Cutoffs are not wins, losses, or draws.");
  lines.push("Port increment is not tuned: it is not added to the race adjustment.");
  lines.push("");
  lines.push("Settlement racer diagnostic, separate seeds, against the development policy:");
  lines.push(...formatEvaluation(report.racerDiagnostic));
  lines.push("");
  lines.push("Development, each candidate against distance-only:");
  for (const evaluation of report.development) lines.push(...formatEvaluation(evaluation));
  lines.push("");
  for (const interval of report.developmentIntervals) {
    lines.push(formatInterval(interval.label, interval.versusCurrent, "current pair score"));
    lines.push(formatInterval(interval.label, interval.versusHalf, "an even 0.5 pair score"));
  }
  lines.push("");
  lines.push(`Selection: ${report.selection.selectedLabel} (${report.selection.selectedId}). Adopted change: ${report.selection.adoptedChange}.`);
  lines.push(report.selection.reason);
  lines.push("Live coach weights were not changed.");
  lines.push("");
  lines.push("Confirmation on held-out seeds:");
  for (const evaluation of report.confirmation) lines.push(...formatEvaluation(evaluation));
  for (const interval of report.confirmationIntervals) {
    lines.push(formatInterval(interval.label, interval.versusHalf, "an even 0.5 pair score"));
  }
  lines.push("These games are synthetic self-play. They do not establish professional strength.");
  return lines.join("\n");
}
