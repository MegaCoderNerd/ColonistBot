import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { createInitialConcreteState, updateLongestRoadAward, type SimulatedAction } from "../src/analyzer/engine/transition";
import type { ConcreteSimulatedGameState } from "../src/analyzer/engine/state";
import { longestRoadFeaturesForAction, longestRoadFeaturesForEdge, longestRoadHolder } from "../src/analyzer/ml/longest-road-features";
import { PublicResourceLedger } from "../src/analyzer/ml/ledger";
import { observationLeaks, toObservation, wireObservation } from "../src/analyzer/ml/observation";

function pathFrom(state: ConcreteSimulatedGameState, count: number, forbidden: ReadonlySet<number>): { edges: number[]; corners: number[] } {
  for (let start = 0; start < state.topology.corners.length; start++) {
    const edges: number[] = [];
    const corners = [start];
    const used = new Set<number>(forbidden);
    const seenCorners = new Set<number>([start]);
    let corner = start;
    while (edges.length < count) {
      const nextEdge = state.topology.corners[corner].incidentEdgeIndices.find((edge) => {
        if (used.has(edge)) return false;
        const item = state.topology.edges[edge];
        const next = item.c1 === corner ? item.c2 : item.c1;
        return !seenCorners.has(next);
      });
      if (nextEdge === undefined) break;
      used.add(nextEdge);
      const item = state.topology.edges[nextEdge];
      const next = item.c1 === corner ? item.c2 : item.c1;
      edges.push(nextEdge);
      corners.push(next);
      seenCorners.add(next);
      corner = next;
    }
    if (edges.length === count) return { edges, corners };
  }
  throw new Error(`no ${count}-edge path`);
}

function own(state: ConcreteSimulatedGameState, playerId: string, edges: readonly number[]): void {
  for (const edge of edges) state.edgeOwner[edge] = playerId;
}

function fingerprint(state: ConcreteSimulatedGameState): string {
  return JSON.stringify({
    edges: state.edgeOwner,
    corners: state.cornerOwner,
    pieces: Array.from(state.cornerPiece),
    roads: state.players.map((player) => [player.id, player.roadLength, player.hasLongestRoad])
  });
}

