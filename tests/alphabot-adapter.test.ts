import { describe, expect, it } from "vitest";
import { acceptMappedAction, adaptColonistStateForAlphabot, ALPHABOT_REFERENCE } from "../src/analyzer/engine/alphabot-adapter";
import { baselineRolloutPolicy } from "../src/analyzer/engine/rollout";

describe("AlphaBot adapter boundary", () => {
  it("refuses a Colonist state instead of inventing hidden cards or board indexes", () => {
    const result = adaptColonistStateForAlphabot();
    expect(result.ok).toBe(false);
    expect(result.usedHiddenOpponentCards).toBe(false);
    expect(result.inventedFields).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Visibility::Perfect/);
    expect(result.reasons.join(" ")).toMatch(/does not sample or fill/);
    expect(result.topologyMapping).toBeNull();
    expect(result.reasons.join(" ")).toMatch(/not a populated AlphaBot GameState/);
    expect(result).not.toHaveProperty("hand");
    expect(result).not.toHaveProperty("board");
  });

  it("records the shipped AlphaBot entry points and leaves the production policy id unchanged", () => {
    expect(ALPHABOT_REFERENCE.revision).toBe("021279c56834b6203480e5292e1de7246e47bd68");
    expect(ALPHABOT_REFERENCE.model).toBe("models/catan-512.ctnn");
    expect(ALPHABOT_REFERENCE.search).toContain("AlphaBot::choose_action");
    expect(baselineRolloutPolicy.id).toBe("baseline_heuristic_v1");
  });

  it("drops a mapped action that is not legal and keeps one that is", () => {
    const legal: Array<{ type: "buildRoad"; edgeIndex: number } | { type: "endTurn" }> = [
      { type: "buildRoad", edgeIndex: 4 },
      { type: "endTurn" }
    ];
    const same = (left: (typeof legal)[number], right: (typeof legal)[number]) =>
      left.type === right.type && ("edgeIndex" in left ? left.edgeIndex : -1) === ("edgeIndex" in right ? right.edgeIndex : -1);
    expect(acceptMappedAction({ type: "buildRoad", edgeIndex: 9 }, legal, same)).toBeNull();
    expect(acceptMappedAction({ type: "endTurn" }, legal, same)).toEqual({ type: "endTurn" });
  });
});
