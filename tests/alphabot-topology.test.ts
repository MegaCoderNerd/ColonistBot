import { describe, expect, it } from "vitest";
import { buildGeneratedOpening } from "../src/analyzer/benchmark/generated-board";
import { hexCenter, pointKey, viewPoint, type Point } from "../src/analyzer/geometry";
import { adaptColonistStateForAlphabot } from "../src/analyzer/engine/alphabot-adapter";
import {
  alphabotCanonicalTopology,
  mapColonistTopology,
  type BoardView,
  type TopologyCandidate
} from "../src/analyzer/engine/alphabot-topology";
import { buildBoardTopology, type BoardTopology } from "../src/analyzer/engine/topology";
import type { Board, HexTile, PortKind } from "../src/analyzer/types";

const alpha = alphabotCanonicalTopology();

function axialBoard(): Board {
  const hexes: HexTile[] = [];
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)) <= 2) {
        hexes.push({ id: `h${hexes.length}`, x, y, resource: x + y === 0 ? "ore" : "wool", number: 6 });
      }
    }
  }
  return { hexes, ports: [] };
}

function withCanonicalPorts(board: Board): Board {
  const topology = buildBoardTopology({ ...board, ports: [] });
  const ports = alpha.ports.map((port) => {
    const first = topology.cornerIndexByPointKey.get(pointKey(alpha.vertices[port.v1].point));
    const second = topology.cornerIndexByPointKey.get(pointKey(alpha.vertices[port.v2].point));
    const edge = topology.edges.find((item) => (item.c1 === first && item.c2 === second) || (item.c1 === second && item.c2 === first));
    if (!edge) throw new Error(`canonical port ${port.id} has no Colonist edge`);
    return { at: edge.at, kind: "any" as PortKind };
  });
  return { ...board, ports };
}

function transformBoard(board: Board, view: BoardView): Board {
  const hexes = board.hexes.map((hex) => {
    const moved = viewPoint(hexCenter(hex.x, hex.y), view);
    const y = Math.round(moved.y / 1.5);
    const x = Math.round(moved.x / Math.sqrt(3) - y / 2);
    return { ...hex, x, y };
  });
  const before = buildBoardTopology(board);
  const after = buildBoardTopology({ hexes, ports: [] });
  const ports = (board.ports ?? []).map((port) => {
    const edge = before.edges.find((item) => item.at === port.at);
    if (!edge) throw new Error(`missing edge ${port.at}`);
    const first = after.cornerIndexByPointKey.get(pointKey(viewPoint(before.corners[edge.c1].point, view)));
    const second = after.cornerIndexByPointKey.get(pointKey(viewPoint(before.corners[edge.c2].point, view)));
    const mapped = after.edges.find((item) => (item.c1 === first && item.c2 === second) || (item.c1 === second && item.c2 === first));
    if (!mapped) throw new Error(`port ${port.at} left the board`);
    return { at: mapped.at, kind: port.kind };
  });
  return { hexes, ports };
}

function shiftBoard(board: Board, dx: number, dy: number): Board {
  return {
    hexes: board.hexes.map((hex) => ({ ...hex, x: hex.x + dx, y: hex.y + dy })),
    ports: (board.ports ?? []).map((port) => {
      const [x, y, z] = port.at.split(",").map(Number);
      return { ...port, at: `${x + dx},${y + dy},${z}` };
    })
  };
}

function centroid(topology: BoardTopology): Point {
  const sum = topology.hexes.reduce((acc, hex) => {
    const center = hexCenter(hex.x, hex.y);
    return { x: acc.x + center.x, y: acc.y + center.y };
  }, { x: 0, y: 0 });
  return { x: sum.x / topology.hexes.length, y: sum.y / topology.hexes.length };
}

