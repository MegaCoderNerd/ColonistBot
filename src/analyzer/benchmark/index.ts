/**
 * Stage 3.5 — Offline policy-evaluation harness (barrel export).
 *
 * ADDITIVE / EVALUATION ONLY. Nothing in this module is imported by production recommendation
 * code. Shadow mode stays disabled by default, and no legacy score, advice text, opening pick, or
 * map target is modified by this harness.
 *
 * Design principles:
 * - Reuses the Stage 3.1-3.4 engine and statistics rather than adding a second simulator or a
 *   competing statistical framework.
 * - Reports tactical pass rates separately from simulated win rates.
 * - Uses completed games only as the win-rate denominator; cutoffs and failures are separate.
 * - Keeps positions from the same recording grouped; groups are never split across folds.
 * - Labels inconclusive results as inconclusive instead of forcing a winner.
 */

export type {
  BenchmarkPosition,
  BenchmarkPositionFeatures,
  BenchmarkPositionSource,
  BenchmarkStratum,
  BudgetStabilityResult,
  BudgetSweepRow,
  CandidateForStability,
  PairedPolicyComparison,
  PolicyPositionResult,
  PolicyTrialAccounting,
  PolicyTrialOutcome,
  TacticalCase,
  TacticalCaseCategory,
  TacticalCaseResult,
  TacticalEvidenceClass,
  TacticalOutcome,
  TacticalSuiteResult
} from "./types";

export {
  classifyPosition,
  cloneConcreteState,
  extractPositionFeatures,
  positionFromConcreteState,
  recomputePlayerVp
} from "./positions";

export {
  buildObservedFromRecording,
  buildRecordingCorpus,
  groupPositionsByRecording,
  hasFullStratumCoverage,
  loadRecordings,
  materializePosition,
  resolveRecordingsPath,
  KNOWN_RECORDING_IDS,
  type BenchmarkCorpus,
  type BuildCorpusOptions,
  type CorpusCoverage
} from "./corpus";

export { buildAllSyntheticFixtures, createBaseState } from "./fixtures";

export { buildGeneratedOpening, type GeneratedOpening } from "./generated-board";

export { runCrossPlay, playBothSeats, crossPlayRoster, type CrossPlayReport, type CrossPlayOptions } from "./crossplay";

export {
  PROGRESS_DIAG_PROTOCOL,
  diagnosisSeedList,
  holdoutSeedList,
  diagnoseGame,
  runProgressDiagnosis,
  formatProgressReport,
  settlementRoadDistance,
  compareCityTradeCorrection,
  formatCityTradeComparison
} from "./progress-diag";

export {
  DEVCARD_RULE_PROTOCOL,
  developmentSeedList as devCardDevelopmentSeedList,
  devCardHoldoutSeedList,
  devCardSeedSetsAreDisjoint,
  compareDevCardRule,
  decideDevCardRule,
  formatDevCardComparison
} from "./devcard-rule";

export {
  RACE_TUNE_PROTOCOL,
  RACE_TUNE_CANDIDATES,
  confirmationSeedList,
  developmentSeedList,
  seedSetsAreDisjoint,
  selectRaceCandidate,
  bootstrapMeanDifference,
  runRaceWeightExperiment,
  formatRaceTuneReport
} from "./race-tune";

export { buildTacticalCases, type TacticalPositions } from "./tactical";

export {
  comparePoliciesPaired,
  describeAction,
  evaluatePolicyOnPosition,
  measureCandidateBudgetStability,
  runTacticalSuite,
  type PolicyComparisonOptions
} from "./evaluate";

export {
  evaluatedPolicies,
  formatReport,
  runBenchmark,
  type BenchmarkReport,
  type BenchmarkRunOptions
} from "./run";
