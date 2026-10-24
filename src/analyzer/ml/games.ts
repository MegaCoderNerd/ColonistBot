/**
 * Synthetic games for the offline learner.
 *
 * Heuristic demonstrations are behavior labels from named policies. They are not
 * recorded human games and they are not optimal moves. Self-play decisions are
 * requested from an external process; this module applies only legal actions.
 *
 * Domestic trades are not offered by this generator. Boards come from the
 * generated opening, which is not a Colonist map seed. Balanced dice use the
 * engine's approximate model. A game that hits the turn or action limit is
 * incomplete: its actor_win is null.
 */

import { buildGeneratedOpening } from "../benchmark/generated-board";
import { resolveDiceModelForRules } from "../engine/diceModel";
import {
  aggressiveDevRolloutPolicy,
  longestRoadRolloutPolicy,
  randomLegalRolloutPolicy,
  settlementRacerRolloutPolicy
} from "../engine/policies";
import { createSeededRng, deriveTrialSeed, type SeededRng } from "../engine/rng";
import {
  baselineDistanceOnlyRolloutPolicy,
  baselineRolloutPolicy,
  minAdditionalRoadsToOpenSettlementFromEdge,
  runRollout,
  type RolloutPolicy,
  type RolloutStatus
} from "../engine/rollout";
import { STANDARD_DEV_DECK_COUNTS, cloneConcreteSimState, type ConcreteDevCardKind, type ConcreteSimulatedGameState } from "../engine/state";
import { RESOURCES, type Resource } from "../types";
import { applyAction, createInitialConcreteState, getLegalActions, isActionLegal, type ActionOutcome, type SimulatedAction } from "../engine/transition";
import { PublicResourceLedger } from "./ledger";
import { observationLeaks, toObservation, wireObservation, type ColonistObservation } from "./observation";

const PLAYERS = ["c1", "c2"] as const;
const STANDARD_DECK: ConcreteDevCardKind[] = (Object.entries(STANDARD_DEV_DECK_COUNTS) as Array<[ConcreteDevCardKind, number]>).flatMap(
  ([kind, count]) => Array.from({ length: count }, () => kind)
);

export const TRAINING_EXAMPLE_VERSION = "colonist_training_example_v1";

export const POLICY_POOL: Readonly<Record<string, RolloutPolicy>> = {
  [baselineRolloutPolicy.id]: baselineRolloutPolicy,
  [baselineDistanceOnlyRolloutPolicy.id]: baselineDistanceOnlyRolloutPolicy,
  [aggressiveDevRolloutPolicy.id]: aggressiveDevRolloutPolicy,
  [longestRoadRolloutPolicy.id]: longestRoadRolloutPolicy,
  [settlementRacerRolloutPolicy.id]: settlementRacerRolloutPolicy,
  [randomLegalRolloutPolicy.id]: randomLegalRolloutPolicy
};

export type TargetProvenance =
  | "synthetic_fixture"
  | "heuristic_demonstration"
  | "synthetic_self_play"
  | "reinforcement_target"
  | "search_target";

export interface TrainingExample {
  readonly schema_version: typeof TRAINING_EXAMPLE_VERSION;
  readonly example_id: string;
  readonly game_id: string;
  readonly decision_index: number;
  readonly seed: string;
  readonly ruleset: "base";
  readonly player_count: 2;
  readonly generating_policy: string;
  readonly model_checkpoint: string | null;
  readonly completion_status: "completed" | "incomplete";
  readonly cutoff_reason: RolloutStatus | "invalid_state" | null;
  readonly target_provenance: TargetProvenance;
  readonly label_role: "heuristic_behavior" | "policy_sample" | "fixture" | "search";
  readonly chosen_action_id: string;
  /** Baseline label on this state, when the baseline was actually asked. Not a copy of another policy's move. */
  readonly teacher_action_id: string | null;
  readonly teacher_policy: string | null;
  readonly actor_win: number | null;
  readonly reward_note: string;
  readonly simulator: {
    readonly victory_points_to_win: number;
    readonly max_turns: number;
    readonly max_actions: number;
    readonly dice_mode: "balanced";
    readonly dice_model: "balanced_24_of_36_shoe_approx";
    readonly domestic_trades: "not_offered";
    readonly board: "generated_opening_not_colonist_map_seed";
    readonly rule_profile: string;
  };
  readonly observation: ColonistObservation;
}

