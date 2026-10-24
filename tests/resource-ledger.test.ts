import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { learnerInitialState, exportHeuristicGame } from "../src/analyzer/ml/games";
import { PublicResourceLedger } from "../src/analyzer/ml/ledger";
import { observationLeaks, toObservation, trackedFeatureTail, visibleHandSize, type ColonistObservation } from "../src/analyzer/ml/observation";
import { getLegalActions } from "../src/analyzer/engine/transition";
import { BANK_RESOURCE_CAP } from "../src/analyzer/engine/state";
import { RESOURCES } from "../src/analyzer/types";

function opened() {
  const created = learnerInitialState({ seed: "ml-ledger-unit", victoryPointsToWin: 10, maxTurns: 4, maxActions: 20 });
  if (!created.ok) throw new Error(created.error.message);
  const ledger = new PublicResourceLedger(["c1", "c2"]);
  return { state: created.state, ledger };
}

function syncFromLedger(state: ReturnType<typeof opened>["state"], ledger: PublicResourceLedger) {
  const snap = ledger.snapshot({});
  for (const player of state.players) {
    const tracked = snap.hands[player.id];
    if (!tracked) continue;
    player.hand = {
      lumber: tracked.lumber,
      brick: tracked.brick,
      wool: tracked.wool,
      grain: tracked.grain,
      ore: tracked.ore
    };
  }
}

function observe(state: ReturnType<typeof opened>["state"], ledger: PublicResourceLedger, actorId = "c1"): ColonistObservation {
  return toObservation(state, actorId, getLegalActions(state, actorId), ledger);
}

