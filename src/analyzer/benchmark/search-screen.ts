/**
 * Offline strength screen for `search_v1` against `baseline_heuristic_v1`.
 *
 * Ruleset label: Colonist-oriented 1v1. Victory points, discard limit, friendly
 * robber, and balanced dice match the live 1v1 rules. The board is a generated
 * standard layout, not a Colonist map seed. Player-to-player trades are not
 * offered. The outer game uses the existing 70-turn and 450-action benchmark
 * caps, so a 15-VP game often ends as a cutoff. Cutoffs are not wins or losses.
 */

import { buildGeneratedOpening } from "./generated-board";
import { playBothSeats, type CrossPlayTrial } from "./crossplay";
import { baselineRolloutPolicy } from "../engine/rollout";
import { computeWilson95Interval } from "../engine/shadow";
import { createSearchPolicy, withObservationBoundary, type SearchPolicy, type SearchRunDiagnostic } from "../engine/search";

export interface SearchScreenConfig {
  readonly seeds: readonly string[];
  readonly rootK: number;
  readonly rolloutsPerCandidate: number;
  readonly maxSimulatedTurns: number;
  readonly maxSimulatedActions: number;
  readonly maxSimulations?: number;
  readonly victoryPointsToWin: number;
  readonly maxTurns: number;
  readonly maxActions: number;
  readonly masterSeed: string;
  readonly label: string;
}

