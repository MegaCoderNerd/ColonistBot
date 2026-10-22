import { RESOURCES, type ResourceBag, type ResourceHand } from "../types";

/**
 * Settlement-race evaluator. Callers pass observed roads, public production, and only
 * the cards they actually know. Unknown cards stay a count: they are never assigned
 * to a resource.
 */
export const RACE_EVALUATOR_ID = "settlement_race_v1";

/**
 * Score offsets applied after the race is judged.
 * `portIncrement` is recorded on the assessment and is not added to `adjustment`.
 * Spot and edge scorers already apply harbor value once.
 */
export interface RaceWeights {
  readonly lostPenalty: number;
  readonly uncertainPenalty: number;
  readonly urgentBonus: number;
}

export const DEFAULT_RACE_WEIGHTS: RaceWeights = {
  lostPenalty: 12,
  uncertainPenalty: 1.5,
  urgentBonus: 1.5
};

/** Reported for an improving harbor. No current scorer adds this number. */
export const RACE_PORT_INCREMENT = 1.6;

export interface RaceQuery {
  /** Additional roads the player still has to build. Owned edges are already zero. */
  myRoads: number;
  opponentRoads?: number;
  myProduction: ResourceHand;
  opponentProduction: ResourceHand;
  /** Present only when the player's cards are known. Omitted means unknown, not empty. */
  myHand?: ResourceBag;
  /** Counted opponent cards. Omitted means those cards were not observed. */
  opponentKnown?: ResourceBag;
  /** Cards in the opponent's hand whose resources are not known. */
  opponentUnknown?: number;
  myRates?: ResourceBag;
  opponentRates?: ResourceBag;
  /** True only when this harbor lowers a rate the player does not already have. */
  portImproves?: boolean;
  /** True when this road has no second legal settlement. */
  soleAccess?: boolean;
  /** True on the acting player's turn. Equal finish times then go to that player. */
  weActFirst?: boolean;
  myRoadsLeft?: number;
  opponentRoadsLeft?: number;
  /** Omitted weights are the live-coach defaults. */
  weights?: RaceWeights;
}

export type RaceCertainty = "known" | "production" | "uncertain" | "none";

export interface RaceAssessment {
  evaluatorId: typeof RACE_EVALUATOR_ID;
  myRoads: number;
  opponentRoads: number | undefined;
  myTurns: number;
  opponentTurns: number | undefined;
  lost: boolean;
  opponentCanContest: boolean;
  possibleThreat: boolean;
  urgent: boolean;
  deadEnd: boolean;
  choke: boolean;
  certainty: RaceCertainty;
  /** Harbor value counted once. Callers that already scored the harbor in `scoreSpot` must not add this again. */
  incrementalPort: number;
  adjustment: number;
  reason: string;
}

const emptyHand = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });

function filled(partial?: ResourceBag): ResourceHand {
  const hand = emptyHand();
  if (!partial) return hand;
  for (const resource of RESOURCES) hand[resource] = partial[resource] ?? 0;
  return hand;
}

function ratesOf(partial?: ResourceBag): ResourceHand {
  const rates = { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 };
  if (!partial) return rates;
  for (const resource of RESOURCES) {
    const quoted = partial[resource];
    if (quoted === 2 || quoted === 3 || quoted === 4) rates[resource] = quoted;
  }
  return rates;
}

/** Roads plus the settlement that actually takes the vertex. */
export function raceCost(roads: number): ResourceHand {
  return {
    lumber: Math.max(0, roads) + 1,
    brick: Math.max(0, roads) + 1,
    wool: 1,
    grain: 1,
    ore: 0
  };
}

function afterTrades(hand: ResourceHand, rates: ResourceHand, need: ResourceHand): ResourceHand {
  const have = { ...hand };
  for (let n = 0; n < 12; n++) {
    const want = RESOURCES.find((resource) => have[resource] < need[resource]);
    if (!want) break;
    const give = RESOURCES.filter((resource) => resource !== want && have[resource] >= rates[resource] && have[resource] - rates[resource] >= need[resource]).sort(
      (a, b) => have[b] - have[a]
    )[0];
    if (!give) break;
    have[give] -= rates[give];
    have[want] += 1;
  }
  return have;
}

function missingCards(hand: ResourceHand, rates: ResourceHand, roads: number): number {
  const need = raceCost(roads);
  const have = afterTrades(hand, rates, need);
  return RESOURCES.reduce((sum, resource) => sum + Math.max(0, need[resource] - have[resource]), 0);
}

/**
 * Expected turns until the roads and the settlement can be paid.
 * Production pips are ways out of 36. Cards already in hand make this zero.
 * Returns Infinity when a missing resource is neither held nor produced.
 */
