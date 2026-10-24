/**
 * Candidate-specific road expansion features.
 *
 * These are public board facts. They do not read hands, hidden development
 * cards, the dev deck, future dice, or the teacher action.
 *
 * reach 0 after a road means one endpoint is empty and the distance rule is
 * satisfied. It does not mean a settlement is affordable, and it does not mean
 * the player still has a settlement piece. reach 99 means nothing within 3 roads.
 */

import type { ConcreteSimulatedGameState } from "../engine/state";
import { isDistanceOpenCorner, minAdditionalRoadsToOpenSettlementFromEdge, settlementReachFromNetwork } from "../engine/rollout";
import { roadConnectsToOwnNetwork } from "../engine/transition";
import type { SimulatedAction } from "../engine/transition";

export const ROAD_EXPANSION_ACTIONS = new Set(["buildRoad", "placeFreeRoad", "placeSetupRoad"]);

export interface RoadExpansion {
  readonly reach_before: number;
  readonly reach_after: number;
  readonly reach_delta: number;
  readonly reach_before_known: number;
  readonly reach_after_known: number;
  readonly opens_settlement: number;
  readonly newly_opened: number;
  readonly connects_network: number;
}

export function emptyRoadExpansion(): RoadExpansion {
  return {
    reach_before: 0,
    reach_after: 0,
    reach_delta: 0,
    reach_before_known: 0,
    reach_after_known: 0,
    opens_settlement: 0,
    newly_opened: 0,
    connects_network: 0
  };
}

function newlyOpened(state: ConcreteSimulatedGameState, playerId: string, edgeIndex: number): number {
  const edge = state.topology.edges[edgeIndex];
  if (!edge) return 0;
  let count = 0;
  for (const corner of [edge.c1, edge.c2]) {
    if (!isDistanceOpenCorner(state, corner)) continue;
    const already = state.topology.corners[corner].incidentEdgeIndices.some((incident) => state.edgeOwner[incident] === playerId);
    if (!already) count += 1;
  }
  return count;
}

export function roadExpansionForEdge(state: ConcreteSimulatedGameState, playerId: string, edgeIndex: number): RoadExpansion {
  const before = settlementReachFromNetwork(state, playerId, 3);
  const after = minAdditionalRoadsToOpenSettlementFromEdge(state, playerId, edgeIndex, 3).dist;
  const beforeKnown = before <= 3 ? 1 : 0;
  const afterKnown = after <= 3 ? 1 : 0;
  const opened = newlyOpened(state, playerId, edgeIndex);
  return {
    reach_before: beforeKnown ? before : 99,
    reach_after: afterKnown ? after : 99,
    reach_delta: beforeKnown && afterKnown ? before - after : 0,
    reach_before_known: beforeKnown,
    reach_after_known: afterKnown,
    opens_settlement: opened > 0 ? 1 : 0,
    newly_opened: opened,
    connects_network: roadConnectsToOwnNetwork(state, playerId, edgeIndex) ? 1 : 0
  };
}

export function roadExpansionForAction(state: ConcreteSimulatedGameState, playerId: string, action: SimulatedAction): RoadExpansion {
  if (!ROAD_EXPANSION_ACTIONS.has(action.type) || !("edgeIndex" in action) || typeof action.edgeIndex !== "number") {
    return emptyRoadExpansion();
  }
  return roadExpansionForEdge(state, playerId, action.edgeIndex);
}
