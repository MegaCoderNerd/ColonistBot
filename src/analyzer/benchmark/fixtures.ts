/**
 * Stage 3.5 â€” Deterministic synthetic benchmark fixtures.
 *
 * ADDITIVE / EVALUATION ONLY.
 *
 * These fixtures exist so the tactical suite and the budget sweep always have runnable positions,
 * even when the recording dataset is unavailable. They are built on a validated standard 19-hex
 * topology via `createInitialConcreteState` and then hand-edited, so every rule check comes from
 * the real engine rather than from this module.
 *
 * Each fixture is declared with the invariant it is designed to expose. When the recording dataset
 * IS available, the harness still runs these cases and reports them alongside recorded positions,
 * clearly labelling which positions are synthetic.
 */

import type { BoardTopology } from "../engine/topology";
import { createInitialConcreteState } from "../engine/transition";
import type { ConcreteSimulatedGameState, ObservedGameState } from "../engine/state";
import { cloneConcreteState, recomputePlayerVp } from "./positions";
import { positionFromConcreteState } from "./positions";
import type { BenchmarkPosition } from "./types";

const SELF = "c1";
const OPP = "c2";

function emptyHand() {
  return { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
}

/**
 * Creates a validated empty 1v1 concrete state on the given topology.
 * Throws if the engine rejects the configuration, so a broken fixture can never pass silently.
 */
export function createBaseState(topology: BoardTopology): ConcreteSimulatedGameState {
  const res = createInitialConcreteState({
    topology,
    playerIds: [SELF, OPP],
    rules: {
      victoryPointsToWin: 15,
      cardDiscardLimit: 9,
      friendlyRobber: false,
      diceMode: "balanced"
    }
  });
  if (!res.ok) {
    throw new Error(`Stage 3.5 fixture base state rejected by engine: ${res.error.message}`);
  }
  return res.state;
}

/** Puts a state into a normal `main`-phase turn for `actorId`. */
function enterMainTurn(state: ConcreteSimulatedGameState, actorId: string, completedTurns: number): void {
  state.phase = "main";
  state.completedTurns = completedTurns;
  state.turnPlayerIndex = state.players.findIndex((p) => p.id === actorId);
  state.dice = { thrown: true, d1: 4, d2: 5, total: 9 };
  state.winnerId = undefined;
}

function resetBoard(state: ConcreteSimulatedGameState): void {
  state.cornerOwner.fill(null);
  state.cornerPiece.fill(0);
  state.edgeOwner.fill(null);
}

function setSettlement(state: ConcreteSimulatedGameState, cornerIndex: number, owner: string): void {
  state.cornerOwner[cornerIndex] = owner;
  state.cornerPiece[cornerIndex] = 1;
}

/** Standard dev deck counts used by the engine, for conservation when hand-editing. */
const STANDARD_DEV_DECK = {
  knight: 14,
  victoryPoint: 13,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2
} as const;

function fullBankDevDeck(): ConcreteSimulatedGameState["devDeckOrder"] {
  const order: ConcreteSimulatedGameState["devDeckOrder"] = [];
  for (const [kind, count] of Object.entries(STANDARD_DEV_DECK)) {
    for (let i = 0; i < count; i++) {
      order.push(kind as ConcreteSimulatedGameState["devDeckOrder"][number]);
    }
  }
  return order;
}

/**
 * Immediate-win fixture: the actor holds 14 VP (1 visible settlement + 13 VP devs) and can afford
 * a city upgrade, which reaches 15 and ends the game.
 *
 * Invariant exposed: a policy must take the legal winning action instead of e.g. buying a dev card.
 */
export function buildImmediateWinByCity(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  setSettlement(state, 0, SELF);
  setSettlement(state, 10, OPP);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 4;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.vpDevs = 13;
  self.visibleVp = 1;
  self.observedConfirmedVp = 14;
  self.actualSimulatedVp = 14;
  self.hand = { lumber: 2, brick: 2, wool: 1, grain: 3, ore: 3 };
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 4;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.vpDevs = 0;
  opp.visibleVp = 1;
  opp.observedConfirmedVp = 1;
  opp.actualSimulatedVp = 1;
  opp.hand = emptyHand();
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 17, brick: 17, wool: 18, grain: 16, ore: 16 };
  state.devDeckOrder = fullBankDevDeck();
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  enterMainTurn(state, SELF, 40);
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:immediate_win_by_city",
    groupId: "synthetic:immediate_win_by_city",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/**
 * No-immediate-win fixture: the actor is close to winning but every legal action still leaves the
 * game unfinished (e.g. a VP dev in hand is not yet revealed as a win, and no build reaches 15).
 *
 * Invariant exposed: the evaluator must not report an immediate win when none exists.
 */
export function buildNoImmediateWinAvailable(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  setSettlement(state, 0, SELF);
  setSettlement(state, 10, OPP);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 4;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.vpDevs = 0;
  self.visibleVp = 1;
  self.observedConfirmedVp = 1;
  self.actualSimulatedVp = 1;
  // Enough for a settlement but not enough resources to matter; no city corner upgradable to win.
  self.hand = { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 };
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 4;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.vpDevs = 0;
  opp.visibleVp = 1;
  opp.observedConfirmedVp = 1;
  opp.actualSimulatedVp = 1;
  opp.hand = emptyHand();
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 18, brick: 18, wool: 17, grain: 18, ore: 19 };
  state.devDeckOrder = fullBankDevDeck();
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  enterMainTurn(state, SELF, 30);
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:no_immediate_win_available",
    groupId: "synthetic:no_immediate_win_available",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/**
 * Insufficient-resources fixture: the actor has an empty hand and no legal build at all.
 *
 * Invariant exposed: the policy must choose from the legal set only and must not attempt a build.
 */
export function buildInsufficientResources(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  setSettlement(state, 0, SELF);
  setSettlement(state, 10, OPP);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 4;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.hand = emptyHand();
  self.visibleVp = 1;
  self.observedConfirmedVp = 1;
  self.actualSimulatedVp = 1;
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 4;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.hand = emptyHand();
  opp.visibleVp = 1;
  opp.observedConfirmedVp = 1;
  opp.actualSimulatedVp = 1;
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 19, brick: 19, wool: 19, grain: 19, ore: 19 };
  state.devDeckOrder = [];
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  enterMainTurn(state, SELF, 25);
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:insufficient_resources",
    groupId: "synthetic:insufficient_resources",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}