function expectIsomorphism(topology: BoardTopology, mapping: TopologyCandidate): void {
  expect(new Set(mapping.hexToAlphabot).size).toBe(19);
  expect(new Set(mapping.cornerToVertex).size).toBe(54);
  expect(new Set(mapping.edgeToAlphabot).size).toBe(72);
  expect(mapping.alphabotToHex).toHaveLength(19);
  expect(mapping.vertexToCorner).toHaveLength(54);
  expect(mapping.alphabotToEdge).toHaveLength(72);
  for (let index = 0; index < 19; index++) expect(mapping.alphabotToHex[mapping.hexToAlphabot[index]]).toBe(index);
  for (let index = 0; index < 54; index++) expect(mapping.vertexToCorner[mapping.cornerToVertex[index]]).toBe(index);
  for (let index = 0; index < 72; index++) expect(mapping.alphabotToEdge[mapping.edgeToAlphabot[index]]).toBe(index);

  const origin = centroid(topology);
  const placed = (point: Point) => viewPoint({ x: point.x - origin.x, y: point.y - origin.y }, mapping.view);
  for (const hex of topology.hexes) {
    const tile = alpha.tiles[mapping.hexToAlphabot[hex.index]];
    const center = placed(hexCenter(hex.x, hex.y));
    expect(Math.hypot(center.x - tile.point.x, center.y - tile.point.y)).toBeLessThan(1e-6);
    expect(hex.cornerIndices.map((corner) => mapping.cornerToVertex[corner]).sort((a, b) => a - b)).toEqual([...tile.vertices].sort((a, b) => a - b));
  }
  for (const edge of topology.edges) {
    const mapped = alpha.edges[mapping.edgeToAlphabot[edge.index]];
    expect([mapping.cornerToVertex[edge.c1], mapping.cornerToVertex[edge.c2]].sort((a, b) => a - b)).toEqual([mapped.v1, mapped.v2].sort((a, b) => a - b));
    const midpoint = placed({
      x: (topology.corners[edge.c1].point.x + topology.corners[edge.c2].point.x) / 2,
      y: (topology.corners[edge.c1].point.y + topology.corners[edge.c2].point.y) / 2
    });
    const alphaMid = {
      x: (alpha.vertices[mapped.v1].point.x + alpha.vertices[mapped.v2].point.x) / 2,
      y: (alpha.vertices[mapped.v1].point.y + alpha.vertices[mapped.v2].point.y) / 2
    };
    expect(Math.hypot(midpoint.x - alphaMid.x, midpoint.y - alphaMid.y)).toBeLessThan(1e-6);
  }
  for (const corner of topology.corners) {
    const vertex = alpha.vertices[mapping.cornerToVertex[corner.index]];
    const point = placed(corner.point);
    expect(Math.hypot(point.x - vertex.point.x, point.y - vertex.point.y)).toBeLessThan(1e-6);
    expect(corner.incidentEdgeIndices.map((edge) => mapping.edgeToAlphabot[edge]).sort((a, b) => a - b)).toEqual([...vertex.edges].sort((a, b) => a - b));
  }
}

