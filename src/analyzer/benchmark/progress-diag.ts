/**
 * Offline cutoff diagnostics. Replays the benchmark simulator on a frozen seed list
 * and summarizes why a game did or did not reach 10 VP. It does not change recommendations.
 */

import type { Resource } from "../types";
import { RESOURCES } from "../types";
import { STANDARD_DEV_DECK_COUNTS, type ConcreteDevCardKind, type ConcreteSimulatedGameState, type ConcreteSimulatedPlayerState } from "../engine/state";
import { applyAction, createInitialConcreteState, getLegalActions, type SimulatedAction } from "../engine/transition";
import { createSeededRng, deriveTrialSeed } from "../engine/rng";
import {
  baselineDistanceOnlyRolloutPolicy,
  baselineRolloutPolicy,
  createHeuristicRolloutPolicy,
  runRollout,
  type RolloutPolicy
} from "../engine/rollout";
import { aggressiveDevRolloutPolicy, settlementRacerRolloutPolicy } from "../engine/policies";
import { buildGeneratedOpening } from "./generated-board";
import { playBothSeats, type CrossPlayTrial } from "./crossplay";
import { bootstrapMean } from "./race-tune";

const PLAYERS = ["c1", "c2"] as const;
const STANDARD_DECK: ConcreteDevCardKind[] = (Object.entries(STANDARD_DEV_DECK_COUNTS) as Array<[ConcreteDevCardKind, number]>).flatMap(
  ([kind, count]) => Array.from({ length: count }, () => kind)
);

export const PROGRESS_DIAG_PROTOCOL = {
  diagnosisSeeds: 8,
  diagnosisPrefix: "race-tune-dev",
  holdoutSeeds: 20,
  holdoutPrefix: "progress-holdout",
  victoryPointsToWin: 10,
  maxTurns: 70,
  maxActions: 450
} as const;

export function diagnosisSeedList(): string[] {
  return Array.from({ length: PROGRESS_DIAG_PROTOCOL.diagnosisSeeds }, (_, index) => `${PROGRESS_DIAG_PROTOCOL.diagnosisPrefix}-${index}`);
}

export function holdoutSeedList(): string[] {
  return Array.from({ length: PROGRESS_DIAG_PROTOCOL.holdoutSeeds }, (_, index) => `${PROGRESS_DIAG_PROTOCOL.holdoutPrefix}-${index}`);
}

type Bag = Record<Resource, number>;

export interface VpEvent {
  readonly turn: number;
  readonly playerId: string;
  readonly action: string;
  readonly delta: number;
  readonly vp: number;
  readonly settlements: number;
  readonly cities: number;
  readonly longestRoad: boolean;
  readonly largestArmy: boolean;
  readonly vpDevs: number;
}

export interface SuspiciousTurn {
  readonly turn: number;
  readonly playerId: string;
  readonly action: string;
  readonly hand: Bag;
  readonly note: string;
}

export interface PlayerProgress {
  readonly id: string;
  readonly vp: number;
  readonly settlements: number;
  readonly cities: number;
  readonly roadLength: number;
  readonly roadsBuilt: number;
  readonly roadsWithoutAccessGain: number;
  readonly devsBought: number;
  readonly knightsPlayed: number;
  readonly longestRoad: boolean;
  readonly largestArmy: boolean;
  readonly vpDevs: number;
  readonly production: Bag;
  readonly produced: Bag;
  readonly spent: Bag;
  readonly finalHand: Bag;
  readonly partialCityTradesRefused: number;
  readonly oreSpentOnDevsWhileShort: number;
  readonly consistentVp: boolean;
}

export interface GameDiagnostic {
  readonly seed: string;
  readonly focusPlayerId: string;
  readonly focusPolicyId: string;
  readonly opponentPolicyId: string;
  readonly status: string;
  readonly completed: boolean;
  readonly turns: number;
  readonly actions: number;
  readonly winnerId?: string;
  readonly resourceConserved: boolean;
  readonly replayOk: boolean;
  readonly raceDecisions: number;
  readonly raceDisagreements: number;
  readonly players: readonly PlayerProgress[];
  readonly vpEvents: readonly VpEvent[];
  readonly suspicious: readonly SuspiciousTurn[];
  readonly actionCounts: Readonly<Record<string, number>>;
}