export function finishTurns(roads: number, hand: ResourceHand, production: ResourceHand, rates: ResourceHand): number {
  if (!Number.isFinite(roads) || roads < 0) return Infinity;
  const need = raceCost(roads);
  const have = afterTrades(hand, rates, need);
  let turns = 0;
  for (const resource of RESOURCES) {
    const missing = Math.max(0, need[resource] - have[resource]);
    if (missing === 0) continue;
    const pace = production[resource];
    if (pace <= 0) return Infinity;
    turns = Math.max(turns, (missing * 36) / pace);
  }
  return turns;
}

export function assessSettlementRace(input: RaceQuery): RaceAssessment {
  const myRates = ratesOf(input.myRates);
  const opponentRates = ratesOf(input.opponentRates);
  const myHandKnown = input.myHand !== undefined;
  const myHand = filled(input.myHand);
  const cardsSpecified = input.opponentKnown !== undefined || input.opponentUnknown !== undefined;
  const opponentKnown = filled(input.opponentKnown);
  const unknown = Math.max(0, input.opponentUnknown ?? 0);
  const fullyKnown = cardsSpecified && unknown === 0;
  const weActFirst = input.weActFirst !== false;
  const weights = input.weights ?? DEFAULT_RACE_WEIGHTS;
  const incrementalPort = input.portImproves ? RACE_PORT_INCREMENT : 0;

  let myTurns = myHandKnown ? finishTurns(input.myRoads, myHand, input.myProduction, myRates) : input.myRoads;
  if (input.myRoadsLeft !== undefined && input.myRoadsLeft < input.myRoads) myTurns = Infinity;

  const opponentRoads = input.opponentRoads;
  const supplyBlocks =
    opponentRoads === undefined || (input.opponentRoadsLeft !== undefined && input.opponentRoadsLeft < opponentRoads);
  let opponentTurns: number | undefined;
  let certainty: RaceCertainty = "none";
  let possibleThreat = false;
  let opponentCanContest = false;

  if (!supplyBlocks && opponentRoads !== undefined) {
    const pace = finishTurns(opponentRoads, opponentKnown, input.opponentProduction, opponentRates);
    const missing = missingCards(opponentKnown, opponentRates, opponentRoads);
    opponentTurns = pace;
    if (fullyKnown || !cardsSpecified) {
      opponentCanContest = Number.isFinite(pace);
      certainty = fullyKnown ? "known" : Number.isFinite(pace) ? "production" : "none";
      if (!fullyKnown && !opponentCanContest && opponentRoads < input.myRoads) {
        possibleThreat = true;
        certainty = "uncertain";
      }
    } else if (Number.isFinite(pace)) {
      opponentCanContest = true;
      certainty = "production";
    } else if (unknown >= missing && missing > 0) {
      possibleThreat = true;
      certainty = "uncertain";
    }
  }

  const theyFinishFirst =
    opponentTurns !== undefined &&
    Number.isFinite(opponentTurns) &&
    (opponentTurns < myTurns || (!weActFirst && opponentTurns === myTurns));
  const lost = Boolean(myHandKnown && opponentCanContest && theyFinishFirst);
  const urgent = Boolean(myHandKnown && !lost && opponentCanContest && opponentTurns !== undefined && myTurns < opponentTurns);
  const choke = Boolean(input.soleAccess && (opponentCanContest || possibleThreat));
  const deadEnd = Boolean(input.soleAccess && (lost || (myHandKnown && !Number.isFinite(myTurns))));

  let adjustment = 0;
  if (lost) adjustment -= weights.lostPenalty;
  else if (possibleThreat) adjustment -= weights.uncertainPenalty;
  else if (urgent) adjustment += weights.urgentBonus;

  let reason = "No one else can take this settlement first.";
  if (lost) reason = "He can pay for that settlement before you can.";
  else if (possibleThreat) reason = "He is closer, but his hidden cards are not a known road.";
  else if (urgent) reason = "Your wood and brick reach it before he does.";
  else if (opponentRoads !== undefined && opponentRoads < input.myRoads && !opponentCanContest) reason = "He is closer, and he cannot pay for the block.";
  if (deadEnd) reason = "This road ends on a settlement you do not win.";
  else if (choke && !lost) reason = "Taking it blocks his only approach.";

  return {
    evaluatorId: RACE_EVALUATOR_ID,
    myRoads: input.myRoads,
    opponentRoads,
    myTurns,
    opponentTurns,
    lost,
    opponentCanContest,
    possibleThreat,
    urgent,
    deadEnd,
    choke,
    certainty,
    incrementalPort,
    adjustment,
    reason
  };
}

/** A route is a dead end when every settlement it can reach is a known loss or cannot be paid for. */
export function routeIsDeadEnd(races: readonly Pick<RaceAssessment, "lost" | "myTurns">[]): boolean {
  if (races.length === 0) return true;
  return races.every((race) => race.lost || !Number.isFinite(race.myTurns));
}
