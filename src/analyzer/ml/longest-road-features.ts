/**
 * Public longest-road features for colonist_features_v7.
 *
 * Existing v4 and v6 fields stay in front of these numbers. A non-road
 * candidate is all zeros. Roads, free roads, and setup roads share one
 * hypothetical placement. The live board is not modified.
 *
 * Lengths use computeRoadLengthOnTopology. The award uses the same rule as
 * updateLongestRoadAward: minimum 5, the incumbent keeps a tie, and a tie
 * among challengers leaves the award unclaimed.
 *
 * Candidate encoding, in order, after the v6 expansion block:
 *   road_length_now / 15
 *   road_length_after / 15
 *   road_length_delta / 15
 *   longest_road_gain       1 when the actor takes the award
 *   longest_road_retain     1 when the actor already holds it and still does
 *   longest_road_lose       1 when the actor holds it and this road would drop it
 *   longest_road_otherwise  1 when the actor does not hold it before or after
 * Exactly one of the four flags is 1 on a road. They are 0 on every other action.
 *
 * The summary vector appends actor road_length / 15 and has_longest_road.
 * Those two facts are public and stay on the actor when the board is omitted.
 */

import type { ConcreteSimulatedGameState } from "../engine/state";
import { computeRoadLengthOnTopology } from "../engine/state";
import type { SimulatedAction } from "../engine/transition";

export const LONGEST_ROAD_ACTIONS = new Set(["buildRoad", "placeFreeRoad", "placeSetupRoad"]);
export const LONGEST_ROAD_MIN = 5;
export const LONGEST_ROAD_CANDIDATE_FIELDS = [
  "road_length_now",
  "road_length_after",
  "road_length_delta",
  "longest_road_gain",
  "longest_road_retain",
  "longest_road_lose",
  "longest_road_otherwise"
] as const;

export interface LongestRoadFeatures {
  readonly road_length_now: number;
  readonly road_length_after: number;
  readonly road_length_delta: number;
  readonly longest_road_gain: number;
  readonly longest_road_retain: number;
  readonly longest_road_lose: number;
  readonly longest_road_otherwise: number;
}

export function emptyLongestRoadFeatures(): LongestRoadFeatures {
  return {
    road_length_now: 0,
    road_length_after: 0,
    road_length_delta: 0,
    longest_road_gain: 0,
    longest_road_retain: 0,
    longest_road_lose: 0,
    longest_road_otherwise: 0
  };
}

export function longestRoadHolder(lengths: ReadonlyMap<string, number>, incumbentId: string | null): string | null {
  let maxLen = 0;
  for (const length of lengths.values()) if (length > maxLen) maxLen = length;
  if (maxLen < LONGEST_ROAD_MIN) return null;
  if (incumbentId && lengths.get(incumbentId) === maxLen) return incumbentId;
  const leaders = [...lengths.entries()].filter(([, length]) => length === maxLen);
  return leaders.length === 1 ? leaders[0][0] : null;
}

function lengthsWithEdge(state: ConcreteSimulatedGameState, playerId: string, edgeIndex: number | null): Map<string, number> {
  const edgeOwner = state.edgeOwner.slice();
  if (edgeIndex !== null) edgeOwner[edgeIndex] = playerId;
  const lengths = new Map<string, number>();
  for (const player of state.players) {
    lengths.set(player.id, computeRoadLengthOnTopology(state.topology, state.cornerOwner, edgeOwner, player.id));
  }
  return lengths;
}

export function longestRoadFeaturesForEdge(state: ConcreteSimulatedGameState, playerId: string, edgeIndex: number): LongestRoadFeatures {
  const before = lengthsWithEdge(state, playerId, null);
  const after = lengthsWithEdge(state, playerId, edgeIndex);
  const incumbent = state.players.find((player) => player.hasLongestRoad)?.id ?? null;
  const beforeHolder = longestRoadHolder(before, incumbent);
  const afterHolder = longestRoadHolder(after, incumbent);
  const now = before.get(playerId) ?? 0;
  const next = after.get(playerId) ?? 0;
  const had = beforeHolder === playerId;
  const has = afterHolder === playerId;
  return {
    road_length_now: now,
    road_length_after: next,
    road_length_delta: next - now,
    longest_road_gain: !had && has ? 1 : 0,
    longest_road_retain: had && has ? 1 : 0,
    longest_road_lose: had && !has ? 1 : 0,
    longest_road_otherwise: !had && !has ? 1 : 0
  };
}

export function longestRoadFeaturesForAction(state: ConcreteSimulatedGameState, playerId: string, action: SimulatedAction): LongestRoadFeatures {
  if (!LONGEST_ROAD_ACTIONS.has(action.type) || !("edgeIndex" in action) || typeof action.edgeIndex !== "number") {
    return emptyLongestRoadFeatures();
  }
  return longestRoadFeaturesForEdge(state, playerId, action.edgeIndex);
}
