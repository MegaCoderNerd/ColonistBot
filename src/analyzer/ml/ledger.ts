/**
 * Resource ledger for the offline learner.
 *
 * This is the live coach's HandTracker, fed only with events the coach can
 * read in a Colonist log: production, costs, bank trades, discards, named
 * steals, Year of Plenty, and Monopoly totals. It does not read opponent
 * hands or the simulator bank. When every player's count is exact, the bank
 * is 19 minus those holdings, the same derivation the observed-state builder
 * uses. A missed or unnamed transfer leaves the count inexact and the bank
 * unknown. Known cards already counted are kept; they are not replaced with
 * a guess and they are not filled in from the simulator.
 */

import { HandTracker, emptyHand, handTotal } from "../tracker";
import { BANK_RESOURCE_CAP } from "../engine/state";
import type { ConcreteSimulatedGameState } from "../engine/state";
import type { ActionOutcome, SimulatedAction } from "../engine/transition";
import { RESOURCES, type GameEvent, type GameEventDraft, type Resource, type ResourceBag, type ResourceHand } from "../types";

export interface TrackedResources {
  readonly lumber: number;
  readonly brick: number;
  readonly wool: number;
  readonly grain: number;
  readonly ore: number;
  readonly unknown: number;
  readonly exact: boolean;
}

export interface ResourceSnapshot {
  readonly hands: Readonly<Record<string, TrackedResources>>;
  readonly bank: ResourceHand | null;
  readonly bank_exact: boolean;
  readonly bank_confidence: "derived_from_exact_hands" | "uncertain";
}

function draftEvent(draft: GameEventDraft): GameEvent {
  return { ...draft, t: 0, turn: 0 };
}

function bag(partial: ResourceBag): ResourceBag {
  const cards: ResourceBag = {};
  for (const resource of RESOURCES) {
    const count = partial[resource] ?? 0;
    if (count > 0) cards[resource] = count;
  }
  return cards;
}

/** Production the log would name. The bank argument is the ledger's own bank, not the simulator's. */
export function publicProduction(
  state: ConcreteSimulatedGameState,
  total: number,
  bank: ResourceHand | null
): Array<{ player: string; cards: ResourceBag }> {
  if (total === 7 || !bank) return [];
  const remaining = { ...bank };
  const gained = new Map<string, ResourceBag>();
  const matching = state.topology.hexIndicesByDiceNumber.get(total) ?? [];
  for (const resource of RESOURCES) {
    const owed = new Array<number>(state.players.length).fill(0);
    for (const hexIndex of matching) {
      if (hexIndex === state.robberHexIndex) continue;
      const hex = state.topology.hexes[hexIndex];
      if (hex.resource !== resource) continue;
      for (const cornerIndex of hex.cornerIndices) {
        const ownerId = state.cornerOwner[cornerIndex];
        if (!ownerId) continue;
        const playerIndex = state.players.findIndex((player) => player.id === ownerId);
        if (playerIndex < 0) continue;
        owed[playerIndex] += state.cornerPiece[cornerIndex] === 2 ? 2 : 1;
      }
    }
    const totalOwed = owed.reduce((sum, count) => sum + count, 0);
    if (totalOwed === 0) continue;
    const claimants = owed.map((count, playerIndex) => ({ playerIndex, count })).filter((row) => row.count > 0);
    const paid = new Array<number>(state.players.length).fill(0);
    if (totalOwed <= remaining[resource]) {
      for (let index = 0; index < owed.length; index++) paid[index] = owed[index];
      remaining[resource] -= totalOwed;
    } else if (claimants.length === 1) {
      paid[claimants[0].playerIndex] = remaining[resource];
      remaining[resource] = 0;
    }
    for (let index = 0; index < paid.length; index++) {
      if (paid[index] <= 0) continue;
      const playerId = state.players[index].id;
      const cards = gained.get(playerId) ?? {};
      cards[resource] = (cards[resource] ?? 0) + paid[index];
      gained.set(playerId, cards);
    }
  }
  return [...gained].map(([player, cards]) => ({ player, cards }));
}

export class PublicResourceLedger {
  readonly tracker = new HandTracker();
  /** Set when a transfer could not be named. Known counts stay; exactness does not. */
  uncertain = false;

  constructor(playerIds: readonly string[]) {
    for (const playerId of playerIds) this.tracker.ensure(playerId);
  }

  applyPublic(draft: GameEventDraft): void {
    this.tracker.apply(draftEvent(draft));
  }

  /** Marks the ledger inexact without inventing the missing cards. */
  markUncertain(): void {
    this.uncertain = true;
  }

  derivedBank(): ResourceHand | null {
    return this.snapshot({}).bank;
  }

