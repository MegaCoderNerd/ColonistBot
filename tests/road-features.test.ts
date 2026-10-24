import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ExternalLearnerSession } from "../src/analyzer/ml/games";
import { observationLeaks } from "../src/analyzer/ml/observation";

describe("road expansion features", () => {
  it("distinguishes roads by settlement reach without leaving the public board", () => {
    let cursor = ExternalLearnerSession.start({
      seed: "ml-v6-feature-probe",
      learner: "c1",
      opponent: "baseline_heuristic_v1",
      teacher: "baseline_heuristic_v1",
      victoryPointsToWin: 10,
      maxTurns: 18,
      maxActions: 120,
      checkpoint: null,
      detail: "full"
    });
    let distinguished = false;
    let saved = false;
    let steps = 0;
    while (cursor.reply.type === "decision" && steps < 120) {
      const decision = cursor.reply;
      expect(observationLeaks(decision.observation)).toBeUndefined();
      expect(JSON.stringify(decision.observation)).not.toContain("devDeckOrder");
      const roads = decision.observation.candidates.filter((candidate) => candidate.type === "buildRoad" || candidate.type === "placeFreeRoad" || candidate.type === "placeSetupRoad");
      for (const road of roads) {
        expect(road.public_features.connects_network).toBe(1);
        expect([0, 1, 2, 3, 99]).toContain(road.public_features.reach_after);
        expect(road.public_features.opens_settlement === 0 || road.public_features.opens_settlement === 1).toBe(true);
        expect(road.public_features.newly_opened).toBeGreaterThanOrEqual(0);
        expect(road.public_features.newly_opened).toBeLessThanOrEqual(2);
      }
      for (const other of decision.observation.candidates) {
        if (roads.includes(other)) continue;
        expect(other.public_features.reach_before_known).toBe(0);
        expect(other.public_features.opens_settlement).toBe(0);
        expect(other.public_features.connects_network).toBe(0);
      }
      if (roads.length >= 2) {
        const left = JSON.stringify(roads[0].public_features);
        const right = JSON.stringify(roads[1].public_features);
        if (left !== right) distinguished = true;
        if (!saved) {
          writeFileSync(
            resolve("ml/fixtures/road_reach.json"),
            JSON.stringify({
              actor_id: decision.observation.actor_id,
              board: decision.observation.board,
              placements: decision.observation.placements,
              candidates: decision.observation.candidates.map((candidate) => ({
                action_id: candidate.action_id,
                type: candidate.type,
                public_features: candidate.public_features
              }))
            })
          );
          saved = true;
        }
      }
      const teacher = decision.teacher_action_id;
      expect(teacher).toBeTruthy();
      cursor = { session: cursor.session, reply: cursor.session!.act(teacher!) };
      steps += 1;
    }
    expect(saved).toBe(true);
    expect(distinguished).toBe(true);
  });
});