/**
 * Forced-discard fixture: the actor holds 10 cards with a discard limit of 9, so it must discard
 * exactly 5 before continuing.
 *
 * Invariant exposed: the discard phase must be respected and the count must be exact.
 */
export function buildForcedDiscard(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  setSettlement(state, 0, SELF);
  setSettlement(state, 10, OPP);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 4;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.hand = { lumber: 3, brick: 2, wool: 2, grain: 2, ore: 1 };
  self.pendingDiscardCount = 5;
  self.visibleVp = 1;
  self.observedConfirmedVp = 1;
  self.actualSimulatedVp = 1;
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 4;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.hand = { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 0 };
  opp.visibleVp = 1;
  opp.observedConfirmedVp = 1;
  opp.actualSimulatedVp = 1;
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 16, brick: 18, wool: 18, grain: 18, ore: 19 };
  state.devDeckOrder = fullBankDevDeck();
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  state.phase = "discard";
  state.completedTurns = 35;
  state.turnPlayerIndex = state.players.findIndex((p) => p.id === SELF);
  state.dice = { thrown: true, d1: 3, d2: 4, total: 7 };
  state.winnerId = undefined;
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:forced_discard",
    groupId: "synthetic:forced_discard",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/**
 * Robber-blocks-self fixture: the robber sits on a hex producing for the actor, who holds a Knight.
 *
 * Invariant exposed: the actor should spend the Knight to unblock its own production rather than
 * ignoring a self-inflicted production block.
 */
export function buildRobberBlocksSelfWithKnight(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);

  // Place the actor on a corner of hex 0, then move the robber onto that same hex.
  const targetHexIndex = 0;
  const hex = state.topology.hexes[targetHexIndex];
  for (const ci of hex.cornerIndices.slice(0, 1)) setSettlement(state, ci, SELF);
  const oppCorner = state.topology.corners.findIndex(
    (c) => !c.hexIndices.includes(targetHexIndex)
  );
  if (oppCorner >= 0) setSettlement(state, oppCorner, OPP);
  state.robberHexIndex = targetHexIndex;

  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 4;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.hand = { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 };
  self.readyDevs = ["knight"];
  self.knightsPlayed = 0;
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 4;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.hand = emptyHand();
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 19, brick: 19, wool: 17, grain: 18, ore: 18 };
  state.devDeckOrder = fullBankDevDeck().slice(0, 24);
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  enterMainTurn(state, SELF, 28);
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:robber_blocks_self_with_knight",
    groupId: "synthetic:robber_blocks_self_with_knight",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/**
 * Open-ended midgame fixture: a normal position with resources, spare pieces and several
 * reasonable actions. Used for informational coverage and for the budget stability sweep.
 *
 * No tactical claim is made about this position.
 */