export interface GameLimits {
  readonly seed: string;
  readonly victoryPointsToWin: number;
  readonly maxTurns: number;
  readonly maxActions: number;
}

export function learnerInitialState(limits: GameLimits) {
  const opening = buildGeneratedOpening(limits.seed);
  const trialSeed = deriveTrialSeed(limits.seed, 0, "ml-synth");
  const deck = createSeededRng(deriveTrialSeed(trialSeed, 0, "deck")).shuffle(STANDARD_DECK);
  return createInitialConcreteState({
    topology: opening.topology,
    playerIds: [...PLAYERS],
    devDeckOrder: deck,
    rules: {
      victoryPointsToWin: limits.victoryPointsToWin,
      cardDiscardLimit: 9,
      friendlyRobber: true,
      diceMode: "balanced"
    }
  });
}

function actorScore(completed: boolean, winnerId: string | undefined, actorId: string): number | null {
  if (!completed) return null;
  if (!winnerId) return 0.5;
  return winnerId === actorId ? 1 : 0;
}

function sameAction(left: SimulatedAction, right: SimulatedAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function exportHeuristicGame(
  limits: GameLimits,
  seatPolicies: readonly [string, string],
  teacherId?: string
): TrainingExample[] {
  const policies = seatPolicies.map((id) => {
    const policy = POLICY_POOL[id];
    if (!policy) throw new Error(`Unknown policy ${id}`);
    return policy;
  });
  const teacher = teacherId ? POLICY_POOL[teacherId] : undefined;
  if (teacherId && !teacher) throw new Error(`Unknown teacher policy ${teacherId}`);
  const teacherRng = createSeededRng(deriveTrialSeed(limits.seed, 0, "ml-teacher"));
  const created = learnerInitialState(limits);
  if (!created.ok) throw new Error(created.error.message);
  const trialSeed = deriveTrialSeed(limits.seed, 0, "ml-synth");
  const rollout = runRollout(created.state, createSeededRng(trialSeed), {
    policiesByPlayerId: { c1: policies[0], c2: policies[1] },
    maxTurns: limits.maxTurns,
    maxActions: limits.maxActions,
    recordTrace: true,
    validateEveryStep: false,
    separateDomainStreams: true
  });
  const trace = rollout.trace ?? [];
  let state = cloneConcreteSimState(created.state);
  const ledger = new PublicResourceLedger(PLAYERS);
  const gameId = `heuristic:${limits.seed}:${policies[0].id}:${policies[1].id}:vp${limits.victoryPointsToWin}:t${limits.maxTurns}`;
  const drafts: Array<Omit<TrainingExample, "completion_status" | "cutoff_reason" | "actor_win">> = [];
  let bankTradesThisTurn = 0;
  let lastTurn = state.completedTurns;
  for (const step of trace) {
    if (state.completedTurns !== lastTurn) {
      bankTradesThisTurn = 0;
      lastTurn = state.completedTurns;
    }
    const legal = getLegalActions(state, step.actorId);
    const observation = toObservation(state, step.actorId, legal, ledger);
    const leak = observationLeaks(observation);
    if (leak) throw new Error(`Observation leaked at ${leak}`);
    const chosen = observation.candidates.find((candidate) => candidate.simulator && sameAction(candidate.simulator, step.action));
    if (!chosen) throw new Error(`Heuristic action ${step.action.type} was not in the legal list`);
    let teacherActionId: string | null = null;
    if (teacher) {
      const teacherChoice = teacher.selectAction(state, step.actorId, legal, teacherRng, {
        stepIndex: step.stepIndex,
        bankTradesThisTurn
      });
      teacherActionId = teacherChoice
        ? observation.candidates.find((candidate) => candidate.simulator && sameAction(candidate.simulator, teacherChoice))?.action_id ?? null
        : null;
      if (!teacherActionId) throw new Error(`Teacher ${teacher.id} returned an action outside the legal list`);
    }
    const policy = step.actorId === "c1" ? policies[0] : policies[1];
    drafts.push({
      schema_version: TRAINING_EXAMPLE_VERSION,
      example_id: `${gameId}:${step.stepIndex}`,
      game_id: gameId,
      decision_index: step.stepIndex,
      seed: limits.seed,
      ruleset: "base",
      player_count: 2,
      generating_policy: policy.id,
      model_checkpoint: null,
      target_provenance: "heuristic_demonstration",
      label_role: "heuristic_behavior",
      chosen_action_id: chosen.action_id,
      teacher_action_id: teacherActionId,
      teacher_policy: teacher?.id ?? null,
      reward_note: teacher
        ? "Baseline label on a state visited by the named generating policy. Heuristic behavior, not an optimal move and not a human game."
        : "Behavior of a named heuristic. Not a ground-truth optimal move and not a human game.",
      simulator: simulatorNote(limits),
      observation
    });
    if (step.action.type === "bankTrade") bankTradesThisTurn += 1;
    const before = state;
    const transition = applyAction(state, step.actorId, step.action, step.outcome);
    if (!transition.ok) throw new Error(transition.error.message);
    ledger.record(before, step.actorId, step.action, step.outcome);
    state = transition.state;
  }
  const completed = rollout.completed === true && rollout.status === "completed";
  const cutoff = completed ? null : rollout.status;
  return drafts.map((draft) => ({
    ...draft,
    completion_status: completed ? "completed" : "incomplete",
    cutoff_reason: cutoff,
    actor_win: actorScore(completed, rollout.winnerId, draft.observation.actor_id)
  }));
}

function simulatorNote(limits: GameLimits): TrainingExample["simulator"] {
  return {
    victory_points_to_win: limits.victoryPointsToWin,
    max_turns: limits.maxTurns,
    max_actions: limits.maxActions,
    dice_mode: "balanced",
    dice_model: "balanced_24_of_36_shoe_approx",
    domestic_trades: "not_offered",
    board: "generated_opening_not_colonist_map_seed",
    rule_profile: limits.victoryPointsToWin === 10 ? "colonist_benchmark_1v1_v1" : limits.victoryPointsToWin === 15 ? "colonist_live_1v1_v1" : `colonist_custom_vp_${limits.victoryPointsToWin}_1v1`
  };
}

/** Not a feature. selectAction itself returns no text; this restates the priority and the road-reach number that priority uses. */
export interface TeacherDiagnostic {
  readonly explanation_available: false;
  readonly source: "baseline_priority_reconstruction";
  readonly phase: string;
  readonly rule: string;
  readonly road_reach?: {
    readonly dist: number;
    readonly best_corner_score: number;
    readonly opens_settlement_now: boolean;
  };
  readonly trade?: {
    readonly give: string;
    readonly give_count: number;
    readonly receive: string;
    readonly receive_count: number;
  };
}

function teacherDiagnostic(state: ConcreteSimulatedGameState, actorId: string, action: SimulatedAction | null): TeacherDiagnostic | null {
  if (!action) return null;
  const base = {
    explanation_available: false as const,
    source: "baseline_priority_reconstruction" as const,
    phase: state.phase
  };
  if (action.type === "buildRoad") {
    const reach = minAdditionalRoadsToOpenSettlementFromEdge(state, actorId, action.edgeIndex, 3);
    return {
      ...base,
      rule: "In main, the baseline builds a road when no settlement spot is open and settlements remain, or when it is contesting longest road. The edge score uses this settlement reach.",
      road_reach: {
        dist: reach.dist,
        best_corner_score: reach.bestCornerScore,
        opens_settlement_now: reach.dist === 0
      }
    };
  }
  if (action.type === "bankTrade") {
    return {
      ...base,
      rule: "In main, the baseline trades toward a city, an open settlement, a road when no settlement spot is open, or a development card, and it stops after four bank trades in the turn.",
      trade: {
        give: action.give,
        give_count: action.giveCount ?? 4,
        receive: action.receive,
        receive_count: action.receiveCount ?? 1
      }
    };
  }
  return { ...base, rule: "The baseline returns an action and does not attach a text reason." };
}

export interface SessionStart {
  readonly seed: string;
  readonly learner: "c1" | "c2" | "both";
  readonly opponent: string;
  readonly victoryPointsToWin: number;
  readonly maxTurns: number;
  readonly maxActions: number;
  readonly checkpoint: string | null;
  /** Summary omits board lists. Candidate features and the actor's production stay. */
  readonly detail?: "full" | "summary";
  /**
   * Optional heuristic asked for the same legal list. Its choice is recorded
   * and not applied. A missing teacher leaves the field null.
   */
  readonly teacher?: string | null;
}

export type SessionReply =
  | {
      readonly type: "decision";
      readonly game_id: string;
      readonly seed: string;
      readonly decision_index: number;
      readonly actor_id: string;
      readonly generating_policy: "external_learner";
      readonly model_checkpoint: string | null;
      readonly teacher_action_id: string | null;
      /**
       * Side channel for the offline audit. It is not part of the observation
       * and the network is not given these fields as features.
       */
      readonly teacher_diagnostic: TeacherDiagnostic | null;
      readonly observation: ColonistObservation;
    }
  | {
      readonly type: "terminal";
      readonly game_id: string;
      readonly seed: string;
      readonly completion_status: "completed" | "incomplete";
      readonly cutoff_reason: string | null;
      readonly winner_id: string | null;
      readonly actor_win: { readonly c1: number | null; readonly c2: number | null };
      readonly scores: {
        readonly c1: SeatProgress;
        readonly c2: SeatProgress;
      };
      readonly limits: { readonly victory_points_to_win: number; readonly max_turns: number; readonly max_actions: number };
      readonly turns: number;
      readonly actions: number;
      readonly learner: SessionStart["learner"];
      readonly opponent_policy: string | null;
      readonly model_checkpoint: string | null;
    }
  | { readonly type: "error"; readonly message: string };

export class ExternalLearnerSession {
  private state: ConcreteSimulatedGameState;
  private readonly diceRng: SeededRng;
  private readonly theftRng: SeededRng;
  private readonly policyRng: SeededRng;
  private readonly diceModel: ReturnType<typeof resolveDiceModelForRules>["model"];
  private readonly opponent: RolloutPolicy | null;
  private readonly teacher: RolloutPolicy | null;
  private readonly teacherRng: SeededRng;
  private readonly rollHistory: number[] = [];
  private actions = 0;
  private bankTradesThisTurn = 0;
  private lastTurn = 0;
  private decisionIndex = 0;
  private finished: SessionReply | null = null;
  private readonly ledger = new PublicResourceLedger(PLAYERS);

  private constructor(
    state: ConcreteSimulatedGameState,
    private readonly start: SessionStart,
    private readonly gameId: string,
    rng: SeededRng
  ) {
    const dice = resolveDiceModelForRules("balanced");
    if (!dice.ok) throw new Error(dice.error);
    this.diceModel = dice.model;
    this.state = state;
    this.diceRng = createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-dice"));
    this.theftRng = createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-theft"));
    this.policyRng = createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "rollout-policy"));
    this.teacherRng = createSeededRng(deriveTrialSeed(rng.initialSeed, 0, "ml-teacher"));
    this.opponent = start.learner === "both" ? null : POLICY_POOL[start.opponent] ?? null;
    this.teacher = start.teacher ? POLICY_POOL[start.teacher] ?? null : null;
    this.lastTurn = state.completedTurns;
  }

  static start(request: SessionStart): { session: ExternalLearnerSession | null; reply: SessionReply } {
    if (request.learner !== "both" && !POLICY_POOL[request.opponent]) {
      return { session: null, reply: { type: "error", message: `Unknown opponent policy ${request.opponent}` } };
    }
    if (request.teacher && !POLICY_POOL[request.teacher]) {
      return { session: null, reply: { type: "error", message: `Unknown teacher policy ${request.teacher}` } };
    }
    const created = learnerInitialState(request);
    if (!created.ok) {
      return { session: null, reply: { type: "error", message: created.error.message } };
    }
    const trialSeed = deriveTrialSeed(request.seed, 0, "ml-session");
    const opponentName = request.learner === "both" ? "external" : request.opponent;
    const gameId = `selfplay:${request.seed}:learner-${request.learner}:opp-${opponentName}:vp${request.victoryPointsToWin}:t${request.maxTurns}`;
    const session = new ExternalLearnerSession(created.state, request, gameId, createSeededRng(trialSeed));
    return { session, reply: session.advance() };
  }

  act(actionId: string): SessionReply {
    if (this.finished) return this.finished;
    const actorId = currentActor(this.state);
    if (!actorId || !this.isExternal(actorId)) return { type: "error", message: "No external decision is pending." };
    const legal = getLegalActions(this.state, actorId);
    const observation = toObservation(this.state, actorId, legal, this.ledger);
    const chosen = observation.candidates.find((candidate) => candidate.action_id === actionId);
    if (!chosen?.simulator || !isActionLegal(this.state, actorId, chosen.simulator)) {
      return { type: "error", message: `Action ${actionId} is not legal.` };
    }
    const applied = this.apply(actorId, chosen.simulator);
    if (applied) return applied;
    return this.advance();
  }

  private advance(): SessionReply {
    if (this.finished) return this.finished;
    while (this.state.phase !== "game_over") {
      const turns = this.state.completedTurns;
      if (turns >= this.start.maxTurns) return this.finish("max_turns_reached");
      if (this.actions >= this.start.maxActions) return this.finish("max_actions_reached");
      if (this.state.completedTurns !== this.lastTurn) {
        this.bankTradesThisTurn = 0;
        this.lastTurn = this.state.completedTurns;
      }
      const actorId = currentActor(this.state);
      if (!actorId) return this.finish("no_legal_actions");
      const legal = getLegalActions(this.state, actorId);
      if (legal.length === 0) return this.finish("no_legal_actions");
      if (this.isExternal(actorId)) {
        const full = toObservation(this.state, actorId, legal, this.ledger);
        let teacherActionId: string | null = null;
        let teacherChoice: SimulatedAction | null = null;
        if (this.teacher) {
          teacherChoice = this.teacher.selectAction(this.state, actorId, legal, this.teacherRng, {
            stepIndex: this.actions,
            bankTradesThisTurn: this.bankTradesThisTurn
          });
          teacherActionId = teacherChoice ? full.candidates.find((candidate) => candidate.simulator && sameAction(candidate.simulator, teacherChoice))?.action_id ?? null : null;
        }
        const observation = wireObservation(full, this.start.detail ?? "full");
        const leak = observationLeaks(observation);
        if (leak) return { type: "error", message: `Observation leaked at ${leak}` };
        return {
          type: "decision",
          game_id: this.gameId,
          seed: this.start.seed,
          decision_index: this.decisionIndex,
          actor_id: actorId,
          generating_policy: "external_learner",
          model_checkpoint: this.start.checkpoint,
          teacher_action_id: teacherActionId,
          teacher_diagnostic: teacherDiagnostic(this.state, actorId, teacherChoice),
          observation
        };
      }
      if (!this.opponent) return { type: "error", message: "Opponent policy is missing." };
      const chosen = this.opponent.selectAction(this.state, actorId, legal, this.policyRng, {
        stepIndex: this.actions,
        bankTradesThisTurn: this.bankTradesThisTurn
      });
      if (!chosen || !isActionLegal(this.state, actorId, chosen)) return this.finish("unsupported_action");
      const applied = this.apply(actorId, chosen);
      if (applied) return applied;
    }
    return this.finish("completed");
  }

  private apply(actorId: string, action: SimulatedAction): SessionReply | null {
    let outcome: ActionOutcome | undefined;
    if (action.type === "rollDice" && action.d1 === undefined && action.d2 === undefined && action.total === undefined) {
      const sample = this.diceModel.sampleOutcome(this.diceRng, { rollHistory: this.rollHistory, alignmentStatus: "aligned" });
      if (!sample.ok || !sample.outcome) return this.finish("unsupported_action");
      outcome = { dice: sample.outcome };
      this.rollHistory.push(sample.outcome.total);
    } else if (action.type === "rollDice") {
      const total = action.total ?? (action.d1 ?? 0) + (action.d2 ?? 0);
      this.rollHistory.push(total);
    } else if (action.type === "moveRobber" && typeof action.victimId === "string") {
      const victim = this.state.players.find((player) => player.id === action.victimId);
      if (victim && RESOURCES.some((resource) => victim.hand[resource] > 0)) {
        const weights = RESOURCES.map((resource) => Math.max(0, victim.hand[resource]));
        const stolen = RESOURCES[this.theftRng.weightedIndex(weights)] as Resource;
        outcome = { stolenResource: stolen };
      }
    }
    if (action.type === "bankTrade") this.bankTradesThisTurn += 1;
    const before = this.state;
    const transition = applyAction(this.state, actorId, action, outcome);
    if (!transition.ok) return this.finish("invalid_state");
    this.ledger.record(before, actorId, action, outcome);
    this.state = transition.state;
    this.actions += 1;
    if (this.isExternal(actorId)) this.decisionIndex += 1;
    return null;
  }

  private isExternal(actorId: string): boolean {
    return this.start.learner === "both" || this.start.learner === actorId;
  }

  private finish(status: string): SessionReply {
    const completed = status === "completed" && this.state.phase === "game_over";
    const winnerId = completed
      ? (this.state.winnerId ?? this.state.players.find((player) => player.actualSimulatedVp >= this.state.rules.victoryPointsToWin)?.id ?? null)
      : null;
    const reply: SessionReply = {
      type: "terminal",
      game_id: this.gameId,
      seed: this.start.seed,
      completion_status: completed ? "completed" : "incomplete",
      cutoff_reason: completed ? null : status,
      winner_id: winnerId,
      actor_win: {
        c1: actorScore(completed, winnerId ?? undefined, "c1"),
        c2: actorScore(completed, winnerId ?? undefined, "c2")
      },
      scores: seatScores(this.state),
      limits: {
        victory_points_to_win: this.start.victoryPointsToWin,
        max_turns: this.start.maxTurns,
        max_actions: this.start.maxActions
      },
      turns: this.state.completedTurns,
      actions: this.actions,
      learner: this.start.learner,
      opponent_policy: this.opponent?.id ?? null,
      model_checkpoint: this.start.checkpoint
    };
    this.finished = reply;
    return reply;
  }
}

