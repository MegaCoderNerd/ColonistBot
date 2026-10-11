import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { buildBoardTopology } from "../src/analyzer/engine/topology";
import { buildObservedGameState } from "../src/analyzer/engine/state";
import { baselineRolloutPolicy, runRollout } from "../src/analyzer/engine/rollout";
import { aggressiveDevRolloutPolicy } from "../src/analyzer/engine/policies";
import { createSeededRng } from "../src/analyzer/engine/rng";
import { getLegalActions } from "../src/analyzer/engine/transition";

import {
  buildAllSyntheticFixtures,
  cloneConcreteState,
} from "../src/analyzer/benchmark/fixtures";

import {
  buildTacticalCases,
} from "../src/analyzer/benchmark/tactical";

import {
  runTacticalSuite,
  evaluatePolicyOnPosition,
  comparePoliciesPaired,
  assessCandidateConfidence,
} from "../src/analyzer/benchmark/evaluate";

import {
  buildObservedFromRecording,
  buildRecordingCorpus,
} from "../src/analyzer/benchmark/corpus";
import { validateConcreteSimState } from "../src/analyzer/engine/state";

type RecordingFixture =
  Parameters<typeof buildObservedFromRecording>[0] & {
    board?: Parameters<typeof buildBoardTopology>[0];
  };

function getRecordings(): RecordingFixture[] {
  const rootDir = process.cwd();

  const candidates = [
    process.env.COLONIST_RECORDINGS_PATH,
    join(rootDir, "fixtures", "colonist-recordings.json"),
    join(rootDir, "tests", "fixtures", "colonist-recordings.json"),
    join(rootDir, "colonist-recordings.json"),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        recordings?: RecordingFixture[];
      };

      if (Array.isArray(raw.recordings)) {
        return raw.recordings;
      }
    } catch {
      // Try the next candidate. Missing optional data must not
      // prevent deterministic synthetic benchmarks from running.
    }
  }

  return [];
}

function createFallbackBoard(): Parameters<typeof buildBoardTopology>[0] {
  // A radius-two hexagonal layout contains 19 hexes.
  const coordinates: Array<[number, number]> = [];

  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)) <= 2) {
        coordinates.push([x, y]);
      }
    }
  }

  return {
    hexes: coordinates.map(([x, y], index) => ({
      id: `c${index + 1}`,
      x,
      y,
      resource: null,
      number: null,
    })),
    ports: [],
    robberStart: "c1",
    cornerIds: {},
    edgeIds: {},
    portIds: {},
  };
}

const recordings = getRecordings();

function createStandardTopology() {
  const recordingBoard = recordings.find((recording) => recording.board)?.board;

  if (recordingBoard) {
    try {
      return buildBoardTopology(recordingBoard);
    } catch {
      // A malformed or unsupported recording board should not
      // prevent the synthetic-only test suite from running.
    }
  }

  return buildBoardTopology(createFallbackBoard());
}

const standardTopology = createStandardTopology();

function createFallbackObservedState() {
  return buildObservedGameState({
    board: standardTopology.board,
    placements: {
      settlements: new Map(),
      cities: new Map(),
      roads: new Map(),
    },
    players: [{ id: "c1" }, { id: "c2" }],
    selfId: "c1",
    selfHand: {
      lumber: 0,
      brick: 0,
      wool: 0,
      grain: 0,
      ore: 0,
    },
    selfHandKnown: true,
    warnings: [],
  });
}

const baselineObserved =
  (recordings.length > 0
    ? buildObservedFromRecording(recordings[0])?.observed
    : undefined) ?? createFallbackObservedState();

function createFixtures() {
  return buildAllSyntheticFixtures(standardTopology, baselineObserved);
}

