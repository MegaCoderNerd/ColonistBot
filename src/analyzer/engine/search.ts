/**
 * Offline root-pruned Monte Carlo search (`search_v1`).
 *
 * The production policy stays `baseline_heuristic_v1`. This policy ranks a few
 * legal root actions with that heuristic's public scores, then plays each one
 * out with the same heuristic on both seats. It is not a tree search and it
 * does not call a neural network.
 *
 * Scoring. A finished win is +1, a finished loss is -1, and a finished game
 * with no winner is 0. A turn or action cutoff is the root player's known VP
 * minus the best opponent's visible VP, divided by the victory-point goal, and
 * clamped to [-1, 1]. Own victory-point development cards count, because the
 * root player can see them. Opponent victory-point cards do not. A cutoff is
 * not a loss. The cutoff value is only a VP-margin scale so it can be averaged
 * with win and loss. It ignores production, the hand, and who is about to roll.
 */

import { RESOURCES, type Resource } from "../types";
import { createSeededRng, deriveTrialSeed, type SeededRng } from "./rng";
import {
  actionIdentity,
  baselineRolloutPolicy,
  heuristicActionScore,
  runRollout,
  type RolloutPolicy,
  type RolloutResult
} from "./rollout";
import { resolveDiceModelForRules } from "./diceModel";
import {
  cloneConcreteSimState,
  type ActionDevCardKind,
  type ConcreteDevCardKind,
  type ConcreteSimulatedGameState
} from "./state";
import { applyAction, getLegalActions, isActionLegal, type SimulatedAction } from "./transition";

const HIDDEN_DEV: ActionDevCardKind = "knight";
const HIDDEN_DECK_CARD: ConcreteDevCardKind = "knight";
const TYPE_ORDER = [
  "buildCity",
  "buildSettlement",
  "playRoadBuilding",
  "playYearOfPlenty",
  "playMonopoly",
  "playKnight",
  "bankTrade",
  "buildRoad",
  "placeFreeRoad",
  "buyDevCard",
  "moveRobber",
  "discard",
  "placeSetupSettlement",
  "placeSetupRoad",
  "rollDice",
  "endTurn"
] as const;

export const SEARCH_V1_DEFAULTS = {
  rootK: 8,
  rolloutsPerCandidate: 16,
  maxSimulatedTurns: 70,
  maxSimulatedActions: 450,
  masterSeed: "search-v1"
} as const;

export interface SearchConfig {
  readonly rootK?: number;
  readonly rolloutsPerCandidate?: number;
  readonly maxSimulatedTurns?: number;
  readonly maxSimulatedActions?: number;
  readonly masterSeed?: number | string;
  /** Hard cap on rollout simulations for one decision. Defaults to rootK * rolloutsPerCandidate. */
  readonly maxSimulations?: number;
  readonly validateEveryStep?: boolean;
}

export interface SearchCandidateDiagnostic {
  readonly action: string;
  readonly samples: number;
  readonly mean: number;
  readonly standardError: number;
  readonly terminalSamples: number;
  readonly cutoffSamples: number;
  readonly failedSamples: number;
  readonly elapsedMs: number;
}

export interface SearchDecisionDiagnostic {
  readonly actorId: string;
  readonly legalCount: number;
  readonly candidates: readonly SearchCandidateDiagnostic[];
  readonly baseline: string;
  readonly selected: string;
  readonly changedFromBaseline: boolean;
  readonly fallback: boolean;
  readonly simulations: number;
  readonly budget: number;
  readonly elapsedMs: number;
}

export interface SearchRunDiagnostic {
  readonly decisions: number;
  readonly fallbacks: number;
  readonly candidates: number;
  readonly overrides: number;
  readonly overridesAheadOfNoise: number;
  readonly simulations: number;
  readonly terminalSamples: number;
  readonly cutoffSamples: number;
  readonly failedSamples: number;
  readonly elapsedMs: number;
  readonly decisionElapsedMs: readonly number[];
  readonly last: SearchDecisionDiagnostic | null;
}