  snapshot(publicSizes: Readonly<Record<string, number>>): ResourceSnapshot {
    const hands: Record<string, TrackedResources> = {};
    let allExact = !this.uncertain && this.tracker.names().length > 0;
    for (const playerId of this.tracker.names()) {
      const view = this.tracker.view(playerId);
      const tracked = this.tracker.players.get(playerId);
      const unknownLoss = tracked?.unknownLoss ?? 0;
      const publicSize = publicSizes[playerId];
      const sizeMatches = publicSize === undefined ? true : view.total === publicSize;
      const exact =
        !this.uncertain &&
        view.unknown === 0 &&
        unknownLoss === 0 &&
        view.warnings.length === 0 &&
        sizeMatches &&
        handTotal(view.hand) === view.total;
      if (!exact) allExact = false;
      hands[playerId] = {
        lumber: view.hand.lumber,
        brick: view.hand.brick,
        wool: view.hand.wool,
        grain: view.hand.grain,
        ore: view.hand.ore,
        unknown: view.unknown,
        exact
      };
    }
    if (!allExact) {
      return { hands, bank: null, bank_exact: false, bank_confidence: "uncertain" };
    }
    const bank = emptyHand();
    for (const resource of RESOURCES) {
      let held = 0;
      for (const hand of Object.values(hands)) held += hand[resource];
      if (held > BANK_RESOURCE_CAP) {
        return { hands, bank: null, bank_exact: false, bank_confidence: "uncertain" };
      }
      bank[resource] = BANK_RESOURCE_CAP - held;
    }
    return { hands, bank, bank_exact: true, bank_confidence: "derived_from_exact_hands" };
  }

  /**
   * Fold one applied action into the ledger.
   * `state` is the position before the action. Opponent hands and `state.bank` are not read.
   */
  record(state: ConcreteSimulatedGameState, actorId: string, action: SimulatedAction, outcome?: ActionOutcome): void {
    const bank = this.derivedBank();
    switch (action.type) {
      case "placeSetupSettlement": {
        this.applyPublic({ type: "build", player: actorId, piece: "settlement", setup: true });
        if (state.completedTurns < state.players.length || !bank) {
          if (state.completedTurns >= state.players.length && !bank) this.markUncertain();
          return;
        }
        const corner = state.topology.corners[action.cornerIndex];
        const cards: ResourceBag = {};
        const remaining = { ...bank };
        for (const hexIndex of corner?.hexIndices ?? []) {
          const resource = state.topology.hexes[hexIndex]?.resource;
          if (!resource || remaining[resource] <= 0) continue;
          cards[resource] = (cards[resource] ?? 0) + 1;
          remaining[resource] -= 1;
        }
        if (Object.keys(cards).length) this.applyPublic({ type: "gain", player: actorId, cards, source: "other" });
        return;
      }
      case "placeSetupRoad":
        this.applyPublic({ type: "build", player: actorId, piece: "road", setup: true });
        return;
      case "placeFreeRoad":
        this.applyPublic({ type: "build", player: actorId, piece: "road", setup: false, free: true });
        return;
      case "buildRoad":
        this.applyPublic({ type: "build", player: actorId, piece: "road", setup: false });
        return;
      case "buildSettlement":
        this.applyPublic({ type: "build", player: actorId, piece: "settlement", setup: false });
        return;
      case "buildCity":
        this.applyPublic({ type: "build", player: actorId, piece: "city", setup: false });
        return;
      case "buyDevCard":
        this.applyPublic({ type: "devBuy", player: actorId });
        return;
      case "rollDice": {
        const total = action.total ?? outcome?.dice?.total ?? ((action.d1 ?? 0) + (action.d2 ?? 0) || undefined);
        this.applyPublic({ type: "roll", ...(total !== undefined ? { total, player: actorId } : { total: 0, player: actorId }) });
        if (total === undefined || total === 7) return;
        if (!bank) {
          this.markUncertain();
          return;
        }
        for (const gain of publicProduction(state, total, bank)) {
          this.applyPublic({ type: "gain", player: gain.player, cards: gain.cards, source: "roll" });
        }
        return;
      }
      case "discard":
        this.applyPublic({ type: "discard", player: actorId, cards: bag(action.cards) });
        return;
      case "moveRobber": {
        this.applyPublic({ type: "robberMove", player: actorId });
        if (!action.victimId) return;
        if (outcome?.stolenResource) {
          this.applyPublic({ type: "steal", player: actorId, victim: action.victimId, card: outcome.stolenResource });
        } else {
          this.applyPublic({ type: "steal", player: actorId, victim: action.victimId });
        }
        return;
      }
      case "bankTrade": {
        const actor = state.players.find((player) => player.id === actorId);
        const receiveCount = action.receiveCount ?? 1;
        const rate = actor?.ratios[action.give] ?? 4;
        const giveCount = rate * receiveCount;
        this.applyPublic({
          type: "bankTrade",
          player: actorId,
          gave: { [action.give]: giveCount },
          got: { [action.receive]: receiveCount }
        });
        return;
      }
      case "playerTrade":
        this.applyPublic({
          type: "trade",
          player: actorId,
          partner: action.partnerId,
          gave: bag(action.give),
          got: bag(action.receive)
        });
        return;
      case "playYearOfPlenty": {
        if (!bank) {
          this.markUncertain();
          return;
        }
        const cards: ResourceBag = {};
        for (const resource of action.resources) cards[resource] = (cards[resource] ?? 0) + 1;
        this.applyPublic({ type: "gain", player: actorId, cards, source: "other" });
        return;
      }
      case "playMonopoly": {
        if (!bank) {
          this.markUncertain();
          return;
        }
        let taken = 0;
        for (const [playerId, hand] of Object.entries(this.snapshot({}).hands)) {
          if (playerId === actorId) continue;
          taken += hand[action.resource];
        }
        this.applyPublic({ type: "monopoly", player: actorId, cards: { [action.resource]: taken } });
        return;
      }
      case "playKnight":
      case "playRoadBuilding":
      case "endTurn":
        return;
      default:
        this.markUncertain();
    }
  }
}