describe("Stage 3.5 Benchmark Suite", () => {
  it("buildAllSyntheticFixtures produces all seven synthetic positions", () => {
    const fixtures = createFixtures();

    expect(fixtures).toHaveProperty("immediateWinByCity");
    expect(fixtures).toHaveProperty("noImmediateWinAvailable");
    expect(fixtures).toHaveProperty("insufficientResources");
    expect(fixtures).toHaveProperty("forcedDiscard");
    expect(fixtures).toHaveProperty("robberBlocksSelfWithKnight");
    expect(fixtures).toHaveProperty("multipleValidPlacements");
    expect(fixtures).toHaveProperty("openEndedMidgame");

    for (const fixture of Object.values(fixtures)) {
      expect(fixture.source).toBe("synthetic");
    }
  });

  it("tactical cases have the expected evidence classifications", () => {
    const cases = buildTacticalCases(createFixtures());

    expect(cases).toHaveLength(7);

    const evidenceCounts = cases.reduce<Record<string, number>>(
      (counts, tacticalCase) => {
        counts[tacticalCase.evidenceClass] =
          (counts[tacticalCase.evidenceClass] ?? 0) + 1;

        return counts;
      },
      {},
    );

    expect(evidenceCounts).toMatchObject({
      rule_proven: 4,
      constructed_scenario_proven: 1,
      multiple_valid_choices: 1,
      no_established_answer: 1,
    });
  });

  it("tactical suite returns a valid result for the baseline policy", () => {
    const cases = buildTacticalCases(createFixtures());

    const suite = runTacticalSuite(baselineRolloutPolicy, cases, {
      seed: 42,
    });

    expect(suite.policyId).toBe("baseline_heuristic_v1");
    expect(suite.provenCasesTotal).toBeGreaterThanOrEqual(0);
    expect(suite.provenCasesPassed).toBeGreaterThanOrEqual(0);
    expect(suite.provenPassRate).toBeGreaterThanOrEqual(0);
    expect(suite.wilson95).toBeDefined();
    expect(suite.failures).toBeInstanceOf(Array);
  });

  it("aggressive policy plays a defensive Knight only when it blocks own production", () => {
    const fixture = createFixtures().robberBlocksSelfWithKnight;
    const legalActions = getLegalActions(fixture.concrete, fixture.selfId);
    const selected = aggressiveDevRolloutPolicy.selectAction(
      fixture.concrete,
      fixture.selfId,
      legalActions,
      createSeededRng(42),
      { stepIndex: 0, bankTradesThisTurn: 0 }
    );
    expect(selected.type).toBe("playKnight");

    const unrelatedKnightState = cloneConcreteState(fixture.concrete);
    const unblockedHex = unrelatedKnightState.topology.hexes.findIndex(
      (hex) =>
        !hex.cornerIndices.some(
          (cornerIndex) => unrelatedKnightState.cornerOwner[cornerIndex] === fixture.selfId
        )
    );
    expect(unblockedHex).toBeGreaterThanOrEqual(0);
    unrelatedKnightState.robberHexIndex = unblockedHex;
    const unrelatedLegalActions = getLegalActions(unrelatedKnightState, fixture.selfId);
    const unrelatedSelected = aggressiveDevRolloutPolicy.selectAction(
      unrelatedKnightState,
      fixture.selfId,
      unrelatedLegalActions,
      createSeededRng(42),
      { stepIndex: 0, bankTradesThisTurn: 0 }
    );
    expect(unrelatedSelected.type).toBe("buyDevCard");
  });

  it("baseline converts an established city opportunity before non-winning alternatives", () => {
    const fixture = createFixtures().immediateWinByCity;
    const legalActions = getLegalActions(fixture.concrete, fixture.selfId);
    const selected = baselineRolloutPolicy.selectAction(
      fixture.concrete,
      fixture.selfId,
      legalActions,
      createSeededRng(7),
      { stepIndex: 0, bankTradesThisTurn: 0 }
    );

    expect(legalActions.some((action) => action.type === "buildCity")).toBe(true);
    expect(selected.type).toBe("buildCity");
  });

  it("evaluatePolicyOnPosition returns accounting for a synthetic position", () => {
    const position = createFixtures().noImmediateWinAvailable;

    const result = evaluatePolicyOnPosition(
      position,
      baselineRolloutPolicy,
      {
        numTrials: 2,
        baseSeed: 12345,
        maxTurnsPerRollout: 20,
        maxActionsPerRollout: 100,
      },
    );

    expect(result.policyId).toBe("baseline_heuristic_v1");
    expect(result.positionId).toBe(position.positionId);
    expect(result.groupId).toBe(position.groupId);
    expect(result.trialOutcomes).toBeInstanceOf(Array);

    expect(result.accounting).toMatchObject({
      sampleCount: 2,
      completed: expect.any(Number),
      wins: expect.any(Number),
      failed: expect.any(Number),
      cutoffMaxTurns: expect.any(Number),
      cutoffMaxActions: expect.any(Number),
      terminationReasons: expect.any(Object),
    });

    expect(result.trialOutcomes).toHaveLength(2);
    expect(Object.values(result.accounting.terminationReasons).reduce((sum, count) => sum + count, 0))
      .toBe(result.accounting.sampleCount);
  });

  it("excludes recording positions with no legal action", () => {
    if (recordings.length === 0) return;
    const corpus = buildRecordingCorpus(recordings, {
      sampleSeed: "stage-3.5-corpus",
      frameFractions: [0.35, 0.6, 0.85, 1]
    });
    expect(corpus.positions.every((position) =>
      position.features.legalActionCount > 0
    )).toBe(true);
    expect(corpus.coverage.positionsSkipped).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(recordings.length === 0)("keeps long rollouts reproducible and invariant-valid", () => {
    const position = buildRecordingCorpus(recordings, {
      sampleSeed: "stage-3.5-corpus",
      frameFractions: [0.35, 0.6, 0.85, 1]
    }).positions[0]!;
    expect(position).toBeDefined();
    const options = {
      policy: baselineRolloutPolicy,
      maxTurns: 40,
      maxActions: 300,
      validateEveryStep: true,
      separateDomainStreams: true
    } as const;
    const first = runRollout(position.concrete, createSeededRng(2468), options);
    const second = runRollout(position.concrete, createSeededRng(2468), options);

    expect(second.status).toBe(first.status);
    expect(second.completed).toBe(first.completed);
    expect(second.winnerId).toBe(first.winnerId);
    expect(second.actionsSimulated).toBe(first.actionsSimulated);
    expect(second.turnsSimulated).toBe(first.turnsSimulated);
    expect(validateConcreteSimState(first.finalState).valid).toBe(true);
    expect(validateConcreteSimState(second.finalState).valid).toBe(true);
  });

  it.skipIf(recordings.length === 0)("detects an already-terminal state without simulating another action", () => {
    const position = buildRecordingCorpus(recordings, {
      sampleSeed: "stage-3.5-corpus",
      frameFractions: [0.35, 0.6, 0.85, 1]
    }).positions[0]!;
    expect(position).toBeDefined();
    const terminalResult = runRollout(position.concrete, createSeededRng(1357), {
      policy: baselineRolloutPolicy,
      maxTurns: 120,
      maxActions: 600,
      validateEveryStep: true,
      separateDomainStreams: true
    });
    expect(terminalResult.status).toBe("completed");
    expect(terminalResult.completed).toBe(true);

    const result = runRollout(terminalResult.finalState, createSeededRng(99), {
      policy: baselineRolloutPolicy,
      maxTurns: 1,
      maxActions: 1,
      validateEveryStep: true
    });

    expect(result.status).toBe("completed");
    expect(result.completed).toBe(true);
    expect(result.winnerId).toBe(terminalResult.winnerId);
    expect(result.actionsSimulated).toBe(0);
  });

  it("paired comparison returns a valid classification for reproducible runs", () => {
    const position = createFixtures().noImmediateWinAvailable;

    // Both runs use the same position, policy, trial count and seed.
    // This tests comparison plumbing with reproducible paired inputs;
    // it does not establish that one policy is strategically superior.
    const options = {
      numTrials: 3,
      baseSeed: 12345,
      maxTurnsPerRollout: 20,
      maxActionsPerRollout: 100,
    };

    const resultA = evaluatePolicyOnPosition(
      position,
      baselineRolloutPolicy,
      options,
    );

    const resultB = evaluatePolicyOnPosition(
      position,
      baselineRolloutPolicy,
      options,
    );

    const comparison = comparePoliciesPaired(resultA, resultB, {
      significanceAlpha: 0.05,
      minPairedTrials: 1,
    });

    expect(comparison.policyAId).toBe(resultA.policyId);
    expect(comparison.policyBId).toBe(resultB.policyId);
    expect(comparison.pairedCompletedTrials).toBeGreaterThanOrEqual(0);

    expect(comparison.classification).toMatch(
      /^(evidence_favors_A|evidence_favors_B|no_clear_difference|insufficient_data)$/,
    );
  });

  it("separates candidate ranking stability from confidence", () => {
    expect(assessCandidateConfidence({ completed: 10, wins: 0 }, { completed: 10, wins: 0 }, 5))
      .toMatchObject({ status: "low_confidence", sufficientEvidenceForPreference: false, intervalsOverlap: true });
    expect(assessCandidateConfidence({ completed: 10, wins: 5 }, { completed: 10, wins: 4 }, 5))
      .toMatchObject({ status: "low_confidence", sufficientEvidenceForPreference: false, intervalsOverlap: true });
    expect(assessCandidateConfidence({ completed: 10, wins: 10 }, { completed: 10, wins: 0 }, 5))
      .toMatchObject({ status: "meaningful_preference", sufficientEvidenceForPreference: true, intervalsOverlap: false });
    expect(assessCandidateConfidence({ completed: 4, wins: 4 }, { completed: 4, wins: 0 }, 5))
      .toMatchObject({ status: "inconclusive", sufficientEvidenceForPreference: false });
  });
});