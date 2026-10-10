import { boardCorners, cornerPoint, edgePoints, hexCornerIds, pointKey, type Point } from "../geometry";
import { pips } from "../replay";
import type { Board, PortKind, Resource } from "../types";

export const STANDARD_COLONIST_CORNER_AT_BY_ID: Readonly<Record<string, string>> = {
  "0": "0,-2,0",
  "1": "1,-3,1",
  "2": "0,-1,0",
  "3": "0,-2,1",
  "4": "-1,-1,0",
  "5": "0,-3,1",
  "6": "-1,0,0",
  "7": "-1,-1,1",
  "8": "-2,0,0",
  "9": "-1,-2,1",
  "10": "-2,1,0",
  "11": "-2,0,1",
  "12": "-3,1,0",
  "13": "-2,-1,1",
  "14": "-1,0,1",
  "15": "-2,2,0",
  "16": "-2,1,1",
  "17": "-3,2,0",
  "18": "-1,1,1",
  "19": "-2,3,0",
  "20": "-2,2,1",
  "21": "-3,3,0",
  "22": "-1,2,0",
  "23": "0,1,1",
  "24": "-1,3,0",
  "25": "-1,2,1",
  "26": "0,2,0",
  "27": "1,1,1",
  "28": "0,3,0",
  "29": "0,2,1",
  "30": "1,1,0",
  "31": "2,0,1",
  "32": "1,2,0",
  "33": "1,0,1",
  "34": "2,0,0",
  "35": "3,-1,1",
  "36": "2,1,0",
  "37": "2,-1,1",
  "38": "2,-1,0",
  "39": "3,-2,1",
  "40": "1,0,0",
  "41": "2,-2,1",
  "42": "2,-2,0",
  "43": "3,-3,1",
  "44": "1,-1,0",
  "45": "2,-3,1",
  "46": "1,-2,0",
  "47": "1,-2,1",
  "48": "0,0,0",
  "49": "0,-1,1",
  "50": "-1,1,0",
  "51": "0,0,1",
  "52": "0,1,0",
  "53": "1,-1,1"
};

export const STANDARD_COLONIST_EDGE_AT_BY_ID: Readonly<Record<string, string>> = {
  "0": "1,-3,2",
  "1": "1,-2,1",
  "2": "0,-1,0",
  "3": "0,-2,2",
  "4": "0,-2,1",
  "5": "0,-2,0",
  "6": "0,-1,1",
  "7": "-1,0,0",
  "8": "-1,-1,2",
  "9": "-1,-1,1",
  "10": "-1,-1,0",
  "11": "-1,0,1",
  "12": "-2,1,0",
  "13": "-2,0,2",
  "14": "-2,0,1",
  "15": "-2,0,0",
  "16": "-1,0,2",
  "17": "-1,1,1",
  "18": "-2,2,0",
  "19": "-2,1,2",
  "20": "-2,1,1",
  "21": "-1,1,2",
  "22": "-1,2,1",
  "23": "-2,3,0",
  "24": "-2,2,2",
  "25": "-2,2,1",
  "26": "0,1,2",
  "27": "0,2,1",
  "28": "-1,3,0",
  "29": "-1,2,2",
  "30": "-1,2,0",
  "31": "1,1,2",
  "32": "1,2,1",
  "33": "0,3,0",
  "34": "0,2,2",
  "35": "0,2,0",
  "36": "2,0,2",
  "37": "2,1,1",
  "38": "1,2,0",
  "39": "1,1,1",
  "40": "1,1,0",
  "41": "3,-1,2",
  "42": "3,0,1",
  "43": "2,1,0",
  "44": "2,0,1",
  "45": "2,0,0",
  "46": "3,-2,2",
  "47": "3,-1,1",
  "48": "2,-1,2",
  "49": "2,-1,1",
  "50": "2,-1,0",
  "51": "3,-3,2",
  "52": "3,-2,1",
  "53": "2,-2,2",
  "54": "2,-2,1",
  "55": "2,-2,0",
  "56": "2,-3,2",
  "57": "1,-1,0",
  "58": "1,-2,2",
  "59": "1,-2,0",
  "60": "1,-1,1",
  "61": "0,0,0",
  "62": "0,-1,2",
  "63": "0,0,1",
  "64": "-1,1,0",
  "65": "0,0,2",
  "66": "0,1,1",
  "67": "1,0,2",
  "68": "0,1,0",
  "69": "1,0,1",
  "70": "1,0,0",
  "71": "1,-1,2"
};