function emptyBag(): Bag {
  return { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
}

function copyBag(hand: Bag): Bag {
  return { lumber: hand.lumber, brick: hand.brick, wool: hand.wool, grain: hand.grain, ore: hand.ore };
}

function addBag(target: Bag, delta: Bag, sign: 1 | -1): void {
  for (const resource of RESOURCES) target[resource] += sign * delta[resource];
}

function bagTotal(state: ConcreteSimulatedGameState): number {
  let total = 0;
  for (const resource of RESOURCES) {
    total += state.bank[resource];
    for (const player of state.players) total += player.hand[resource];
  }
  return total;
}

function pieceCounts(state: ConcreteSimulatedGameState, playerId: string): { settlements: number; cities: number } {
  let settlements = 0;
  let cities = 0;
  for (let index = 0; index < state.cornerOwner.length; index++) {
    if (state.cornerOwner[index] !== playerId) continue;
    if (state.cornerPiece[index] === 1) settlements += 1;
    else if (state.cornerPiece[index] === 2) cities += 1;
  }
  return { settlements, cities };
}

function productionPips(state: ConcreteSimulatedGameState, playerId: string): Bag {
  const out = emptyBag();
  for (let cornerIndex = 0; cornerIndex < state.cornerOwner.length; cornerIndex++) {
    if (state.cornerOwner[cornerIndex] !== playerId) continue;
    const weight = state.cornerPiece[cornerIndex] === 2 ? 2 : 1;
    for (const hexIndex of state.topology.corners[cornerIndex].hexIndices) {
      const hex = state.topology.hexes[hexIndex];
      if (hex.resource && hex.pips > 0) out[hex.resource] += hex.pips * weight;
    }
  }
  return out;
}

function cornerOpen(state: ConcreteSimulatedGameState, cornerIndex: number): boolean {
  if (state.cornerPiece[cornerIndex] !== 0) return false;
  const corner = state.topology.corners[cornerIndex];
  if (!corner || corner.pips <= 0) return false;
  return !corner.adjacentCornerIndices.some((next) => state.cornerPiece[next] > 0);
}

/** Minimum new roads from the player's network to a distance-legal producing corner. */
export function settlementRoadDistance(state: ConcreteSimulatedGameState, playerId: string): number {
  const distance = new Map<number, number>();
  for (let cornerIndex = 0; cornerIndex < state.cornerOwner.length; cornerIndex++) {
    if (state.cornerOwner[cornerIndex] === playerId) distance.set(cornerIndex, 0);
  }
  for (let edgeIndex = 0; edgeIndex < state.edgeOwner.length; edgeIndex++) {
    if (state.edgeOwner[edgeIndex] !== playerId) continue;
    const edge = state.topology.edges[edgeIndex];
    for (const cornerIndex of [edge.c1, edge.c2]) {
      if ((distance.get(cornerIndex) ?? Infinity) > 0) distance.set(cornerIndex, 0);
    }
  }
  const done = new Set<number>();
  let best = 99;
  for (;;) {
    let current: number | undefined;
    for (const [cornerIndex, cost] of distance) {
      if (done.has(cornerIndex)) continue;
      if (current === undefined || cost < distance.get(current)!) current = cornerIndex;
    }
    if (current === undefined) break;
    done.add(current);
    const cost = distance.get(current)!;
    if (cost > 0 && cornerOpen(state, current) && cost < best) best = cost;
    if (cost >= best) continue;
    const occupier = state.cornerOwner[current];
    if (occupier && occupier !== playerId) continue;
    const corner = state.topology.corners[current];
    for (let index = 0; index < corner.incidentEdgeIndices.length; index++) {
      const edgeIndex = corner.incidentEdgeIndices[index];
      const next = corner.adjacentCornerIndices[index];
      const owner = state.edgeOwner[edgeIndex];
      if (owner && owner !== playerId) continue;
      const nextCost = cost + (owner === playerId ? 0 : 1);
      if (nextCost < (distance.get(next) ?? Infinity)) distance.set(next, nextCost);
    }
  }
  return best;
}

function cityTradeCapacity(player: ConcreteSimulatedPlayerState): { missing: number; multiples: number } {
  const need = { grain: 2, ore: 3 } as const;
  let missing = 0;
  let multiples = 0;
  for (const resource of RESOURCES) {
    const required = need[resource as "grain" | "ore"] ?? 0;
    if (player.hand[resource] < required) missing += required - player.hand[resource];
    const surplus = Math.max(0, player.hand[resource] - required);
    const rate = player.ratios[resource];
    if (rate >= 2 && rate <= 4) multiples += Math.floor(surplus / rate);
  }
  return { missing, multiples };
}

function actionLabel(action: SimulatedAction): string {
  if (action.type === "buildRoad" || action.type === "placeSetupRoad" || action.type === "placeFreeRoad") return `${action.type}(${action.edgeIndex})`;
  if (action.type === "buildSettlement" || action.type === "placeSetupSettlement" || action.type === "buildCity") return `${action.type}(${action.cornerIndex})`;
  if (action.type === "bankTrade") return `bankTrade ${action.give}->${action.receive}`;
  if (action.type === "moveRobber") return `moveRobber(${action.hexIndex})`;
  return action.type;
}

function initialState(seed: string) {
  const opening = buildGeneratedOpening(seed);
  const trialSeed = deriveTrialSeed(seed, 0, "crossplay");
  const deck = createSeededRng(deriveTrialSeed(trialSeed, 0, "deck")).shuffle([...STANDARD_DECK]);
  const created = createInitialConcreteState({
    topology: opening.topology,
    playerIds: [...PLAYERS],
    devDeckOrder: deck,
    rules: {
      victoryPointsToWin: PROGRESS_DIAG_PROTOCOL.victoryPointsToWin,
      cardDiscardLimit: 9,
      friendlyRobber: true,
      diceMode: "balanced"
    }
  });
  return { opening, trialSeed, created };
}

export function diagnoseGame(args: {
  readonly seed: string;
  readonly focus: RolloutPolicy;
  readonly opponent: RolloutPolicy;
  readonly focusPlayerId: (typeof PLAYERS)[number];
  readonly compare?: RolloutPolicy;
  readonly maxTurns?: number;
  readonly maxActions?: number;
}): GameDiagnostic {
  const { trialSeed, created } = initialState(args.seed);
  if (!created.ok) {
    return emptyDiagnostic(args, "invalid_state");
  }
  const opponentId = args.focusPlayerId === "c1" ? "c2" : "c1";
  const rollout = runRollout(created.state, createSeededRng(deriveTrialSeed(trialSeed, 0, "play")), {
    policy: args.focus,
    policiesByPlayerId: {
      [args.focusPlayerId]: args.focus,
      [opponentId]: args.opponent
    },
    maxTurns: args.maxTurns ?? PROGRESS_DIAG_PROTOCOL.maxTurns,
    maxActions: args.maxActions ?? PROGRESS_DIAG_PROTOCOL.maxActions,
    validateEveryStep: false,
    recordTrace: true,
    separateDomainStreams: true
  });
  const replayStart = initialState(args.seed);
  if (!replayStart.created.ok) return emptyDiagnostic(args, "invalid_state");
  let state = replayStart.created.state;
  const expectedTotal = bagTotal(state);
  let resourceConserved = true;
  let replayOk = true;
  const produced = new Map<string, Bag>(PLAYERS.map((id) => [id, emptyBag()]));
  const spent = new Map<string, Bag>(PLAYERS.map((id) => [id, emptyBag()]));
  const roadsBuilt = new Map<string, number>(PLAYERS.map((id) => [id, 0]));
  const roadsWithout = new Map<string, number>(PLAYERS.map((id) => [id, 0]));
  const devsBought = new Map<string, number>(PLAYERS.map((id) => [id, 0]));
  const partialRefused = new Map<string, number>(PLAYERS.map((id) => [id, 0]));
  const oreOnDevs = new Map<string, number>(PLAYERS.map((id) => [id, 0]));
  const actionCounts: Record<string, number> = {};
  const vpEvents: VpEvent[] = [];
  const suspicious: SuspiciousTurn[] = [];
  let raceDecisions = 0;
  let raceDisagreements = 0;
  let bankTradesThisTurn = 0;
  let tradeTurn = state.completedTurns;
  let turnTradesOre = new Set<string>();

  for (const step of rollout.trace ?? []) {
    actionCounts[step.action.type] = (actionCounts[step.action.type] ?? 0) + 1;
    const beforePlayers = new Map(state.players.map((player) => [player.id, { vp: player.actualSimulatedVp, hand: copyBag(player.hand), roadLength: player.roadLength, ore: player.hand.ore }]));
    const beforeDistance = step.action.type === "buildRoad" || step.action.type === "placeFreeRoad"
      ? settlementRoadDistance(state, step.actorId)
      : 0;
    if (state.completedTurns !== tradeTurn) {
      bankTradesThisTurn = 0;
      tradeTurn = state.completedTurns;
    }
    const context = { stepIndex: step.stepIndex, bankTradesThisTurn };
    if (args.compare && step.actorId === args.focusPlayerId && (step.phase === "main" || step.phase === "setup_road")) {
      const legal = getLegalActions(state, step.actorId);
      if (legal.length > 1) {
        const rngSeed = `${args.seed}:${step.stepIndex}`;
        const played = args.focus.selectAction(state, step.actorId, legal, createSeededRng(rngSeed), context);
        const other = args.compare.selectAction(state, step.actorId, legal, createSeededRng(rngSeed), context);
        raceDecisions += 1;
        if (JSON.stringify(played) !== JSON.stringify(other)) raceDisagreements += 1;
      }
    }
    if (step.action.type === "bankTrade") bankTradesThisTurn += 1;
    if (step.action.type === "buyDevCard") {
      const buyer = state.players.find((player) => player.id === step.actorId);
      if (buyer && buyer.citiesLeft > 0 && buyer.hand.ore < 3) {
        oreOnDevs.set(step.actorId, (oreOnDevs.get(step.actorId) ?? 0) + 1);
        if (suspicious.length < 12 && step.actorId === args.focusPlayerId) {
          suspicious.push({
            turn: step.completedTurns,
            playerId: step.actorId,
            action: "buyDevCard",
            hand: copyBag(buyer.hand),
            note: `bought a dev with ${buyer.hand.ore} ore and ${buyer.hand.grain} grain while a city still needs 3 ore and 2 grain`
          });
        }
      }
    }
    if (step.action.type === "endTurn") {
      const ender = state.players.find((player) => player.id === step.actorId);
      if (ender) {
        const gate = cityTradeCapacity(ender);
        const oreTradeLegal = getLegalActions(state, step.actorId).some((action) => action.type === "bankTrade" && action.receive === "ore");
        if (ender.citiesLeft > 0 && gate.missing > 0 && gate.multiples > 0 && gate.multiples < gate.missing && !turnTradesOre.has(step.actorId) && oreTradeLegal) {
          partialRefused.set(step.actorId, (partialRefused.get(step.actorId) ?? 0) + 1);
          if (suspicious.length < 8) {
            suspicious.push({
              turn: step.completedTurns,
              playerId: step.actorId,
              action: "endTurn",
              hand: copyBag(ender.hand),
              note: `city still short ${gate.missing}, bank multiples available ${gate.multiples}, no ore trade`
            });
          }
        }
      }
      turnTradesOre = new Set();
    }
    const applied = applyAction(state, step.actorId, step.action, step.outcome);
    if (!applied.ok) {
      replayOk = false;
      break;
    }
    state = applied.state;
    if (bagTotal(state) !== expectedTotal) resourceConserved = false;
    const actorBefore = beforePlayers.get(step.actorId);
    const actorAfter = state.players.find((player) => player.id === step.actorId);
    if (step.action.type === "rollDice") {
      for (const player of state.players) {
        const before = beforePlayers.get(player.id);
        if (!before) continue;
        for (const resource of RESOURCES) {
          const delta = player.hand[resource] - before.hand[resource];
          if (delta > 0) produced.get(player.id)![resource] += delta;
        }
      }
    } else if (actorBefore && actorAfter) {
      for (const resource of RESOURCES) {
        const delta = actorAfter.hand[resource] - actorBefore.hand[resource];
        if (delta < 0 && step.action.type !== "discard" && step.action.type !== "bankTrade") spent.get(step.actorId)![resource] += -delta;
      }
    }
    for (const player of state.players) {
      const before = beforePlayers.get(player.id);
      if (!before || player.actualSimulatedVp === before.vp) continue;
      const pieces = pieceCounts(state, player.id);
      vpEvents.push({
        turn: step.completedTurns,
        playerId: player.id,
        action: actionLabel(step.action),
        delta: player.actualSimulatedVp - before.vp,
        vp: player.actualSimulatedVp,
        settlements: pieces.settlements,
        cities: pieces.cities,
        longestRoad: player.hasLongestRoad,
        largestArmy: player.hasLargestArmy,
        vpDevs: player.vpDevs
      });
    }
    if (step.action.type === "buildRoad" || step.action.type === "placeFreeRoad") {
      roadsBuilt.set(step.actorId, (roadsBuilt.get(step.actorId) ?? 0) + 1);
      const afterDistance = settlementRoadDistance(state, step.actorId);
      const lengthGain = (actorAfter?.roadLength ?? 0) > (actorBefore?.roadLength ?? 0);
      if (afterDistance >= beforeDistance && !lengthGain) {
        roadsWithout.set(step.actorId, (roadsWithout.get(step.actorId) ?? 0) + 1);
        if (suspicious.length < 8) {
          suspicious.push({
            turn: step.completedTurns,
            playerId: step.actorId,
            action: actionLabel(step.action),
            hand: copyBag(actorAfter?.hand ?? emptyBag()),
            note: `road left settlement distance at ${afterDistance}`
          });
        }
      }
    }
    if (step.action.type === "bankTrade" && step.action.receive === "ore") turnTradesOre.add(step.actorId);
    if (step.action.type === "buyDevCard") devsBought.set(step.actorId, (devsBought.get(step.actorId) ?? 0) + 1);
  }

  const players = state.players.map((player) => {
    const pieces = pieceCounts(state, player.id);
    const expectedVp = pieces.settlements + pieces.cities * 2 + (player.hasLongestRoad ? 2 : 0) + (player.hasLargestArmy ? 2 : 0) + player.vpDevs;
    return {
      id: player.id,
      vp: player.actualSimulatedVp,
      settlements: pieces.settlements,
      cities: pieces.cities,
      roadLength: player.roadLength,
      roadsBuilt: roadsBuilt.get(player.id) ?? 0,
      roadsWithoutAccessGain: roadsWithout.get(player.id) ?? 0,
      devsBought: devsBought.get(player.id) ?? 0,
      knightsPlayed: player.knightsPlayed,
      longestRoad: player.hasLongestRoad,
      largestArmy: player.hasLargestArmy,
      vpDevs: player.vpDevs,
      production: productionPips(state, player.id),
      produced: produced.get(player.id) ?? emptyBag(),
      spent: spent.get(player.id) ?? emptyBag(),
      finalHand: copyBag(player.hand),
      partialCityTradesRefused: partialRefused.get(player.id) ?? 0,
      oreSpentOnDevsWhileShort: oreOnDevs.get(player.id) ?? 0,
      consistentVp: expectedVp === player.actualSimulatedVp
    };
  });

  return {
    seed: args.seed,
    focusPlayerId: args.focusPlayerId,
    focusPolicyId: args.focus.id,
    opponentPolicyId: args.opponent.id,
    status: rollout.status,
    completed: rollout.completed,
    turns: rollout.turnsSimulated,
    actions: rollout.actionsSimulated,
    ...(rollout.winnerId !== undefined ? { winnerId: rollout.winnerId } : {}),
    resourceConserved,
    replayOk,
    raceDecisions,
    raceDisagreements,
    players,
    vpEvents,
    suspicious,
    actionCounts
  };
}

function emptyDiagnostic(args: { seed: string; focus: RolloutPolicy; opponent: RolloutPolicy; focusPlayerId: string }, status: string): GameDiagnostic {
  return {
    seed: args.seed,
    focusPlayerId: args.focusPlayerId,
    focusPolicyId: args.focus.id,
    opponentPolicyId: args.opponent.id,
    status,
    completed: false,
    turns: 0,
    actions: 0,
    resourceConserved: false,
    replayOk: false,
    raceDecisions: 0,
    raceDisagreements: 0,
    players: [],
    vpEvents: [],
    suspicious: [],
    actionCounts: {}
  };
}

export interface ProgressDiagReport {
  readonly seeds: readonly string[];
  readonly games: readonly GameDiagnostic[];
}

export function runProgressDiagnosis(): ProgressDiagReport {
  const seeds = diagnosisSeedList();
  const games: GameDiagnostic[] = [];
  for (const seed of seeds) {
    for (const seat of PLAYERS) {
      games.push(diagnoseGame({
        seed,
        focus: baselineRolloutPolicy,
        opponent: baselineDistanceOnlyRolloutPolicy,
        focusPlayerId: seat,
        compare: baselineDistanceOnlyRolloutPolicy
      }));
      games.push(diagnoseGame({
        seed,
        focus: settlementRacerRolloutPolicy,
        opponent: aggressiveDevRolloutPolicy,
        focusPlayerId: seat
      }));
    }
  }
  return { seeds, games };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatGame(game: GameDiagnostic): string[] {
  const lines = [
    `${game.seed} ${game.focusPolicyId} as ${game.focusPlayerId} vs ${game.opponentPolicyId}: ${game.status}, completed ${game.completed}, turns ${game.turns}, actions ${game.actions}, replay ${game.replayOk}, resources conserved ${game.resourceConserved}`
  ];
  if (game.raceDecisions > 0) {
    lines.push(`  race disagreements ${game.raceDisagreements}/${game.raceDecisions}`);
  }
  for (const player of game.players) {
    lines.push(
      `  ${player.id} VP ${player.vp} (settlements ${player.settlements}, cities ${player.cities}, longest ${player.longestRoad}, army ${player.largestArmy}, vp cards ${player.vpDevs}, consistent ${player.consistentVp}) ` +
        `roads ${player.roadsBuilt} without access gain ${player.roadsWithoutAccessGain} devs ${player.devsBought} knights ${player.knightsPlayed}`
    );
    lines.push(
      `    production pips L${player.production.lumber} B${player.production.brick} W${player.production.wool} G${player.production.grain} O${player.production.ore} ` +
        `| produced O${player.produced.ore} G${player.produced.grain} | final hand L${player.finalHand.lumber} B${player.finalHand.brick} W${player.finalHand.wool} G${player.finalHand.grain} O${player.finalHand.ore} ` +
        `| partial city trades refused ${player.partialCityTradesRefused} | ore spent on devs while short ${player.oreSpentOnDevsWhileShort}`
    );
  }
  for (const event of game.vpEvents.slice(0, 8)) {
    lines.push(`  VP t${event.turn} ${event.playerId} ${event.action} delta ${event.delta} -> ${event.vp}`);
  }
  for (const turn of game.suspicious.slice(0, 4)) {
    lines.push(`  t${turn.turn} ${turn.playerId} ${turn.action}: ${turn.note} hand O${turn.hand.ore} G${turn.hand.grain} L${turn.hand.lumber} B${turn.hand.brick} W${turn.hand.wool}`);
  }
  return lines;
}

export function formatProgressReport(report: ProgressDiagReport): string {
  const lines: string[] = [];
  lines.push(`Progress diagnosis on ${report.seeds.length} existing development seeds, both seats.`);
  lines.push("First to 10 VP, max turns 70, max actions 450. Cutoffs stay incomplete.");
  const groups = new Map<string, GameDiagnostic[]>();
  for (const game of report.games) {
    const key = `${game.focusPolicyId} vs ${game.opponentPolicyId}`;
    const list = groups.get(key);
    if (list) list.push(game);
    else groups.set(key, [game]);
  }
  for (const [key, games] of groups) {
    const cutoffs = games.filter((game) => !game.completed);
    const focusPlayers = games.map((game) => game.players.find((player) => player.id === game.focusPlayerId)).filter((player): player is PlayerProgress => player !== undefined);
    const raceDecisions = games.reduce((sum, game) => sum + game.raceDecisions, 0);
    const raceDisagreements = games.reduce((sum, game) => sum + game.raceDisagreements, 0);
    lines.push("");
    lines.push(`${key}: games ${games.length}, completed ${games.length - cutoffs.length}, cutoffs ${cutoffs.length}, failures ${games.filter((game) => game.status !== "completed" && game.status !== "max_turns_reached" && game.status !== "max_actions_reached").length}`);
    lines.push(
      `  focus mean VP ${mean(focusPlayers.map((player) => player.vp)).toFixed(2)}, cities ${mean(focusPlayers.map((player) => player.cities)).toFixed(2)}, settlements ${mean(focusPlayers.map((player) => player.settlements)).toFixed(2)}, ` +
        `roads without access gain ${mean(focusPlayers.map((player) => player.roadsWithoutAccessGain)).toFixed(2)}, partial city-trade refusals ${mean(focusPlayers.map((player) => player.partialCityTradesRefused)).toFixed(2)}, ` +
        `ore-on-dev while short ${mean(focusPlayers.map((player) => player.oreSpentOnDevsWhileShort)).toFixed(2)}, ore pips ${mean(focusPlayers.map((player) => player.production.ore)).toFixed(2)}`
    );
    if (raceDecisions > 0) lines.push(`  race-aware vs distance-only action disagreements ${raceDisagreements}/${raceDecisions}`);
    for (const game of games) {
      const focus = game.players.find((player) => player.id === game.focusPlayerId);
      if (!focus) continue;
      lines.push(
        `  ${game.seed} ${game.focusPlayerId} ${game.completed ? "done" : game.status} VP ${focus.vp} cities ${focus.cities} settlements ${focus.settlements} devs ${focus.devsBought} ore-on-dev ${focus.oreSpentOnDevsWhileShort} partial ${focus.partialCityTradesRefused} ore pips ${focus.production.ore} final O${focus.finalHand.ore} G${focus.finalHand.grain}`
      );
    }
    lines.push(`  resource conservation failures ${games.filter((game) => !game.resourceConserved).length}, replay failures ${games.filter((game) => !game.replayOk).length}, VP mismatches ${games.reduce((sum, game) => sum + game.players.filter((player) => !player.consistentVp).length, 0)}`);
  }
  const details: GameDiagnostic[] = [];
  for (const games of groups.values()) {
    const ranked = [...games].sort((a, b) => {
      const av = a.players.find((player) => player.id === a.focusPlayerId)?.vp ?? 0;
      const bv = b.players.find((player) => player.id === b.focusPlayerId)?.vp ?? 0;
      return av - bv;
    });
    details.push(...ranked.filter((game) => !game.completed).slice(0, 2));
  }
  lines.push("");
  lines.push("Lowest-VP cutoff examples:");
  for (const game of details) lines.push(...formatGame(game));
  return lines.join("\n");
}

export interface CityTradeComparison {
  readonly label: string;
  readonly seeds: number;
  readonly games: number;
  readonly completedGames: number;
  readonly completedPairs: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly cutoffs: number;
  readonly failures: number;
  readonly meanTurns: number | null;
  readonly meanFocusVp: number | null;
  readonly meanVpMargin: number | null;
  readonly meanCities: number | null;
  readonly meanSettlements: number | null;
  readonly pairInterval: { n: number; mean: number | null; low: number | null; high: number | null };
}

function cityPieces(trial: CrossPlayTrial): { cities: number; settlements: number } {
  return { cities: trial.focusCities, settlements: trial.focusSettlements };
}

export function compareCityTradeCorrection(seeds: readonly string[], label: string): CityTradeComparison {
  const fixed = createHeuristicRolloutPolicy("baseline_partial_city_trade_v1", true, undefined, true);
  const strict = baselineRolloutPolicy;
  const trials: CrossPlayTrial[] = [];
  const pairScores: Array<number | null> = [];
  for (const seed of seeds) {
    const opening = buildGeneratedOpening(seed);
    const [c1, c2] = playBothSeats({
      topology: opening.topology,
      seed,
      focus: fixed,
      opponent: strict,
      victoryPointsToWin: PROGRESS_DIAG_PROTOCOL.victoryPointsToWin,
      maxTurns: PROGRESS_DIAG_PROTOCOL.maxTurns,
      maxActions: PROGRESS_DIAG_PROTOCOL.maxActions
    });
    trials.push(c1, c2);
    const score = (trial: CrossPlayTrial) => trial.completed ? (trial.outcome === "win" ? 1 : trial.outcome === "draw" ? 0.5 : 0) : null;
    const left = score(c1);
    const right = score(c2);
    pairScores.push(left === null || right === null ? null : (left + right) / 2);
  }
  const completed = trials.filter((trial) => trial.completed);
  const cutoffs = trials.filter((trial) => trial.status === "max_turns_reached" || trial.status === "max_actions_reached").length;
  const failures = trials.filter((trial) => !trial.completed && trial.status !== "max_turns_reached" && trial.status !== "max_actions_reached").length;
  const meanOf = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    label,
    seeds: seeds.length,
    games: trials.length,
    completedGames: completed.length,
    completedPairs: pairScores.filter((score) => score !== null).length,
    wins: completed.filter((trial) => trial.outcome === "win").length,
    losses: completed.filter((trial) => trial.outcome === "loss").length,
    draws: completed.filter((trial) => trial.outcome === "draw").length,
    cutoffs,
    failures,
    meanTurns: meanOf(completed.map((trial) => trial.turns)),
    meanFocusVp: meanOf(completed.map((trial) => trial.focusVp)),
    meanVpMargin: meanOf(completed.map((trial) => trial.vpMargin)),
    meanCities: meanOf(trials.map((trial) => cityPieces(trial).cities)),
    meanSettlements: meanOf(trials.map((trial) => cityPieces(trial).settlements)),
    pairInterval: bootstrapMean(pairScores.map((score) => (score === null ? null : score - 0.5)))
  };
}

export function formatCityTradeComparison(comparison: CityTradeComparison): string {
  const interval = comparison.pairInterval;
  const intervalText = interval.mean === null || interval.low === null || interval.high === null
    ? "no completed pairs"
    : `n=${interval.n}, mean ${interval.mean.toFixed(3)}, 95% [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
  return [
    `${comparison.label}: seeds ${comparison.seeds}, games ${comparison.games}, completed games ${comparison.completedGames}, completed pairs ${comparison.completedPairs}`,
    `  W${comparison.wins} L${comparison.losses} D${comparison.draws}, cutoffs ${comparison.cutoffs}, failures ${comparison.failures}`,
    `  completed turns ${comparison.meanTurns?.toFixed(1) ?? "n/a"}, focus VP ${comparison.meanFocusVp?.toFixed(2) ?? "n/a"}, VP margin ${comparison.meanVpMargin?.toFixed(2) ?? "n/a"}`,
    `  cities ${comparison.meanCities?.toFixed(2) ?? "n/a"} (all games), settlements ${comparison.meanSettlements?.toFixed(2) ?? "n/a"} (all games)`,
    `  fixed minus even pair score: ${intervalText}`,
    "  Focus is the partial city-trade policy. Opponent is the same heuristic with the old full-deficit city trade gate. Cutoffs are not wins or losses."
  ].join("\n");
}
