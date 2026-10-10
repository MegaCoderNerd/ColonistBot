// Recovered from content.js (lines 324-326)
// [RECONSTRUCTED TYPE DECLARATIONS — erased by esbuild during bundling]

export const RESOURCES = ["lumber", "brick", "wool", "grain", "ore"] as const;
export type Resource = (typeof RESOURCES)[number];
export type ResourceHand = Record<Resource, number>;
export type ResourceBag = Partial<Record<Resource, number>>;

export type DevCardKind = "knight" | "yearOfPlenty" | "monopoly" | "roadBuilding" | "victoryPoint" | "unknown";
export type PortKind = "any" | Resource;
export type PieceKind = "road" | "settlement" | "city";

export interface HexTile {
  id: string;
  x: number;
  y: number;
  resource: Resource | null;
  number: number | null;
}

export interface PortEdge {
  at: string;
  kind: PortKind;
}

export interface Board {
  hexes: HexTile[];
  ports?: PortEdge[];
  robberStart?: string;
}

export interface PlayerInfo {
  id: string;
  color?: number;
  name: string;
}

export type GameEventDraft =
  | { type: "roll"; player?: string; d1?: number; d2?: number; total: number }
  | { type: "gain"; player: string; cards: ResourceBag; source?: "roll" | "other" }
  | { type: "build"; player: string; piece: PieceKind; at?: string; setup: boolean; free?: boolean }
  | { type: "devBuy"; player: string }
  | { type: "devPlay"; player: string; card: DevCardKind }
  | { type: "robberMove"; player: string; hex?: string }
  | { type: "steal"; player: string; victim?: string; card?: Resource }
  | { type: "monopoly"; player: string; cards: ResourceBag }
  | { type: "bankTrade"; player: string; gave: ResourceBag; got: ResourceBag }
  | { type: "trade"; player: string; partner?: string; gave: ResourceBag; got: ResourceBag }
  | { type: "discard"; player: string; cards: ResourceBag }
  | { type: "longestRoad"; player: string }
  | { type: "largestArmy"; player: string }
  | { type: "hand"; player: string; size: number }
  | { type: "vp"; player: string; vp: number }
  | { type: "gameEnd"; winner: string };

export type GameEvent = GameEventDraft & {
  t: number;
  turn: number;
};

export interface Placements {
  settlements: Map<string, string>;
  cities: Map<string, string>;
  roads: Map<string, string>;
}