export interface TopologyHex {
  readonly index: number;
  readonly colonistId: string;
  readonly coordKey: string;
  readonly x: number;
  readonly y: number;
  readonly resource: Resource | null;
  readonly number: number | null;
  readonly pips: number;
  readonly cornerIndices: readonly number[];
  readonly edgeIndices: readonly number[];
}

export interface TopologyCorner {
  readonly index: number;
  readonly colonistId?: string;
  readonly at: string;
  readonly point: Point;
  readonly pointKey: string;
  readonly pips: number;
  readonly resources: readonly Resource[];
  readonly numbers: readonly number[];
  readonly hexIndices: readonly number[];
  readonly hexColonistIds: readonly string[];
  readonly adjacentCornerIndices: readonly number[];
  readonly incidentEdgeIndices: readonly number[];
  readonly port?: PortKind;
  readonly portIndex?: number;
}

export interface TopologyEdge {
  readonly index: number;
  readonly colonistId?: string;
  readonly at: string;
  readonly c1: number;
  readonly c2: number;
  readonly cornerAtPair: readonly [string, string];
  readonly pairKey: string;
  readonly points: readonly [Point, Point];
  readonly hexIndices: readonly number[];
}

export interface TopologyPort {
  readonly index: number;
  readonly colonistId?: string;
  readonly at: string;
  readonly kind: PortKind;
  readonly edgeIndex?: number;
  readonly cornerIndices: readonly [number, number];
}

export interface BoardVariantMetadata {
  readonly hexCount: number;
  readonly cornerCount: number;
  readonly edgeCount: number;
  readonly portCount: number;
  /** True only when the board has the standard 19-hex, 54-corner, 72-edge Catan base-map geometry. */
  readonly isStandard19Hex: boolean;
}

export interface BoardTopology {
  readonly board: Board;
  readonly variant: BoardVariantMetadata;
  readonly colonistIdsSource: "board" | "standard-19-hex" | "none";
  readonly hexes: readonly TopologyHex[];
  readonly corners: readonly TopologyCorner[];
  readonly edges: readonly TopologyEdge[];
  readonly ports: readonly TopologyPort[];
  readonly hexIndexByColonistId: ReadonlyMap<string, number>;
  readonly colonistIdByHexIndex: readonly string[];
  readonly hexIndexByCoord: ReadonlyMap<string, number>;
  readonly hexIndicesByDiceNumber: ReadonlyMap<number, readonly number[]>;
  readonly cornerIndexByAt: ReadonlyMap<string, number>;
  readonly cornerIndexByPointKey: ReadonlyMap<string, number>;
  readonly cornerIndexByColonistId: ReadonlyMap<string, number>;
  readonly colonistIdByCornerIndex: readonly (string | undefined)[];
  readonly edgeIndexByAt: ReadonlyMap<string, number>;
  readonly edgeIndexByPairKey: ReadonlyMap<string, number>;
  readonly edgeIndexByCornerPair: ReadonlyMap<string, number>;
  readonly edgeIndexByColonistId: ReadonlyMap<string, number>;
  readonly colonistIdByEdgeIndex: readonly (string | undefined)[];
  edgeIndexBetweenCorners(c1: number, c2: number): number | undefined;
  otherCornerOfEdge(edgeIndex: number, cornerIndex: number): number | undefined;
}