export function buildOpenEndedMidgame(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  setSettlement(state, 0, SELF);
  setSettlement(state, 4, SELF);
  setSettlement(state, 10, OPP);
  setSettlement(state, 14, OPP);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 3;
  self.citiesLeft = 4;
  self.roadsLeft = 13;
  self.roadLength = 4;
  self.hand = { lumber: 2, brick: 2, wool: 1, grain: 2, ore: 1 };
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 3;
  opp.citiesLeft = 4;
  opp.roadsLeft = 13;
  opp.roadLength = 3;
  opp.hand = { lumber: 1, brick: 1, wool: 0, grain: 1, ore: 1 };
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 16, brick: 16, wool: 18, grain: 16, ore: 17 };
  state.devDeckOrder = fullBankDevDeck().slice(0, 20);
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  enterMainTurn(state, SELF, 32);
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:open_ended_midgame",
    groupId: "synthetic:open_ended_midgame",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/**
 * Multiple-valid-placements fixture: a setup position with several comparable corners.
 * Reported as `multiple_valid_choices`; no tactical assertion is made.
 */
export function buildMultipleValidPlacements(
  topology: BoardTopology,
  observed: ObservedGameState
): BenchmarkPosition {
  const state = createBaseState(topology);
  resetBoard(state);
  const self = state.players.find((p) => p.id === SELF)!;
  const opp = state.players.find((p) => p.id === OPP)!;

  self.settlementsLeft = 5;
  self.citiesLeft = 4;
  self.roadsLeft = 15;
  self.hand = emptyHand();
  self.readyDevs = [];
  self.boughtDevsThisTurn = [];
  self.playedDevs = [];

  opp.settlementsLeft = 5;
  opp.citiesLeft = 4;
  opp.roadsLeft = 15;
  opp.hand = emptyHand();
  opp.readyDevs = [];
  opp.boughtDevsThisTurn = [];
  opp.playedDevs = [];

  state.bank = { lumber: 19, brick: 19, wool: 19, grain: 19, ore: 19 };
  state.devDeckOrder = fullBankDevDeck();
  state.rules.devDeckComposition = { ...STANDARD_DEV_DECK };
  state.phase = "setup_settlement";
  state.completedTurns = 0;
  state.turnPlayerIndex = 0;
  state.dice = { thrown: false };
  state.winnerId = undefined;
  recomputePlayerVp(state);

  return positionFromConcreteState({
    positionId: "synthetic:multiple_valid_placements",
    groupId: "synthetic:multiple_valid_placements",
    source: "synthetic",
    selfId: SELF,
    concrete: state,
    observed
  });
}

/** Builds every synthetic fixture, keyed for the tactical suite. */
export function buildAllSyntheticFixtures(
  topology: BoardTopology,
  observed: ObservedGameState
): {
  immediateWinByCity: BenchmarkPosition;
  noImmediateWinAvailable: BenchmarkPosition;
  insufficientResources: BenchmarkPosition;
  forcedDiscard: BenchmarkPosition;
  robberBlocksSelfWithKnight: BenchmarkPosition;
  multipleValidPlacements: BenchmarkPosition;
  openEndedMidgame: BenchmarkPosition;
} {
  return {
    immediateWinByCity: buildImmediateWinByCity(topology, observed),
    noImmediateWinAvailable: buildNoImmediateWinAvailable(topology, observed),
    insufficientResources: buildInsufficientResources(topology, observed),
    forcedDiscard: buildForcedDiscard(topology, observed),
    robberBlocksSelfWithKnight: buildRobberBlocksSelfWithKnight(topology, observed),
    multipleValidPlacements: buildMultipleValidPlacements(topology, observed),
    openEndedMidgame: buildOpenEndedMidgame(topology, observed)
  };
}

/** Re-exported so callers can clone fixtures without mutating shared state. */
export { cloneConcreteState };

