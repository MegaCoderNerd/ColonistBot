// Recovered from content.js (lines 491-499)
// [RECONSTRUCTED TYPE DECLARATIONS]

export interface GameRules {
  victoryPoints: number;
  discardLimit: number;
  friendlyRobber: boolean;
  friendlyRobberMaxVp: number;
  balancedDice: boolean;
  hiddenBank: boolean;
}

export const COLONIST_1V1_RULES: GameRules = {
  victoryPoints: 15,
  discardLimit: 9,
  friendlyRobber: true,
  friendlyRobberMaxVp: 2,
  balancedDice: true,
  hiddenBank: true
};