const pairAt = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pairIdx = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

const topologyCache = new WeakMap<Board, BoardTopology>();

export function getBoardTopology(board: Board): BoardTopology {
  const cached = topologyCache.get(board);
  if (cached) return cached;
  const built = buildBoardTopology(board);
  topologyCache.set(board, built);
  return built;
}

export function buildBoardTopology(board: Board): BoardTopology {
  const rawCorners = boardCorners(board);
  const hexIndexByColonistId = new Map<string, number>();
  const colonistIdByHexIndex: string[] = [];
  const hexIndexByCoord = new Map<string, number>();
  const hexIndicesByDiceNumber = new Map<number, number[]>();

  const hexCornerIndices: number[][] = board.hexes.map(() => []);
  const hexEdgeIndices: number[][] = board.hexes.map(() => []);

  for (let i = 0; i < board.hexes.length; i++) {
    const h = board.hexes[i];
    const coordKey = `${h.x},${h.y}`;
    hexIndexByColonistId.set(h.id, i);
    colonistIdByHexIndex.push(h.id);
    hexIndexByCoord.set(coordKey, i);
    if (h.number !== null && h.number >= 2 && h.number <= 12) {
      const list = hexIndicesByDiceNumber.get(h.number) ?? [];
      list.push(i);
      hexIndicesByDiceNumber.set(h.number, list);
    }
  }

  // Determine source of Colonist corner/edge IDs.
  // Only fall back to the standard 19-hex ID table when every corner coordinate matches the standard 54-corner layout.
  const hasBoardIds = Boolean(board.cornerIds && Object.keys(board.cornerIds).length > 0 && board.edgeIds && Object.keys(board.edgeIds).length > 0);
  const isStandard54CornerLayout =
    board.hexes.length === 19 &&
    rawCorners.length === 54 &&
    rawCorners.every((c) => Object.values(STANDARD_COLONIST_CORNER_AT_BY_ID).includes(c.at));
  const cornerAtToColonistId = new Map<string, string>();
  const edgeAtToColonistId = new Map<string, string>();
  const portAtToColonistId = new Map<string, string>();

  if (hasBoardIds) {
    for (const [id, at] of Object.entries(board.cornerIds!)) cornerAtToColonistId.set(at, id);
    for (const [id, at] of Object.entries(board.edgeIds!)) edgeAtToColonistId.set(at, id);
    for (const [id, at] of Object.entries(board.portIds ?? {})) portAtToColonistId.set(at, id);
  } else if (isStandard54CornerLayout) {
    for (const [id, at] of Object.entries(STANDARD_COLONIST_CORNER_AT_BY_ID)) cornerAtToColonistId.set(at, id);
    for (const [id, at] of Object.entries(STANDARD_COLONIST_EDGE_AT_BY_ID)) edgeAtToColonistId.set(at, id);
  }

  const cornerIndexByAt = new Map<string, number>();
  const cornerIndexByPointKey = new Map<string, number>();
  const cornerIndexByColonistId = new Map<string, number>();
  const colonistIdByCornerIndex: Array<string | undefined> = [];

  const cornerNeighbors: number[][] = rawCorners.map(() => []);
  const cornerEdges: number[][] = rawCorners.map(() => []);
  const cornerPortIndex: Array<number | undefined> = rawCorners.map(() => undefined);

  for (let i = 0; i < rawCorners.length; i++) {
    const c = rawCorners[i];
    const pk = pointKey(c.point);
    const colId = cornerAtToColonistId.get(c.at);
    cornerIndexByAt.set(c.at, i);
    cornerIndexByPointKey.set(pk, i);
    if (colId !== undefined) cornerIndexByColonistId.set(colId, i);
    colonistIdByCornerIndex.push(colId);
  }

  // Populate hexCornerIndices in exact 6-vertex order around each hex
  for (let hi = 0; hi < board.hexes.length; hi++) {
    const h = board.hexes[hi];
    for (const at of hexCornerIds(h.x, h.y)) {
      const pt = cornerPoint(at);
      const ci = cornerIndexByAt.get(at) ?? (pt ? cornerIndexByPointKey.get(pointKey(pt)) : undefined);
      if (ci !== undefined && !hexCornerIndices[hi].includes(ci)) {
        hexCornerIndices[hi].push(ci);
      }
    }
  }

  // Discover all board edges connecting corners of the land hexes
  const landCoords = new Set(board.hexes.map((h) => `${h.x},${h.y}`));
  const searchCoords = [...landCoords];
  for (const key of landCoords) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of [
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
      [1, 0],
      [1, -1]
    ]) {
      const nk = `${x + dx},${y + dy}`;
      if (!landCoords.has(nk) && !searchCoords.includes(nk)) searchCoords.push(nk);
    }
  }

  const discoveredEdges = new Map<
    string,
    {
      at: string;
      c1: number;
      c2: number;
      points: [Point, Point];
    }
  >();

  for (const key of searchCoords) {
    const [x, y] = key.split(",").map(Number);
    for (const z of [0, 1, 2]) {
      const at = `${x},${y},${z}`;
      const pts = edgePoints(at);
      if (!pts) continue;
      const ca = cornerIndexByPointKey.get(pointKey(pts[0]));
      const cb = cornerIndexByPointKey.get(pointKey(pts[1]));
      if (ca === undefined || cb === undefined || ca === cb) continue;
      const c1 = Math.min(ca, cb);
      const c2 = Math.max(ca, cb);
      const pk = pairIdx(c1, c2);
      const prev = discoveredEdges.get(pk);
      if (!prev || (landCoords.has(key) && !landCoords.has(prev.at.split(",").slice(0, 2).join(",")))) {
        discoveredEdges.set(pk, { at, c1, c2, points: pts });
      }
    }
  }

  const edgeIndexByAt = new Map<string, number>();
  const edgeIndexByPairKey = new Map<string, number>();
  const edgeIndexByCornerPair = new Map<string, number>();
  const edgeIndexByColonistId = new Map<string, number>();
  const colonistIdByEdgeIndex: Array<string | undefined> = [];
  const edges: TopologyEdge[] = [];

  let edgeIdx = 0;
  for (const rawEdge of discoveredEdges.values()) {
    const { at, c1, c2, points } = rawEdge;
    const at1 = rawCorners[c1].at;
    const at2 = rawCorners[c2].at;
    const pk = pairAt(at1, at2);
    const cpk = pairIdx(c1, c2);
    const colId = edgeAtToColonistId.get(at);

    // Find land hexes that share both c1 and c2
    const touchingHexes: number[] = [];
    for (let hi = 0; hi < board.hexes.length; hi++) {
      if (hexCornerIndices[hi].includes(c1) && hexCornerIndices[hi].includes(c2)) {
        touchingHexes.push(hi);
        if (!hexEdgeIndices[hi].includes(edgeIdx)) hexEdgeIndices[hi].push(edgeIdx);
      }
    }

    cornerNeighbors[c1].push(c2);
    cornerEdges[c1].push(edgeIdx);
    cornerNeighbors[c2].push(c1);
    cornerEdges[c2].push(edgeIdx);

    edgeIndexByAt.set(at, edgeIdx);
    edgeIndexByPairKey.set(pk, edgeIdx);
    edgeIndexByCornerPair.set(cpk, edgeIdx);
    if (colId !== undefined) edgeIndexByColonistId.set(colId, edgeIdx);
    colonistIdByEdgeIndex.push(colId);

    edges.push({
      index: edgeIdx,
      colonistId: colId,
      at,
      c1,
      c2,
      cornerAtPair: [at1, at2],
      pairKey: pk,
      points,
      hexIndices: touchingHexes
    });
    edgeIdx++;
  }

  const ports: TopologyPort[] = [];
  for (let pi = 0; pi < (board.ports ?? []).length; pi++) {
    const rawPort = board.ports![pi];
    const pts = edgePoints(rawPort.at);
    if (!pts) continue;
    const ca = cornerIndexByPointKey.get(pointKey(pts[0]));
    const cb = cornerIndexByPointKey.get(pointKey(pts[1]));
    if (ca === undefined || cb === undefined || ca === cb) continue;
    const c1 = Math.min(ca, cb);
    const c2 = Math.max(ca, cb);
    const eIdx = edgeIndexByCornerPair.get(pairIdx(c1, c2)) ?? edgeIndexByAt.get(rawPort.at);
    const colId = portAtToColonistId.get(rawPort.at);
    const portIndex = ports.length;
    cornerPortIndex[c1] = portIndex;
    cornerPortIndex[c2] = portIndex;
    ports.push({
      index: portIndex,
      colonistId: colId,
      at: rawPort.at,
      kind: rawPort.kind,
      edgeIndex: eIdx,
      cornerIndices: [c1, c2]
    });
  }

  const corners: TopologyCorner[] = rawCorners.map((c, i) => {
    const hexIndices = c.hexIds
      .map((hid) => hexIndexByColonistId.get(hid))
      .filter((idx): idx is number => idx !== undefined);
    return {
      index: i,
      colonistId: colonistIdByCornerIndex[i],
      at: c.at,
      point: c.point,
      pointKey: pointKey(c.point),
      pips: c.pips,
      resources: [...c.resources],
      numbers: [...c.numbers],
      hexIndices,
      hexColonistIds: [...c.hexIds],
      adjacentCornerIndices: cornerNeighbors[i],
      incidentEdgeIndices: cornerEdges[i],
      port: c.port,
      portIndex: cornerPortIndex[i]
    };
  });

  const hexes: TopologyHex[] = board.hexes.map((h, i) => ({
    index: i,
    colonistId: h.id,
    coordKey: `${h.x},${h.y}`,
    x: h.x,
    y: h.y,
    resource: h.resource,
    number: h.number,
    pips: pips(h.number),
    cornerIndices: hexCornerIndices[i],
    edgeIndices: hexEdgeIndices[i]
  }));

  const colonistIdsSource: "board" | "standard-19-hex" | "none" = hasBoardIds
    ? "board"
    : cornerIndexByColonistId.size > 0 && edgeIndexByColonistId.size > 0
      ? "standard-19-hex"
      : "none";

  const variant: BoardVariantMetadata = {
    hexCount: hexes.length,
    cornerCount: corners.length,
    edgeCount: edges.length,
    portCount: ports.length,
    isStandard19Hex: hexes.length === 19 && corners.length === 54 && edges.length === 72
  };

  const built: BoardTopology = {
    board,
    variant,
    colonistIdsSource,
    hexes,
    corners,
    edges,
    ports,
    hexIndexByColonistId,
    colonistIdByHexIndex,
    hexIndexByCoord,
    hexIndicesByDiceNumber,
    cornerIndexByAt,
    cornerIndexByPointKey,
    cornerIndexByColonistId,
    colonistIdByCornerIndex,
    edgeIndexByAt,
    edgeIndexByPairKey,
    edgeIndexByCornerPair,
    edgeIndexByColonistId,
    colonistIdByEdgeIndex,
    edgeIndexBetweenCorners(c1: number, c2: number): number | undefined {
      return edgeIndexByCornerPair.get(pairIdx(c1, c2));
    },
    otherCornerOfEdge(edgeIndex: number, cornerIndex: number): number | undefined {
      const e = edges[edgeIndex];
      if (!e) return undefined;
      if (e.c1 === cornerIndex) return e.c2;
      if (e.c2 === cornerIndex) return e.c1;
      return undefined;
    }
  };
  topologyCache.set(board, built);
  return built;
}