export interface SeatProgress {
  readonly actual_vp: number;
  readonly visible_vp: number;
  readonly settlements_placed: number;
  readonly cities_placed: number;
  readonly roads_placed: number;
  readonly devs_bought: number;
  readonly knights_played: number;
  readonly has_longest_road: boolean;
  readonly has_largest_army: boolean;
  readonly road_length: number;
  readonly hand_size: number;
}

function seatScores(state: ConcreteSimulatedGameState): { c1: SeatProgress; c2: SeatProgress } {
  const score = (id: string): SeatProgress => {
    const player = state.players.find((candidate) => candidate.id === id);
    const hand = player?.hand;
    return {
      actual_vp: player?.actualSimulatedVp ?? 0,
      visible_vp: player?.visibleVp ?? 0,
      settlements_placed: player ? 5 - player.settlementsLeft : 0,
      cities_placed: player ? 4 - player.citiesLeft : 0,
      roads_placed: player ? 15 - player.roadsLeft : 0,
      devs_bought: player ? player.playedDevs.length + player.readyDevs.length + player.boughtDevsThisTurn.length + player.vpDevs : 0,
      knights_played: player?.knightsPlayed ?? 0,
      has_longest_road: player?.hasLongestRoad ?? false,
      has_largest_army: player?.hasLargestArmy ?? false,
      road_length: player?.roadLength ?? 0,
      hand_size: hand ? RESOURCES.reduce((sum, resource) => sum + hand[resource], 0) : 0
    };
  };
  return { c1: score("c1"), c2: score("c2") };
}

function currentActor(state: ConcreteSimulatedGameState): string | undefined {
  if (state.phase === "discard") {
    for (let offset = 0; offset < state.players.length; offset++) {
      const candidate = state.players[(state.turnPlayerIndex + offset) % state.players.length];
      if (candidate && candidate.pendingDiscardCount > 0) return candidate.id;
    }
    return undefined;
  }
  return state.players[state.turnPlayerIndex]?.id;
}

