// Recovered from content.js (L5-L16)
export const SEL = {
  /** Each game-log / chat row in the virtual scroller carries a running index. */
  rowIndexAttr: "data-index",
  playerPanel: "[data-player-information-container]",
  playerBlock: "[data-player-color]",
  cardCount: "[data-resource-card]",
  strongName: 'span[style*="font-weight:600"], span[style*="font-weight: 600"]',
  headerUsername: ".web-header-username"
};

export const END_TABS = ["Overview", "Dice Stats", "Res Card Stats", "Dev Card Stats", "Activity Stats", "Resource Stats"] as const;

// [RECONSTRUCTED TYPE DECLARATION]
export type EndTab = (typeof END_TABS)[number];
