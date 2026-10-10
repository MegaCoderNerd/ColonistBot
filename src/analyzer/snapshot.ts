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
  visibleVp: number;
  hiddenVp: number;
  handSize: number;
  ratios: ResourceBag;
  roadLength: number;
  hasLongestRoad: boolean;
  army: number;
  hasLargestArmy: boolean;
  devsInHand: number;
  unknownDevsInHand: number;
  devsPlayed: number;
  knights: number;
  devCards?: DevCardKind[];
  playableDevCards?: DevCardKind[];
  devsBoughtThisTurn?: DevCardKind[];
  hasUsedDevThisTurn?: boolean;
  settlementsLeft?: number;
  citiesLeft?: number;
  roadsLeft?: number;
  discardLimit?: number;
}

export interface GameSettingsSnapshot {
  id?: string;
  gameType?: number;
  modeSetting?: number;
  extensionSetting?: number;
  scenarioSetting?: number;
  mapSetting?: number;
  diceSetting?: number;
  victoryPointsToWin?: number;
  cardDiscardLimit?: number;
  maxPlayers?: number;
  hideBankCards?: boolean;
  friendlyRobber?: boolean;
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
  gameSettings?: GameSettingsSnapshot;
}