describe("live resource counter in the learner observation", () => {
  it("keeps an exact bank and both hands when every transfer was named", () => {
    const { state, ledger } = opened();
    ledger.applyPublic({ type: "gain", player: "c1", cards: { lumber: 4, brick: 1, wool: 1, grain: 2, ore: 3 }, source: "other" });
    ledger.applyPublic({ type: "gain", player: "c2", cards: { lumber: 2, ore: 1 }, source: "other" });
    ledger.record(state, "c1", { type: "buildCity", cornerIndex: 0 });
    ledger.record(state, "c1", { type: "bankTrade", give: "lumber", receive: "brick" });
    ledger.applyPublic({ type: "steal", player: "c2", victim: "c1", card: "brick" });
    syncFromLedger(state, ledger);
    const observation = observe(state, ledger);
    expect(observationLeaks(observation)).toBeUndefined();
    expect(observation.schema_version).toBe("colonist_observation_v2");
    expect(observation.bank_exact).toBe(true);
    expect(observation.bank_confidence).toBe("derived_from_exact_hands");
    expect(observation.actor.hand).toEqual({ lumber: 0, brick: 1, wool: 1, grain: 0, ore: 0 });
    const opponent = observation.opponents.find((player) => player.id === "c2");
    expect(opponent?.tracked_resources).toMatchObject({ lumber: 2, brick: 1, ore: 1, unknown: 0, exact: true });
    expect(opponent && "hand" in opponent).toBe(false);
    for (const resource of RESOURCES) {
      const held = observation.actor.hand[resource] + (opponent?.tracked_resources[resource] ?? 0);
      expect((observation.bank?.[resource] ?? -1) + held).toBe(BANK_RESOURCE_CAP);
    }
    const before = JSON.stringify(observation.bank);
    state.bank = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
    const swapped = state.players.find((player) => player.id === "c2");
    if (!swapped) throw new Error("missing c2");
    const lumber = swapped.hand.lumber;
    swapped.hand.lumber = swapped.hand.ore;
    swapped.hand.ore = lumber;
    const again = observe(state, ledger);
    expect(again.bank).toEqual(JSON.parse(before));
    expect(again.opponents.find((player) => player.id === "c2")?.tracked_resources.lumber).toBe(2);
    expect(again.opponents.find((player) => player.id === "c2")?.tracked_resources.ore).toBe(1);
  });

  it("updates both players and the derived bank for a named steal, a build, and a discard", () => {
    const { state, ledger } = opened();
    ledger.applyPublic({ type: "gain", player: "c1", cards: { lumber: 2, brick: 2, wool: 1, grain: 1, ore: 4 }, source: "roll" });
    ledger.applyPublic({ type: "gain", player: "c2", cards: { wool: 2 }, source: "roll" });
    const before = ledger.snapshot({});
    ledger.record(state, "c1", { type: "buildRoad", edgeIndex: 0 });
    ledger.record(state, "c2", { type: "discard", cards: { wool: 1 } });
    ledger.applyPublic({ type: "steal", player: "c1", victim: "c2", card: "wool" });
    const after = ledger.snapshot({});
    expect(after.hands.c1).toMatchObject({ lumber: 1, brick: 1, wool: 2, exact: true });
    expect(after.hands.c2).toMatchObject({ wool: 0, exact: true });
    expect(after.bank?.lumber).toBe((before.bank?.lumber ?? 0) + 1);
    expect(after.bank?.brick).toBe((before.bank?.brick ?? 0) + 1);
    expect(after.bank?.wool).toBe((before.bank?.wool ?? 0) + 1);
    expect(after.bank_exact).toBe(true);
  });

  it("does not treat an unnamed steal or a missed gain as an exact count", () => {
    const { state, ledger } = opened();
    ledger.applyPublic({ type: "gain", player: "c1", cards: { ore: 2 }, source: "roll" });
    ledger.applyPublic({ type: "gain", player: "c2", cards: { lumber: 3, brick: 1 }, source: "roll" });
    ledger.applyPublic({ type: "steal", player: "c1", victim: "c2" });
    syncFromLedger(state, ledger);
    const unnamed = observe(state, ledger, "c1");
    expect(unnamed.bank).toBeNull();
    expect(unnamed.bank_exact).toBe(false);
    const victim = unnamed.opponents.find((player) => player.id === "c2");
    expect(victim?.tracked_resources.exact).toBe(false);
    expect(victim?.tracked_resources.lumber).toBe(3);
    state.players.find((player) => player.id === "c2")!.hand = { lumber: 1, brick: 0, wool: 0, grain: 0, ore: 4 };
    const hidden = observe(state, ledger, "c1");
    expect(hidden.opponents.find((player) => player.id === "c2")?.tracked_resources.lumber).toBe(3);
    expect(hidden.opponents.find((player) => player.id === "c2")?.tracked_resources.ore).toBe(0);
    expect(hidden.bank_exact).toBe(false);
    expect(observationLeaks(hidden)).toBeUndefined();

    const missed = new PublicResourceLedger(["c1", "c2"]);
    const missedState = learnerInitialState({ seed: "ml-ledger-missed", victoryPointsToWin: 10, maxTurns: 2, maxActions: 8 });
    if (!missedState.ok) throw new Error(missedState.error.message);
    missedState.state.players.find((player) => player.id === "c2")!.hand.grain = 4;
    const observation = observe(missedState.state, missed, "c1");
    expect(observation.bank_exact).toBe(false);
    expect(observation.bank).toBeNull();
    expect(observation.opponents.find((player) => player.id === "c2")?.tracked_resources.grain).toBe(0);
    expect(observation.opponents.find((player) => player.id === "c2")?.tracked_resources.exact).toBe(false);
    expect(observation.opponents.find((player) => player.id === "c2")?.hand_size).toBe(4);
  });

  it("matches the counter on a generated game and ignores a later edit to the hidden bank", () => {
    const examples = exportHeuristicGame(
      { seed: "ml-ledger-game", victoryPointsToWin: 10, maxTurns: 8, maxActions: 40 },
      ["baseline_heuristic_v1", "baseline_distance_only_v1"]
    );
    expect(examples.length).toBeGreaterThan(0);
    const exact = examples.filter((example) => example.observation.bank_exact);
    expect(exact.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.teacher_action_id).toBeNull();
      expect(observationLeaks(example.observation)).toBeUndefined();
      expect(example.observation.opponents.every((opponent) => !("hand" in opponent))).toBe(true);
      const opponent = example.observation.opponents[0];
      if (!example.observation.bank_exact || !opponent?.tracked_resources.exact) continue;
      for (const resource of RESOURCES) {
        const held = example.observation.actor.hand[resource] + opponent.tracked_resources[resource];
        expect(held + (example.observation.bank?.[resource] ?? 0)).toBe(BANK_RESOURCE_CAP);
      }
      expect(visibleHandSize(opponent.tracked_resources)).toBe(opponent.hand_size);
    }
  });

  it("agrees with the Python tracked-feature tail", () => {
    const fixture = JSON.parse(readFileSync(resolve("ml/fixtures/tracked_tail.json"), "utf8")) as {
      expected_tail: number[];
      opponents: ColonistObservation["opponents"];
      bank_exact: boolean;
    };
    expect(trackedFeatureTail(fixture)).toEqual(fixture.expected_tail);
  });
});
