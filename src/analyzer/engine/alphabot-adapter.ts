/**
 * Boundary in front of Eli Olcott's AlphaBot (MIT, https://github.com/Eli6th/catan-rl).
 *
 * The shipped search and weights stay in that repository. This module does not
 * reimplement them and does not change `baseline_heuristic_v1`. A ColonistBot
 * snapshot is refused until a conversion can be done without inventing hidden
 * cards or renumbering the board by assumption. Board geometry is mapped
 * separately and is not written into AlphaBot's game state.
 */

import type { BoardTopology } from "./topology";
import { mapColonistTopology, type TopologyMappingResult } from "./alphabot-topology";

export const ALPHABOT_REFERENCE = {
  repository: "https://github.com/Eli6th/catan-rl",
  revision: "021279c56834b6203480e5292e1de7246e47bd68",
  copyright: "Copyright (c) 2026 Eli Olcott",
  license: "MIT",
  model: "models/catan-512.ctnn",
  inference: "catan_env::net::MlpNet::load",
  search: "catan_env::alpha::AlphaBot::choose_action",
  documentedSearchConfig: "8,96,300"
} as const;

export interface AlphabotRefusal {
  readonly ok: false;
  readonly usedHiddenOpponentCards: false;
  readonly inventedFields: false;
  readonly reasons: readonly string[];
}

const REFUSAL_REASONS = [
  "A validated topology mapping is not a populated AlphaBot GameState. Occupancy masks, road lengths, port caches and hidden cards are still untouched.",
  "AlphaBot::choose_action always encodes Visibility::Perfect, which includes opponent hand composition and unplayed development cards.",
  "A Colonist observation does not contain those hidden cards. This adapter does not sample or fill them.",
  "AlphaBot's simulator CLI constructs CatanGame::new. That is 2-4 players, first to 10, fair 2d6, discard when holding more than 7, and no friendly-robber protection. It has no switch for Colonist 1v1 to 15, discard-at-9, or the balanced dice shoe.",
  "Writing a midgame position into AlphaBot's GameState bypasses occupied_mask, port caches, and road-length caches. Doing that safely is an engine port, not a field mapping."
] as const;

export interface AlphabotStateRefusal extends AlphabotRefusal {
  readonly topologyMapping: TopologyMappingResult | null;
}

/** Refuse a full Colonist snapshot. When a topology is supplied, attach only the board mapping. */
export function adaptColonistStateForAlphabot(topology?: BoardTopology): AlphabotStateRefusal {
  return {
    ok: false,
    usedHiddenOpponentCards: false,
    inventedFields: false,
    reasons: REFUSAL_REASONS,
    topologyMapping: topology ? mapColonistTopology(topology) : null
  };
}

/** Keep a translated action only when it is one of the engine's legal actions. */
export function acceptMappedAction<T>(candidate: T, legal: readonly T[], same: (left: T, right: T) => boolean): T | null {
  return legal.find((action) => same(action, candidate)) ?? null;
}
