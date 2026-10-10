// Recovered from content.js (lines 4950-4957)
// [RECONSTRUCTED TYPE DECLARATIONS]
import type { DevCardKind, Resource, ResourceBag } from "./types";

export const RESOURCE_BY_ID: Record<number, Resource> = {
  1: "lumber",
  2: "brick",
  3: "wool",
  4: "grain",
  5: "ore"
};

export interface PlayerSnapshot {
  id: string;
  vp: number;
  handSize: number;
  ratios: ResourceBag;
  roadLength: number;
  hasLongestRoad: boolean;
  army: number;
  hasLargestArmy: boolean;
  devsInHand: number;
  devsPlayed: number;
  knights: number;
  devCards?: DevCardKind[];
  settlementsLeft?: number;
  citiesLeft?: number;
  roadsLeft?: number;
  discardLimit?: number;
}

export interface GameSnapshot {
  players: PlayerSnapshot[];
  bank?: ResourceBag;
  dice?: { thrown: boolean; d1?: number; d2?: number };
  turnPlayer?: string;
  turnState?: number;
  actionState?: number;
  completedTurns?: number;
  robberHex?: string;
}