/**
 * Copy of the concrete state a policy is allowed to read.
 * Opponent hand composition, unplayed development cards, and the deck order are
 * replaced with canonical stand-ins that keep public counts. The true state is
 * what the transition uses.
 */
export function projectPolicyObservation(state: ConcreteSimulatedGameState, actorId: string): ConcreteSimulatedGameState {
  const view = cloneConcreteSimState(state);
  view.devDeckOrder = view.devDeckOrder.map(() => HIDDEN_DECK_CARD);
  for (const player of view.players) {
    if (player.id === actorId) continue;
    const count = RESOURCES.reduce((sum, resource) => sum + player.hand[resource], 0);
    player.hand = { lumber: count, brick: 0, wool: 0, grain: 0, ore: 0 };
    player.readyDevs = player.readyDevs.map(() => HIDDEN_DEV);
    player.boughtDevsThisTurn = player.boughtDevsThisTurn.map(() => HIDDEN_DEV);
    player.vpDevs = 0;
    player.actualSimulatedVp = player.visibleVp;
    player.observedConfirmedVp = player.visibleVp;
  }
  return view;
}

export function withObservationBoundary(policy: RolloutPolicy): RolloutPolicy {
  return {
    id: policy.id,
    selectAction(state, actorId, legalActions, rng, context) {
      return policy.selectAction(projectPolicyObservation(state, actorId), actorId, legalActions, rng, context);
    }
  };
}

export function selectSearchRootCandidates(
  legal: readonly SimulatedAction[],
  baseline: SimulatedAction,
  scoreOf: (action: SimulatedAction) => number,
  rootK: number
): SimulatedAction[] {
  const chosen: SimulatedAction[] = [];
  const seen = new Set<string>();
  const add = (action: SimulatedAction) => {
    const key = actionIdentity(action);
    if (seen.has(key)) return;
    seen.add(key);
    chosen.push(action);
  };
  add(baseline);
  const groups = new Map<string, SimulatedAction[]>();
  const ranked = [...legal].sort((left, right) => scoreOf(right) - scoreOf(left) || actionIdentity(left).localeCompare(actionIdentity(right)));
  for (const action of ranked) {
    const group = groups.get(action.type) ?? [];
    group.push(action);
    groups.set(action.type, group);
  }
  let progressed = true;
  while (chosen.length < rootK && progressed) {
    progressed = false;
    for (const type of TYPE_ORDER) {
      const group = groups.get(type);
      const next = group?.shift();
      if (!next) continue;
      const before = chosen.length;
      add(next);
      if (chosen.length !== before) progressed = true;
      if (chosen.length >= rootK) break;
    }
  }
  for (const action of ranked) {
    if (chosen.length >= rootK) break;
    add(action);
  }
  return chosen;
}

function cutoffScore(result: RolloutResult, rootId: string): number | null {
  if (result.status === "completed" && result.completed) {
    if (result.winnerId === undefined) return 0;
    return result.winnerId === rootId ? 1 : -1;
  }
  if (result.status !== "max_turns_reached" && result.status !== "max_actions_reached") return null;
  const self = result.finalState.players.find((player) => player.id === rootId);
  const selfVp = (self?.visibleVp ?? 0) + (self?.vpDevs ?? 0);
  let opponentVp = 0;
  for (const player of result.finalState.players) {
    if (player.id !== rootId) opponentVp = Math.max(opponentVp, player.visibleVp);
  }
  const goal = Math.max(1, result.finalState.rules.victoryPointsToWin);
  return Math.max(-1, Math.min(1, (selfVp - opponentVp) / goal));
}

