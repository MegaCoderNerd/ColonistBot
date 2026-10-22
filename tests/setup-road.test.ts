import { describe, expect, it } from "vitest";
import { placementsFrom } from "../src/analyzer/advisor";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { planTurn } from "../src/analyzer/engine/decide";
import { displayRoadAdvice, endsOf, guideOpeningRoads, listOpenEdges } from "../src/analyzer/engine/roads";
import { contextFor, isLegal } from "../src/analyzer/strategy";
import type { Board, GameEvent, Placements } from "../src/analyzer/types";

function touches(board: Board, edge: string, corner: string): boolean {
  const ends = endsOf(contextFor(board), edge);
  return Boolean(ends && (ends[0] === corner || ends[1] === corner));
}

function build(player: string, piece: "settlement" | "road", at: string, t: number): GameEvent {
  return { type: "build", player, piece, at, setup: true, t, turn: 0 };
}

function placed(events: GameEvent[]): Placements {
  return placementsFrom(events);
}

describe("setup road recommendations", () => {
  const board = buildGeneratedOpening("setup-road").board;
  const ctx = contextFor(board);
  const first = ctx.corners.find((corner) => (ctx.nbrs.get(corner.at)?.length ?? 0) >= 2);
  if (!first) throw new Error("board has no corner");
  const blocked = new Set<string>([first.at, ...(ctx.nbrs.get(first.at) ?? [])]);
  const second = ctx.corners.find((corner) => corner.at !== first.at && isLegal(ctx, corner.at, blocked));
  if (!second) throw new Error("board has no second settlement");
  const firstEdge = listOpenEdges(
    board,
    { settlements: new Map([[first.at, "me"]]), cities: new Map(), roads: new Map() },
    "me",
    first.at,
    true
  )[0];
  if (!firstEdge) throw new Error("first settlement has no road");

  it("recommends the first setup road only from the settlement just placed", () => {
    const events = [build("me", "settlement", first.at, 1)];
    const guidance = guideOpeningRoads(board, placed(events), "me", { events, myTurn: true });
    expect(guidance.stage).toBe("first_road");
    expect(guidance.anchor).toBe(first.at);
    expect(guidance.current).toBeDefined();
    const legal = listOpenEdges(board, placed(events), "me", first.at, true).map((edge) => edge.edge);
    expect(legal).toContain(guidance.current?.edge);
    expect(touches(board, guidance.current!.edge, first.at)).toBe(true);
    expect(guidance.later).toBeDefined();
    expect(guidance.later?.edge).not.toBe(guidance.current?.edge);
    expect(legal).not.toContain(guidance.later?.edge);
    expect(touches(board, guidance.later!.edge, first.at)).toBe(false);
    expect(guidance.later?.reason).toContain("Not this placement");
    const shown = displayRoadAdvice({ opening: true, guidance });
    expect(shown.current?.edge).toBe(guidance.current?.edge);
    expect(shown.current?.title).toBe("First setup road");
    expect(shown.current?.edge).not.toBe(guidance.later?.edge);
  });

  it("keeps the second setup road on the new settlement and drops the first road's extension", () => {
    const events = [
      build("me", "settlement", first.at, 1),
      build("me", "road", firstEdge.edge, 2),
      build("me", "settlement", second.at, 3)
    ];
    const guidance = guideOpeningRoads(board, placed(events), "me", { events, myTurn: true });
    const extensions = listOpenEdges(board, placed(events), "me", first.at, true).map((edge) => edge.edge);
    const legal = listOpenEdges(board, placed(events), "me", second.at, true).map((edge) => edge.edge);
    expect(guidance.stage).toBe("second_road");
    expect(guidance.anchor).toBe(second.at);
    expect(guidance.current).toBeDefined();
    expect(legal).toContain(guidance.current?.edge);
    expect(touches(board, guidance.current!.edge, second.at)).toBe(true);
    expect(touches(board, guidance.current!.edge, first.at)).toBe(false);
    expect(extensions).not.toContain(guidance.current?.edge);
    expect(guidance.current?.reason).toContain("Extending the first road is not legal");
    expect(guidance.later).toBeDefined();
    expect(guidance.later?.edge).not.toBe(guidance.current?.edge);
    expect(legal).not.toContain(guidance.later?.edge);
    expect(guidance.later?.reason).toContain("Not this placement");
    expect(guidance.toward).toBeDefined();
  });

  it("does not treat the second settlement's road as legal before that settlement exists", () => {
    const events = [build("me", "settlement", first.at, 1), build("me", "road", firstEdge.edge, 2)];
    const guidance = guideOpeningRoads(board, placed(events), "me", { events, myTurn: true, previewFrom: second.at });
    expect(guidance.stage).toBe("second_settlement");
    expect(guidance.current).toBeUndefined();
    expect(guidance.explanation).toContain("Place the second settlement first");
    if (guidance.later) {
      expect(guidance.later.reason).toContain("Not this placement");
      expect(touches(board, guidance.later.edge, second.at)).toBe(true);
    }
    const shown = displayRoadAdvice({ opening: true, guidance });
    expect(shown.current).toBeUndefined();
    expect(shown.sections.some((section) => section.lines.some((line) => line.includes("not extend the first road")))).toBe(true);
  });

  it("clears the setup action after the second road and replaces it with the normal-turn road", () => {
    const events = [
      build("me", "settlement", first.at, 1),
      build("me", "road", firstEdge.edge, 2),
      build("me", "settlement", second.at, 3)
    ];
    const before = guideOpeningRoads(board, placed(events), "me", { events, myTurn: true });
    const secondEdge = before.current?.edge;
    expect(secondEdge).toBeDefined();
    const doneEvents = [...events, build("me", "road", secondEdge!, 4)];
    const done = guideOpeningRoads(board, placed(doneEvents), "me", { events: doneEvents, myTurn: true });
    expect(done.stage).toBe("setup_done");
    expect(done.current).toBeUndefined();
    expect(done.explanation).toContain("already placed");
    const turn = planTurn({ board, placements: placed(doneEvents), me: "me", handKnown: false, events: doneEvents });
    const shown = displayRoadAdvice({
      opening: false,
      guidance: done,
      turnRoad: turn.road ? { edge: turn.road.edge, reason: turn.road.reason } : undefined,
      history: `Already placed, not an action. ${before.current?.reason}`,
      emptyReason: `No road to place on this turn. ${turn.headline}`
    });
    const placedEdges = new Set(placed(doneEvents).roads.keys());
    if (shown.current) {
      expect(placedEdges.has(shown.current.edge)).toBe(false);
      expect(shown.current.edge).not.toBe(firstEdge.edge);
      expect(shown.current.edge).not.toBe(secondEdge);
      expect(listOpenEdges(board, placed(doneEvents), "me").map((edge) => edge.edge)).toContain(shown.current.edge);
      expect(shown.current.title).toBe("Next road");
    } else {
      expect(shown.sections.some((section) => section.lines.some((line) => line.startsWith("No road to place on this turn.")))).toBe(true);
    }
    expect(shown.sections.some((section) => section.title === "Setup context" && section.lines[0].includes("not an action"))).toBe(true);
    expect(shown.current?.edge).not.toBe(before.current?.edge);
  });

  it("does not keep a stale setup edge once the normal turn has its own road", () => {
    const stale = guideOpeningRoads(board, placed([build("me", "settlement", first.at, 1)]), "me", { myTurn: true });
    const shown = displayRoadAdvice({
      opening: false,
      guidance: { ...stale, current: { edge: "stale-setup-edge", reason: "old setup road" } },
      turnRoad: { edge: "main-edge", reason: "This is the road toward the next settlement." },
      history: "Already placed, not an action. old setup road"
    });
    expect(shown.current).toEqual({ edge: "main-edge", title: "Next road", reason: "This is the road toward the next settlement." });
    expect(shown.sections.some((section) => section.lines.some((line) => line.includes("stale-setup-edge")))).toBe(false);
    expect(shown.sections.find((section) => section.title === "Setup context")?.lines[0]).toContain("not an action");
  });

  it("explains an empty normal turn instead of dropping the road section", () => {
    const shown = displayRoadAdvice({
      opening: false,
      guidance: { stage: "setup_done", explanation: "Both setup roads are already placed. There is no setup road left to play." },
      emptyReason: "No road to place on this turn. Hold the cards."
    });
    expect(shown.current).toBeUndefined();
    expect(shown.sections.some((section) => section.title === "Road" && section.lines[0] === "No road to place on this turn. Hold the cards.")).toBe(true);
  });

  it("does not recommend the opponent's settlement as the user's road", () => {
    const events = [build("opp", "settlement", first.at, 1)];
    const mine = guideOpeningRoads(board, placed(events), "me", { events, myTurn: true });
    const theirs = guideOpeningRoads(board, placed(events), "opp", { events, myTurn: true });
    expect(mine.stage).toBe("first_settlement");
    expect(mine.current).toBeUndefined();
    expect(mine.anchor).toBeUndefined();
    expect(theirs.stage).toBe("first_road");
    expect(theirs.anchor).toBe(first.at);
    expect(mine.current?.edge).not.toBe(theirs.current?.edge);
  });

  it("drops the recommendation when the turn is not the user's", () => {
    const events = [build("me", "settlement", first.at, 1)];
    const guidance = guideOpeningRoads(board, placed(events), "me", { events, myTurn: false });
    expect(guidance.current).toBeUndefined();
    expect(guidance.explanation).toContain("not your placement");
    const shown = displayRoadAdvice({ opening: true, guidance });
    expect(shown.current).toBeUndefined();
    expect(shown.sections.some((section) => section.lines.some((line) => line.includes("not your placement")))).toBe(true);
  });
});