describe("Colonist to AlphaBot topology", () => {
  it("rebuilds AlphaBot's 19, 54, 72 graph and its nine port edges", () => {
    expect(alpha.tiles).toHaveLength(19);
    expect(alpha.vertices).toHaveLength(54);
    expect(alpha.edges).toHaveLength(72);
    expect(alpha.ports).toHaveLength(9);
    for (const port of alpha.ports) {
      expect(alpha.edges[port.edge].tiles).toHaveLength(1);
    }
  });

  it("keeps every geometric alignment and does not choose one when ports are absent", () => {
    const result = mapColonistTopology(buildBoardTopology(axialBoard()));
    if (!("candidates" in result)) throw new Error("expected an ambiguous mapping");
    expect(result.candidates).toHaveLength(12);
    const topology = buildBoardTopology(axialBoard());
    for (const candidate of result.candidates) expectIsomorphism(topology, candidate);
  });

  it("selects one alignment when the nine canonical port edges are present", () => {
    const board = withCanonicalPorts(axialBoard());
    const topology = buildBoardTopology(board);
    const result = mapColonistTopology(topology);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapping.view).toEqual({ rot: 0, flip: false });
    expect(result.mapping.ports).toHaveLength(9);
    expect(new Set(result.mapping.ports.map((port) => port.alphabotPort)).size).toBe(9);
    expectIsomorphism(topology, result.mapping);
    expect(result.mapping.cornerToVertex.some((vertex, index) => vertex !== index)).toBe(true);
    expect(result.mapping.hexToAlphabot.some((tile, index) => tile !== index)).toBe(true);
  });

  it("recovers a rotated, reflected, or translated copy as the same physical board", () => {
    const canonical = mapColonistTopology(buildBoardTopology(withCanonicalPorts(axialBoard())));
    if (!canonical.ok) throw new Error("canonical ports did not select a mapping");
    for (const view of [
      { rot: 2, flip: false },
      { rot: 8, flip: true }
    ] as const) {
      const source = buildBoardTopology(withCanonicalPorts(axialBoard()));
      const topology = buildBoardTopology(transformBoard(withCanonicalPorts(axialBoard()), view));
      const result = mapColonistTopology(topology);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mapping.hexToAlphabot).toEqual(canonical.mapping.hexToAlphabot);
      expect(result.mapping.view).not.toEqual(canonical.mapping.view);
      for (const corner of source.corners) {
        const moved = topology.cornerIndexByPointKey.get(pointKey(viewPoint(corner.point, view)));
        expect(moved).toBeTypeOf("number");
        expect(result.mapping.cornerToVertex[moved ?? -1]).toBe(canonical.mapping.cornerToVertex[corner.index]);
      }
      for (const edge of source.edges) {
        const first = topology.cornerIndexByPointKey.get(pointKey(viewPoint(source.corners[edge.c1].point, view)));
        const second = topology.cornerIndexByPointKey.get(pointKey(viewPoint(source.corners[edge.c2].point, view)));
        const mapped = topology.edges.find((item) => (item.c1 === first && item.c2 === second) || (item.c1 === second && item.c2 === first));
        expect(mapped).toBeTruthy();
        expect(result.mapping.edgeToAlphabot[mapped?.index ?? -1]).toBe(canonical.mapping.edgeToAlphabot[edge.index]);
      }
      expectIsomorphism(topology, result.mapping);
    }
    const shifted = buildBoardTopology(shiftBoard(withCanonicalPorts(axialBoard()), 4, -2));
    const moved = mapColonistTopology(shifted);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.mapping.hexToAlphabot).toEqual(canonical.mapping.hexToAlphabot);
    expect(moved.mapping.cornerToVertex).toEqual(canonical.mapping.cornerToVertex);
    expectIsomorphism(shifted, moved.mapping);
  });

  it("ignores resource and number labels", () => {
    const ports = withCanonicalPorts(axialBoard());
    const scrambled: Board = {
      ...ports,
      hexes: ports.hexes.map((hex, index) => ({
        ...hex,
        resource: index % 5 === 0 ? null : "lumber",
        number: index % 5 === 0 ? null : 2 + (index % 10)
      }))
    };
    const first = mapColonistTopology(buildBoardTopology(ports));
    const second = mapColonistTopology(buildBoardTopology(scrambled));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.mapping.hexToAlphabot).toEqual(first.mapping.hexToAlphabot);
    expect(second.mapping.cornerToVertex).toEqual(first.mapping.cornerToVertex);
    expect(second.mapping.edgeToAlphabot).toEqual(first.mapping.edgeToAlphabot);
  });

  it("rejects an incomplete board and refuses to guess from noncanonical ports", () => {
    const short = axialBoard();
    short.hexes.pop();
    const removed = mapColonistTopology(buildBoardTopology(short));
    expect("mapping" in removed).toBe(false);
    expect("candidates" in removed).toBe(false);

    const generated = buildGeneratedOpening("alphabot-topology-ports");
    const shuffled = mapColonistTopology(generated.topology);
    if (!("candidates" in shuffled)) throw new Error("expected the shuffled ports to stay ambiguous");
    expect(shuffled.candidates.length).toBeGreaterThan(1);
  });

  it("exposes the mapping through the adapter without filling an AlphaBot state", () => {
    const topology = buildBoardTopology(withCanonicalPorts(axialBoard()));
    const result = adaptColonistStateForAlphabot(topology);
    expect(result.ok).toBe(false);
    expect(result.usedHiddenOpponentCards).toBe(false);
    expect(result.topologyMapping?.ok).toBe(true);
    expect(result).not.toHaveProperty("hand");
  });
});