describe("longest road features", () => {
  const opened = createInitialConcreteState({
    topology: buildGeneratedOpening("ml-v7-feature-probe").topology,
    playerIds: ["c1", "c2"]
  });
  if (!opened.ok) throw new Error(opened.error.message);

  it("keeps the pure award rule for ties, thresholds, and a broken incumbent", () => {
    expect(longestRoadHolder(new Map([["c1", 4], ["c2", 4]]), "c1")).toBeNull();
    expect(longestRoadHolder(new Map([["c1", 5], ["c2", 5]]), "c1")).toBe("c1");
    expect(longestRoadHolder(new Map([["c1", 5], ["c2", 5]]), null)).toBeNull();
    expect(longestRoadHolder(new Map([["c1", 6], ["c2", 5]]), "c2")).toBe("c1");
    expect(longestRoadHolder(new Map([["c1", 3], ["c2", 6]]), "c1")).toBe("c2");
  });

  it("stamps gain, retain, ties, blocks, setup roads, and zeros without mutating the board", () => {
    const state = opened.state;
    const first = pathFrom(state, 6, new Set());
    const second = pathFrom(state, 5, new Set(first.edges));
    const seat = (id: string) => state.players.find((player) => player.id === id)!;

    own(state, "c1", first.edges.slice(0, 5));
    own(state, "c2", second.edges.slice(0, 4));
    updateLongestRoadAward(state);
    expect(seat("c1").roadLength).toBe(5);
    expect(seat("c1").hasLongestRoad).toBe(true);
    const before = fingerprint(state);
    const retained = longestRoadFeaturesForEdge(state, "c1", first.edges[5]);
    expect(fingerprint(state)).toBe(before);
    expect(retained.longest_road_retain).toBe(1);
    expect(retained.road_length_delta).toBe(1);
    expect(retained.longest_road_gain + retained.longest_road_retain + retained.longest_road_lose + retained.longest_road_otherwise).toBe(1);

    state.edgeOwner.fill(null);
    own(state, "c1", first.edges.slice(0, 4));
    own(state, "c2", second.edges);
    updateLongestRoadAward(state);
    expect(seat("c1").roadLength).toBe(4);
    expect(seat("c2").hasLongestRoad).toBe(true);
    const extending = first.edges[4];
    const tied = longestRoadFeaturesForEdge(state, "c1", extending);
    expect(tied.road_length_now).toBe(4);
    expect(tied.road_length_after).toBe(5);
    expect(tied.road_length_delta).toBe(1);
    expect(tied.longest_road_otherwise).toBe(1);
    expect(tied.longest_road_gain).toBe(0);

    state.edgeOwner.fill(null);
    own(state, "c1", first.edges.slice(0, 4));
    updateLongestRoadAward(state);
    const taken = longestRoadFeaturesForEdge(state, "c1", extending);
    expect(taken.road_length_now).toBe(4);
    expect(taken.longest_road_gain).toBe(1);
    expect(taken.road_length_after).toBe(5);
    const side = first.edges[5];

    const blockedCorner = first.corners[2];
    state.cornerOwner[blockedCorner] = "c2";
    state.cornerPiece[blockedCorner] = 1;
    updateLongestRoadAward(state);
    const blockedLength = state.players[0].roadLength;
    expect(blockedLength).toBeLessThan(5);
    const blocked = longestRoadFeaturesForEdge(state, "c1", side);
    expect(blocked.road_length_now).toBe(blockedLength);
    expect(blocked.longest_road_gain).toBe(0);

    const again = longestRoadFeaturesForEdge(state, "c1", side);
    const reversed = longestRoadFeaturesForEdge(state, "c1", extending);
    expect(again).toEqual(longestRoadFeaturesForEdge(state, "c1", side));
    expect(reversed.road_length_now).toBe(again.road_length_now);

    const endTurn = longestRoadFeaturesForAction(state, "c1", { type: "endTurn" });
    expect(endTurn).toEqual({
      road_length_now: 0,
      road_length_after: 0,
      road_length_delta: 0,
      longest_road_gain: 0,
      longest_road_retain: 0,
      longest_road_lose: 0,
      longest_road_otherwise: 0
    });
    const setup = longestRoadFeaturesForAction(state, "c1", { type: "placeSetupRoad", edgeIndex: side });
    const free = longestRoadFeaturesForAction(state, "c1", { type: "placeFreeRoad", edgeIndex: side });
    const paid = longestRoadFeaturesForAction(state, "c1", { type: "buildRoad", edgeIndex: side });
    expect(setup).toEqual(paid);
    expect(free).toEqual(paid);

    const legal: SimulatedAction[] = [
      { type: "buildRoad", edgeIndex: side },
      { type: "endTurn" },
      { type: "placeSetupRoad", edgeIndex: side }
    ];
    const observation = toObservation(state, "c1", legal, new PublicResourceLedger(["c1", "c2"]));
    expect(observationLeaks(observation)).toBeUndefined();
    expect(observation.actor.road_length).toBe(state.players[0].roadLength);
    expect(observation.actor.has_longest_road).toBe(state.players[0].hasLongestRoad);
    const road = observation.candidates.find((candidate) => candidate.type === "buildRoad");
    const other = observation.candidates.find((candidate) => candidate.type === "endTurn");
    expect(road?.public_features.longest_road_gain).toBe(paid.longest_road_gain);
    expect(road?.public_features.road_length_delta).toBe(paid.road_length_delta);
    expect(other?.public_features.road_length_now).toBe(0);
    expect(other?.public_features.longest_road_otherwise).toBe(0);
    const summary = wireObservation(observation, "summary");
    expect(summary.board.edges).toEqual([]);
    expect(summary.actor.road_length).toBe(observation.actor.road_length);
    expect(summary.actor.has_longest_road).toBe(observation.actor.has_longest_road);
    expect(summary.candidates.find((candidate) => candidate.type === "buildRoad")?.public_features.road_length_after).toBe(paid.road_length_after);

    const firstRoad = longestRoadFeaturesForEdge(state, "c1", side);
    const secondRoad = longestRoadFeaturesForEdge(state, "c1", extending);
    const flippedSecond = longestRoadFeaturesForEdge(state, "c1", extending);
    const flippedFirst = longestRoadFeaturesForEdge(state, "c1", side);
    expect(flippedFirst).toEqual(firstRoad);
    expect(flippedSecond).toEqual(secondRoad);

    writeFileSync(
      resolve("ml/fixtures/longest_road_cases.json"),
      JSON.stringify({
        gain_tie: observation,
        note: "Public board and stamped features. No player names beyond seat ids."
      })
    );
  });
});
