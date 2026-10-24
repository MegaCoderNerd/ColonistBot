import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RACE_WEIGHTS } from "../src/analyzer/engine/race";
import { ExternalLearnerSession, exportHeuristicGame, POLICY_POOL } from "../src/analyzer/ml/games";
import { actionId, observationLeaks } from "../src/analyzer/ml/observation";
import type { SimulatedAction } from "../src/analyzer/engine/transition";

const root = resolve(".");
const LIVE = ["src/extension/helper.ts", "src/extension/overlay.ts", "src/analyzer/engine/decide.ts", "src/analyzer/engine/shadow.ts", "src/extension/content.ts"];

describe("synthetic observation", () => {
  it("labels a cutoff as incomplete and hides the opponent hand", () => {
    const examples = exportHeuristicGame(
      { seed: "ml-observation-cutoff", victoryPointsToWin: 10, maxTurns: 1, maxActions: 30 },
      ["baseline_heuristic_v1", "baseline_distance_only_v1"]
    );
    expect(examples.length).toBeGreaterThan(0);
    expect(examples[0].completion_status).toBe("incomplete");
    expect(examples[0].actor_win).toBeNull();
    expect(examples[0].simulator.rule_profile).toBe("colonist_benchmark_1v1_v1");
    expect(examples[0].generating_policy).toBe("baseline_heuristic_v1");
    expect(examples.every((example) => example.actor_win === null)).toBe(true);
    for (const example of examples) {
      expect(observationLeaks(example.observation)).toBeUndefined();
      expect(example.observation.opponents.every((opponent) => !("hand" in opponent))).toBe(true);
      expect(JSON.stringify(example.observation)).not.toContain("devDeckOrder");
      const ids = example.observation.candidates.map((candidate) => candidate.action_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(example.chosen_action_id);
    }
  });

  it("rebuilds the same heuristic actions from the same seed", () => {
    const limits = { seed: "ml-observation-replay", victoryPointsToWin: 4, maxTurns: 2, maxActions: 40 };
    const first = exportHeuristicGame(limits, ["baseline_heuristic_v1", "random_legal_diagnostic_v1"]);
    const second = exportHeuristicGame(limits, ["baseline_heuristic_v1", "random_legal_diagnostic_v1"]);
    expect(first.map((example) => example.chosen_action_id)).toEqual(second.map((example) => example.chosen_action_id));
    expect(first.map((example) => example.actor_win)).toEqual(second.map((example) => example.actor_win));
  });

  it("keeps action ids stable and distinct", () => {
    const road = { type: "buildRoad", edgeIndex: 3 } as SimulatedAction;
    const other = { type: "buildRoad", edgeIndex: 4 } as SimulatedAction;
    expect(actionId(road)).toBe("buildRoad:e3");
    expect(actionId(other)).not.toBe(actionId(road));
  });

  it("rejects an illegal external action and accepts a legal one", () => {
    const started = ExternalLearnerSession.start({
      seed: "ml-session-legal",
      learner: "both",
      opponent: "baseline_heuristic_v1",
      victoryPointsToWin: 4,
      maxTurns: 2,
      maxActions: 20,
      checkpoint: null
    });
    expect(started.reply.type).toBe("decision");
    if (started.reply.type !== "decision" || !started.session) throw new Error("expected a decision");
    const refused = started.session.act("not-a-real-action");
    expect(refused.type).toBe("error");
    const legalId = started.reply.observation.candidates[0].action_id;
    const accepted = started.session.act(legalId);
    expect(accepted.type === "decision" || accepted.type === "terminal").toBe(true);
  });

  it("does not enter the live coach, and the pool names the baseline without replacing it", () => {
    expect(DEFAULT_RACE_WEIGHTS).toEqual({ lostPenalty: 12, uncertainPenalty: 1.5, urgentBonus: 1.5 });
    expect(POLICY_POOL.baseline_heuristic_v1.id).toBe("baseline_heuristic_v1");
    expect(POLICY_POOL.production_aware_dev_card_v1).toBeUndefined();
    const summary = ExternalLearnerSession.start({
      seed: "ml-summary-wire",
      learner: "c1",
      opponent: "baseline_heuristic_v1",
      victoryPointsToWin: 10,
      maxTurns: 1,
      maxActions: 8,
      checkpoint: "untrained",
      detail: "summary"
    });
    expect(summary.reply.type).toBe("decision");
    if (summary.reply.type !== "decision") throw new Error("expected a summary decision");
    expect(summary.reply.observation.detail).toBe("summary");
    expect(summary.reply.observation.board.hexes).toEqual([]);
    expect(summary.reply.observation.candidates[0].simulator).toBeUndefined();
    expect(observationLeaks(summary.reply.observation)).toBeUndefined();
    const legalId = summary.reply.observation.candidates[0].action_id;
    let reply = summary.session?.act(legalId);
    let guard = 0;
    while (reply && reply.type === "decision" && guard < 8) {
      reply = summary.session?.act(reply.observation.candidates[0].action_id);
      guard += 1;
    }
    expect(reply?.type).toBe("terminal");
    if (reply?.type !== "terminal") throw new Error("expected a terminal summary game");
    expect(reply.actor_win).toEqual({ c1: null, c2: null });
    expect(reply.cutoff_reason).toBeTruthy();
    expect(reply.scores.c1.actual_vp).toBeGreaterThanOrEqual(0);
    expect(reply.scores.c2.visible_vp).toBeGreaterThanOrEqual(0);
    expect(reply.scores.c1.settlements_placed).toBeGreaterThanOrEqual(0);
    expect(reply.scores.c1.roads_placed).toBeGreaterThanOrEqual(0);
    expect(reply.limits).toEqual({ victory_points_to_win: 10, max_turns: 1, max_actions: 8 });
    expect(summary.reply.teacher_action_id).toBeNull();
    const taught = ExternalLearnerSession.start({
      seed: "ml-teacher-same-state",
      learner: "c1",
      opponent: "baseline_distance_only_v1",
      teacher: "baseline_heuristic_v1",
      victoryPointsToWin: 10,
      maxTurns: 8,
      maxActions: 40,
      checkpoint: null,
      detail: "summary"
    });
    expect(taught.reply.type).toBe("decision");
    if (taught.reply.type !== "decision") throw new Error("expected a taught decision");
    const taughtIds = taught.reply.observation.candidates.map((candidate) => candidate.action_id);
    expect(taught.reply.teacher_action_id).toBeTruthy();
    expect(taughtIds).toContain(taught.reply.teacher_action_id);
    const setup = taught.reply.observation.candidates.find((candidate) => candidate.type === "placeSetupSettlement");
    expect(setup?.public_features.cost_lumber).toBe(0);
    expect(setup?.public_features.corner_index).toBeGreaterThanOrEqual(0);
    expect(taught.reply.observation.actor.production).toBeTruthy();
    expect(taught.reply.observation.robber_resource === null || typeof taught.reply.observation.robber_resource === "string").toBe(true);
    const featured = exportHeuristicGame(
      { seed: "ml-feature-coverage", victoryPointsToWin: 10, maxTurns: 15, maxActions: 120 },
      ["baseline_heuristic_v1", "baseline_distance_only_v1"]
    );
    const seen = new Set(featured.flatMap((example) => example.observation.candidates.map((candidate) => candidate.type)));
    expect(seen.has("placeSetupSettlement")).toBe(true);
    expect(seen.has("placeSetupRoad")).toBe(true);
    expect(seen.has("rollDice")).toBe(true);
    for (const example of featured) {
      for (const candidate of example.observation.candidates) {
        expect(candidate.action_id.startsWith(candidate.type)).toBe(true);
        if (candidate.type === "buildRoad" || candidate.type === "buildSettlement" || candidate.type === "buildCity" || candidate.type === "buyDevCard") {
          const cost = candidate.public_features.cost_lumber + candidate.public_features.cost_brick + candidate.public_features.cost_wool + candidate.public_features.cost_grain + candidate.public_features.cost_ore;
          expect(cost).toBeGreaterThan(0);
        }
        if (candidate.type === "placeSetupSettlement" || candidate.type === "placeSetupRoad") {
          const cost = candidate.public_features.cost_lumber + candidate.public_features.cost_brick + candidate.public_features.cost_wool + candidate.public_features.cost_grain + candidate.public_features.cost_ore;
          expect(cost).toBe(0);
        }
      }
    }
    expect(JSON.stringify(taught.reply.observation)).not.toContain("teacher_diagnostic");
    expect(JSON.stringify(taught.reply.observation)).not.toContain("road_reach");
    const replay = ExternalLearnerSession.start({
      seed: "ml-teacher-same-state",
      learner: "c1",
      opponent: "baseline_distance_only_v1",
      teacher: "baseline_heuristic_v1",
      victoryPointsToWin: 10,
      maxTurns: 8,
      maxActions: 40,
      checkpoint: null,
      detail: "summary"
    });
    expect(replay.reply.type).toBe("decision");
    if (replay.reply.type !== "decision" || taught.reply.type !== "decision") throw new Error("expected matching decisions");
    expect(replay.reply.teacher_action_id).toBe(taught.reply.teacher_action_id);
    const firstTeacher = taught.reply.teacher_action_id;
    const alternative = taught.reply.observation.candidates.find((candidate) => candidate.action_id !== firstTeacher)?.action_id ?? firstTeacher;
    const afterOther = taught.session?.act(alternative!);
    const afterSame = replay.session?.act(alternative!);
    expect(afterOther?.type === "decision" || afterOther?.type === "terminal").toBe(true);
    if (afterOther?.type === "decision" && afterSame?.type === "decision") {
      expect(afterSame.teacher_action_id).toBe(afterOther.teacher_action_id);
      expect(afterOther.observation.candidates.map((candidate) => candidate.action_id)).toContain(afterOther.teacher_action_id);
    }
    let cursor = ExternalLearnerSession.start({
      seed: "ml-teacher-road-context",
      learner: "c1",
      opponent: "baseline_heuristic_v1",
      teacher: "baseline_heuristic_v1",
      victoryPointsToWin: 10,
      maxTurns: 12,
      maxActions: 80,
      checkpoint: "frozen-v4",
      detail: "summary"
    });
    let sawRoad = false;
    let steps = 0;
    while (cursor.reply.type === "decision" && steps < 80) {
      const decision = cursor.reply;
      expect(decision.observation.candidates.map((candidate) => candidate.action_id)).toContain(decision.teacher_action_id);
      expect(JSON.stringify(decision.observation)).not.toContain("devDeckOrder");
      expect(decision.observation.opponents.every((opponent) => !("hand" in opponent))).toBe(true);
      if (decision.teacher_action_id?.startsWith("buildRoad:") && decision.teacher_diagnostic?.road_reach) {
        expect(decision.teacher_diagnostic.explanation_available).toBe(false);
        expect(decision.teacher_diagnostic.road_reach.dist).toBeGreaterThanOrEqual(0);
        sawRoad = true;
        break;
      }
      cursor = { session: cursor.session, reply: cursor.session!.act(decision.teacher_action_id!) };
      steps += 1;
    }
    expect(sawRoad).toBe(true);
    for (const file of LIVE) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toContain("colonist_observation_v1");
      expect(source).not.toContain("colonist_observation_v2");
      expect(source).not.toContain("analyzer/ml/");
    }
  });
});