export interface SearchScreenReport {
  readonly label: string;
  readonly ruleset: {
    readonly victoryPointsToWin: number;
    readonly cardDiscardLimit: 9;
    readonly friendlyRobber: true;
    readonly diceMode: "balanced";
    readonly domesticTrades: "disabled";
    readonly board: "generated-standard-layout";
    readonly mapSeed: "not a Colonist map seed";
    readonly outerMaxTurns: number;
    readonly outerMaxActions: number;
  };
  readonly search: {
    readonly id: "search_v1";
    readonly rootK: number;
    readonly rolloutsPerCandidate: number;
    readonly maxSimulatedTurns: number;
    readonly maxSimulatedActions: number;
    readonly maxSimulations: number;
    readonly masterSeed: string;
  };
  readonly seeds: number;
  readonly games: number;
  readonly seatCounts: { readonly c1: number; readonly c2: number };
  readonly completed: number;
  readonly cutoffs: number;
  readonly failures: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly wilson95: { readonly lower: number; readonly upper: number; readonly standardError: number } | null;
  readonly pairedSeeds: number;
  readonly pairedMeanScore: number | null;
  readonly pairedScoreInterval95: { readonly lower: number; readonly upper: number } | null;
  readonly meanFinalVp: number | null;
  readonly meanVpMargin: number | null;
  readonly meanFinalVpCompleted: number | null;
  readonly meanVpMarginCompleted: number | null;
  readonly gameElapsedMs: { readonly median: number | null; readonly p90: number | null; readonly mean: number | null };
  readonly decisionElapsedMs: { readonly median: number | null; readonly p90: number | null; readonly mean: number | null };
  readonly diagnostics: SearchRunDiagnostic;
  readonly trials: readonly CrossPlayTrial[];
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function runSearchScreen(config: SearchScreenConfig): SearchScreenReport {
  const search = createSearchPolicy({
    rootK: config.rootK,
    rolloutsPerCandidate: config.rolloutsPerCandidate,
    maxSimulatedTurns: config.maxSimulatedTurns,
    maxSimulatedActions: config.maxSimulatedActions,
    masterSeed: config.masterSeed,
    ...(config.maxSimulations !== undefined ? { maxSimulations: config.maxSimulations } : {})
  });
  const opponent = withObservationBoundary(baselineRolloutPolicy);
  const trials: CrossPlayTrial[] = [];
  for (const seed of config.seeds) {
    const opening = buildGeneratedOpening(seed);
    trials.push(
      ...playBothSeats({
        topology: opening.topology,
        seed,
        focus: search,
        opponent,
        victoryPointsToWin: config.victoryPointsToWin,
        maxTurns: config.maxTurns,
        maxActions: config.maxActions
      })
    );
  }
  return assembleSearchScreen(config, search, trials);
}

export function assembleSearchScreen(config: SearchScreenConfig, search: SearchPolicy, trials: readonly CrossPlayTrial[]): SearchScreenReport {
  const diagnostics = search.diagnostics();
  const completed = trials.filter((trial) => trial.completed);
  const wins = completed.filter((trial) => trial.outcome === "win").length;
  const losses = completed.filter((trial) => trial.outcome === "loss").length;
  const draws = completed.filter((trial) => trial.outcome === "draw").length;
  const bySeed = new Map<number, CrossPlayTrial[]>();
  for (const trial of trials) {
    const group = bySeed.get(trial.seed) ?? [];
    group.push(trial);
    bySeed.set(trial.seed, group);
  }
  const pairedScores: number[] = [];
  for (const group of bySeed.values()) {
    if (group.length !== 2 || group.some((trial) => !trial.completed)) continue;
    const score = group.reduce((sum, trial) => sum + (trial.outcome === "win" ? 1 : trial.outcome === "loss" ? -1 : 0), 0) / 2;
    pairedScores.push(score);
  }
  const pairedMean = average(pairedScores);
  let pairedInterval: { lower: number; upper: number } | null = null;
  if (pairedMean !== null && pairedScores.length >= 2) {
    const variance = pairedScores.reduce((sum, value) => sum + (value - pairedMean) ** 2, 0) / (pairedScores.length - 1);
    const half = 1.959963984540054 * Math.sqrt(variance / pairedScores.length);
    pairedInterval = { lower: pairedMean - half, upper: pairedMean + half };
  }
  const elapsed = trials.map((trial) => trial.elapsedMs);
  const decisionElapsed = diagnostics.decisionElapsedMs;
  return {
    label: config.label,
    ruleset: {
      victoryPointsToWin: config.victoryPointsToWin,
      cardDiscardLimit: 9,
      friendlyRobber: true,
      diceMode: "balanced",
      domesticTrades: "disabled",
      board: "generated-standard-layout",
      mapSeed: "not a Colonist map seed",
      outerMaxTurns: config.maxTurns,
      outerMaxActions: config.maxActions
    },
    search: {
      id: "search_v1",
      rootK: config.rootK,
      rolloutsPerCandidate: config.rolloutsPerCandidate,
      maxSimulatedTurns: config.maxSimulatedTurns,
      maxSimulatedActions: config.maxSimulatedActions,
      maxSimulations: search.config.maxSimulations,
      masterSeed: config.masterSeed
    },
    seeds: config.seeds.length,
    games: trials.length,
    seatCounts: {
      c1: trials.filter((trial) => trial.focusPlayerId === "c1").length,
      c2: trials.filter((trial) => trial.focusPlayerId === "c2").length
    },
    completed: completed.length,
    cutoffs: trials.filter((trial) => trial.status === "max_turns_reached" || trial.status === "max_actions_reached").length,
    failures: trials.filter((trial) => !trial.completed && trial.status !== "max_turns_reached" && trial.status !== "max_actions_reached").length,
    wins,
    losses,
    draws,
    wilson95: computeWilson95Interval(wins, completed.length),
    pairedSeeds: pairedScores.length,
    pairedMeanScore: pairedMean,
    pairedScoreInterval95: pairedInterval,
    meanFinalVp: average(trials.map((trial) => trial.focusVp)),
    meanVpMargin: average(trials.map((trial) => trial.vpMargin)),
    meanFinalVpCompleted: average(completed.map((trial) => trial.focusVp)),
    meanVpMarginCompleted: average(completed.map((trial) => trial.vpMargin)),
    gameElapsedMs: { median: quantile(elapsed, 0.5), p90: quantile(elapsed, 0.9), mean: average(elapsed) },
    decisionElapsedMs: { median: quantile(decisionElapsed, 0.5), p90: quantile(decisionElapsed, 0.9), mean: average(decisionElapsed) },
    diagnostics,
    trials
  };
}

export function formatSearchScreen(report: SearchScreenReport): string {
  const wilson = report.wilson95
    ? `[${report.wilson95.lower.toFixed(3)}, ${report.wilson95.upper.toFixed(3)}]`
    : "n/a";
  const paired = report.pairedScoreInterval95
    ? `${report.pairedMeanScore?.toFixed(3)} [${report.pairedScoreInterval95.lower.toFixed(3)}, ${report.pairedScoreInterval95.upper.toFixed(3)}]`
    : "n/a";
  return [
    report.label,
    `rules ${report.ruleset.victoryPointsToWin} VP, discard ${report.ruleset.cardDiscardLimit}, friendly robber, ${report.ruleset.diceMode} dice, domestic trades ${report.ruleset.domesticTrades}, ${report.ruleset.mapSeed}`,
    `search rootK=${report.search.rootK} rollouts=${report.search.rolloutsPerCandidate} innerTurns=${report.search.maxSimulatedTurns} innerActions=${report.search.maxSimulatedActions} maxSimulations=${report.search.maxSimulations} seed=${report.search.masterSeed}`,
    `outer cap ${report.ruleset.outerMaxTurns} turns / ${report.ruleset.outerMaxActions} actions`,
    `seeds ${report.seeds}, games ${report.games}, seats c1=${report.seatCounts.c1} c2=${report.seatCounts.c2}`,
    `completed ${report.completed} (W ${report.wins} L ${report.losses} D ${report.draws}), cutoffs ${report.cutoffs}, failures ${report.failures}`,
    `Wilson 95 on completed win rate ${wilson}`,
    `paired seed score ${paired} over ${report.pairedSeeds} fully completed seeds`,
    `mean VP ${report.meanFinalVp ?? "n/a"} margin ${report.meanVpMargin ?? "n/a"}; completed VP ${report.meanFinalVpCompleted ?? "n/a"} margin ${report.meanVpMarginCompleted ?? "n/a"}`,
    `game ms median ${report.gameElapsedMs.median ?? "n/a"} p90 ${report.gameElapsedMs.p90 ?? "n/a"} mean ${report.gameElapsedMs.mean ?? "n/a"}`,
    `decision ms median ${report.decisionElapsedMs.median ?? "n/a"} p90 ${report.decisionElapsedMs.p90 ?? "n/a"} mean ${report.decisionElapsedMs.mean ?? "n/a"}`,
    `candidates ${report.diagnostics.candidates}, simulations ${report.diagnostics.simulations}, terminal ${report.diagnostics.terminalSamples}, cutoff ${report.diagnostics.cutoffSamples}, failed ${report.diagnostics.failedSamples}, fallbacks ${report.diagnostics.fallbacks}, overrides ${report.diagnostics.overrides}, overrides ahead of one standard error ${report.diagnostics.overridesAheadOfNoise}, decisions ${report.diagnostics.decisions}`
  ].join("\n");
}