function applyRootAction(
  state: ConcreteSimulatedGameState,
  actorId: string,
  action: SimulatedAction,
  rng: SeededRng
): ConcreteSimulatedGameState | null {
  let outcome: { dice?: { d1: number; d2: number; total: number }; stolenResource?: Resource } | undefined;
  if (action.type === "rollDice" && action.total === undefined && action.d1 === undefined && action.d2 === undefined) {
    const resolved = resolveDiceModelForRules(state.rules.diceMode);
    if (!resolved.ok) return null;
    const history = state.dice.thrown && state.dice.total !== undefined ? [state.dice.total] : [];
    const sample = resolved.model.sampleOutcome(rng, { rollHistory: history, alignmentStatus: "aligned" });
    if (!sample.ok || !sample.outcome) return null;
    outcome = { dice: sample.outcome };
  } else if (action.type === "moveRobber" && typeof action.victimId === "string") {
    const victim = state.players.find((player) => player.id === action.victimId);
    const weights = victim ? RESOURCES.map((resource) => Math.max(0, victim.hand[resource])) : [];
    if (weights.some((weight) => weight > 0)) {
      outcome = { stolenResource: RESOURCES[rng.weightedIndex(weights)] };
    }
  }
  const applied = applyAction(state, actorId, action, outcome);
  return applied.ok ? applied.state : null;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardError(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const center = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

export interface SearchPolicy extends RolloutPolicy {
  readonly config: {
    readonly rootK: number;
    readonly rolloutsPerCandidate: number;
    readonly maxSimulatedTurns: number;
    readonly maxSimulatedActions: number;
    readonly masterSeed: number | string;
    readonly maxSimulations: number;
  };
  diagnostics(): SearchRunDiagnostic;
}

export function createSearchPolicy(config: SearchConfig = {}): SearchPolicy {
  const rootK = config.rootK ?? SEARCH_V1_DEFAULTS.rootK;
  const rolloutsPerCandidate = config.rolloutsPerCandidate ?? SEARCH_V1_DEFAULTS.rolloutsPerCandidate;
  const maxSimulatedTurns = config.maxSimulatedTurns ?? SEARCH_V1_DEFAULTS.maxSimulatedTurns;
  const maxSimulatedActions = config.maxSimulatedActions ?? SEARCH_V1_DEFAULTS.maxSimulatedActions;
  const masterSeed = config.masterSeed ?? SEARCH_V1_DEFAULTS.masterSeed;
  const maxSimulations = config.maxSimulations ?? rootK * rolloutsPerCandidate;
  const rolloutPolicy = withObservationBoundary(baselineRolloutPolicy);
  const decisions: SearchDecisionDiagnostic[] = [];
  let decisionIndex = 0;

  const resolved = { rootK, rolloutsPerCandidate, maxSimulatedTurns, maxSimulatedActions, masterSeed, maxSimulations };

  return {
    id: "search_v1",
    config: resolved,
    diagnostics() {
      return {
        decisions: decisions.length,
        fallbacks: decisions.filter((decision) => decision.fallback).length,
        candidates: decisions.reduce((sum, decision) => sum + decision.candidates.length, 0),
        overrides: decisions.filter((decision) => decision.changedFromBaseline).length,
        overridesAheadOfNoise: decisions.filter((decision) => {
          if (!decision.changedFromBaseline) return false;
          const ranked = decision.candidates.filter((candidate) => candidate.samples > 0).sort((left, right) => right.mean - left.mean);
          return ranked.length >= 2 && ranked[0].mean - ranked[1].mean > ranked[0].standardError;
        }).length,
        simulations: decisions.reduce((sum, decision) => sum + decision.simulations, 0),
        terminalSamples: decisions.reduce((sum, decision) => sum + decision.candidates.reduce((inner, candidate) => inner + candidate.terminalSamples, 0), 0),
        cutoffSamples: decisions.reduce((sum, decision) => sum + decision.candidates.reduce((inner, candidate) => inner + candidate.cutoffSamples, 0), 0),
        failedSamples: decisions.reduce((sum, decision) => sum + decision.candidates.reduce((inner, candidate) => inner + candidate.failedSamples, 0), 0),
        elapsedMs: decisions.reduce((sum, decision) => sum + decision.elapsedMs, 0),
        decisionElapsedMs: decisions.map((decision) => decision.elapsedMs),
        last: decisions[decisions.length - 1] ?? null
      };
    },
    selectAction(state, actorId, legalActions, rng, context) {
      const started = Date.now();
      const decisionId = decisionIndex;
      decisionIndex += 1;
      const view = projectPolicyObservation(state, actorId);
      const baseline = baselineRolloutPolicy.selectAction(view, actorId, legalActions, rng, context);
      const finish = (selected: SimulatedAction, fallback: boolean, candidates: SearchCandidateDiagnostic[], simulations: number) => {
        const selectedId = actionIdentity(selected);
        const baselineId = actionIdentity(baseline);
        decisions.push({
          actorId,
          legalCount: legalActions.length,
          candidates,
          baseline: baselineId,
          selected: selectedId,
          changedFromBaseline: selectedId !== baselineId,
          fallback,
          simulations,
          budget: maxSimulations,
          elapsedMs: Date.now() - started
        });
        return selected;
      };
      try {
        if (legalActions.length <= 1 || maxSimulations <= 0 || rootK <= 0 || rolloutsPerCandidate <= 0) {
          return finish(baseline, true, [], 0);
        }
        if (!isActionLegal(state, actorId, baseline)) return finish(legalActions[0], true, [], 0);
        const candidates = selectSearchRootCandidates(
          legalActions,
          baseline,
          (action) => heuristicActionScore(view, actorId, action, context),
          rootK
        ).filter((action) => isActionLegal(state, actorId, action));
        if (candidates.length === 0) return finish(baseline, true, [], 0);
        const rows: SearchCandidateDiagnostic[] = [];
        const scored: Array<{ action: SimulatedAction; mean: number }> = [];
        let simulations = 0;
        for (const action of candidates) {
          const values: number[] = [];
          let terminalSamples = 0;
          let cutoffSamples = 0;
          let failedSamples = 0;
          const candidateStarted = Date.now();
          for (let trial = 0; trial < rolloutsPerCandidate && simulations < maxSimulations; trial++) {
            simulations += 1;
            const seed = deriveTrialSeed(masterSeed, context.stepIndex, `search-v1-${decisionId}-${trial}`);
            const trialRng = createSeededRng(seed);
            const next = applyRootAction(state, actorId, action, trialRng);
            if (!next) {
              failedSamples += 1;
              continue;
            }
            const result = runRollout(next, trialRng, {
              policy: rolloutPolicy,
              maxTurns: maxSimulatedTurns,
              maxActions: maxSimulatedActions,
              validateEveryStep: config.validateEveryStep === true,
              separateDomainStreams: false
            });
            const value = cutoffScore(result, actorId);
            if (value === null) {
              failedSamples += 1;
              continue;
            }
            values.push(value);
            if (result.completed) terminalSamples += 1;
            else cutoffSamples += 1;
          }
          rows.push({
            action: actionIdentity(action),
            samples: values.length,
            mean: mean(values),
            standardError: standardError(values),
            terminalSamples,
            cutoffSamples,
            failedSamples,
            elapsedMs: Date.now() - candidateStarted
          });
          if (values.length > 0) scored.push({ action, mean: mean(values) });
        }
        if (scored.length === 0) return finish(baseline, true, rows, simulations);
        scored.sort((left, right) => {
          if (right.mean !== left.mean) return right.mean - left.mean;
          const leftBaseline = actionIdentity(left.action) === actionIdentity(baseline) ? 0 : 1;
          const rightBaseline = actionIdentity(right.action) === actionIdentity(baseline) ? 0 : 1;
          if (leftBaseline !== rightBaseline) return leftBaseline - rightBaseline;
          return actionIdentity(left.action).localeCompare(actionIdentity(right.action));
        });
        return finish(scored[0].action, false, rows, simulations);
      } catch {
        return finish(baseline, true, [], 0);
      }
    }
  };
}

