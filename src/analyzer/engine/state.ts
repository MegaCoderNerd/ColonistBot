import { publicVp } from "../advisor";
import type { GameSnapshot, PlayerSnapshot } from "../snapshot";
import type { PlayerHandView } from "../tracker";
import { RESOURCES, type Board, type DevCardKind, type GameEvent, type Placements, type Resource, type ResourceHand } from "../types";
import { bagAligned, readTable, type TableRead } from "./read";
import { longestRoad } from "./roads";
import { getBoardTopology, type BoardTopology } from "./topology";

export type ActionDevCardKind = "knight" | "roadBuilding" | "yearOfPlenty" | "monopoly";
export type ConcreteDevCardKind = ActionDevCardKind | "victoryPoint";

export const STANDARD_DEV_DECK_COUNTS: Readonly<Record<ConcreteDevCardKind, number>> = {
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2
};

export const BANK_RESOURCE_CAP = 19;
export const MAX_SETTLEMENTS = 5;
export const MAX_CITIES = 4;
export const MAX_ROADS = 15;

/**
 * Verified Colonist wire-protocol turn/action phases.
 * Unrecognized numeric `(turnState, actionState)` combinations are mapped to `"unknown"`
 * with `phaseConfidence: "unrecognized"` rather than silently defaulting to `"main"`.
 */
export type ObservedTurnPhase =
  | "setup_waiting"
  | "setup_settlement"
  | "setup_road"
  | "pre_roll"
  | "discard"
  | "robber_move"
  | "main"
  | "road_building_1"
  | "road_building_2"
  | "year_of_plenty"
  | "monopoly"
  | "game_over"
  | "unknown";

export type ConcreteTurnPhase = Exclude<ObservedTurnPhase, "unknown">;

export interface ObservedResourceHand {
  /**
   * Non-null ONLY when every card in the player's hand is directly observed in the authoritative state
   * (e.g., self hand from `playerStates[self].resourceCards` or an authoritative empty hand `handSize === 0`).
   * Inferences from `HandTracker` or `TableRead` are NEVER promoted into `exact`.
   */
  readonly exact: ResourceHand | null;
  /** Inferred or confirmed minimum count of each resource in hand. */
  readonly knownMin: ResourceHand;
  /** Maximum possible count of each resource in hand given handSize and known bank/other-player bounds. */
  readonly maxPossible: ResourceHand;
  /** Best ledger estimate of cards in hand from observed/inferred history. */
  readonly likely: ResourceHand;
  /** Total resource cards in hand. */
  readonly handSize: number;
  /** Number of cards in hand whose resource identity is unconfirmed. */
  readonly unknownCount: number;
  readonly confidence: "exact" | "bounded" | "count_only" | "untracked";
  /** Explicit provenance distinguishing directly observed hands from log/event inferences. */
  readonly inferenceSource: "authoritative" | "hand_tracker" | "table_read" | "none";
}

export interface ObservedDevState {
  readonly totalInHand: number;
  /** Confirmed playable action dev cards bought on a prior turn. */
  readonly readyActionDevs: readonly ActionDevCardKind[];
  /** Confirmed action dev cards bought on the current turn (ineligible to play this turn). */
  readonly boughtActionDevsThisTurn: readonly ActionDevCardKind[];
  /** Confirmed Victory Point dev cards in hand. */
  readonly confirmedVpDevs: number;
  /** Face-down (ID 10) dev cards in hand whose faces are unknown to the observer. */
  readonly unknownInHand: number;
  /** Subset of unknownInHand bought on the current turn (ineligible to play this turn). */
  readonly unknownBoughtThisTurn: number;
  /** Subset of unknownInHand bought on a previous turn that could be played this turn if not yet used. */
  readonly unknownPlayableNow: number;
  readonly playedCards: readonly DevCardKind[];
  readonly playedCount: number;
  readonly knightsPlayed: number;
  readonly hasUsedDevThisTurn: boolean;
  readonly confidence: "exact" | "partial_unknown_faces" | "inferred_from_events";
}

export interface ObservedVpBreakdown {
  readonly settlementsVp: number;
  readonly citiesVp: number;
  readonly longestRoadVp: number;
  readonly largestArmyVp: number;
  /** Publicly visible VP on the board and public award plaques. */
  readonly visibleVp: number;
  /** Hidden VP dev cards confirmed to the observer (own VP cards, or revealed at game end). */
  readonly confirmedHiddenVp: number;
  /** Sum of visibleVp + confirmedHiddenVp. Never includes sampled or guessed opponent hidden VP. */
  readonly totalConfirmedVp: number;
  /** Upper bound on additional unrevealed VP dev cards this player could hold given unknownInHand and unseen VP cards. */
  readonly maxUnrevealedVpDevs: number;
  /** Upper bound on actual VP: totalConfirmedVp + maxUnrevealedVpDevs. */
  readonly maxPossibleVp: number;
}

/**
 * Imperfect prior metadata about a player (such as rank, rating, or prior match history).
 * Treated strictly as uncertain prior evidence (`priorConfidence: "imperfect_prior"`),
 * never as a definitive classification of how an opponent plays in the current game.
 */
export interface OpponentPriorEvidence {
  readonly rankTier?: string;
  readonly rating?: number;
  readonly historicalMatchesObserved?: number;
  readonly priorConfidence: "imperfect_prior";
}

/**
 * Observed in-game behavioral telemetry for a single player.
 * Reserved as a clean data-collection boundary for future adaptive opponent modeling
 * (expansion vs. development priority, trade frequency, robber aggression) without coupling
 * Stage 3.1 state reconstruction to any machine-learning model.
 */
export interface ObservedPlayerBehaviorTelemetry {
  readonly settlementsBuilt: number;
  readonly citiesBuilt: number;
  readonly roadsBuilt: number;
  readonly devsBought: number;
  readonly devsPlayed: number;
  readonly knightsPlayed: number;
  readonly robberMoves: number;
  readonly bankTradesCount: number;
  readonly playerTradesCount: number;
  readonly monopoliesPlayed: number;
  readonly prior?: OpponentPriorEvidence;
}

/**
 * Observed trade event record captured from match history.
 */
export interface ObservedTradeRecord {
  readonly kind: "player_trade" | "bank_trade";
  readonly proposerId: string;
  readonly partnerId?: string;
  readonly gave: Partial<Record<Resource, number>>;
  readonly got: Partial<Record<Resource, number>>;
  readonly turn: number;
}

/**
 * Reserved boundary interface for future multi-player trade evaluation and negotiation advice.
 * Keeps enforceable game-state resource transfers (`gave`, `got`) strictly separate from:
 * - inferred opponent acceptance probability (`acceptanceProbability`, `acceptanceConfidence`),
 * - non-binding verbal table-talk / conditional deals (`nonBindingVerbalCondition`, which are NOT enforceable game actions),
 * - and advisory chat message drafting (`advisoryMessageDraft`).
 */
export interface ProspectiveTradeEvaluationBoundary {
  readonly proposerId: string;
  readonly recipientId: string;
  readonly gave: Partial<Record<Resource, number>>;
  readonly got: Partial<Record<Resource, number>>;
  readonly selfExpectedValueDelta?: number;
  readonly recipientInferredValueDelta?: number;
  readonly leaderDangerPenalty?: number;
  readonly acceptanceProbability?: number;
  readonly acceptanceConfidence?: "inferred_prior" | "inferred_from_match" | "unverified";
  readonly nonBindingVerbalCondition?: {
    readonly description: string;
    readonly enforceableByRulesEngine: false;
  };
  readonly advisoryMessageDraft?: string;
}

export interface ObservedPlayerState {
  readonly id: string;
  readonly seatIndex: number;
  readonly name?: string;
  readonly color?: number;
  readonly isSelf: boolean;
  readonly settlementCorners: readonly number[];
  readonly cityCorners: readonly number[];
  readonly roadEdges: readonly number[];
  readonly productionPips: ResourceHand;
  readonly ratios: ResourceHand;
  readonly ratiosConfidence: "authoritative" | "derived_from_ports";
  readonly supplies: {
    readonly settlementsLeft: number;
    readonly citiesLeft: number;
    readonly roadsLeft: number;
    readonly confidence: "authoritative" | "derived_from_placements" | "partial_midgame";
  };
  readonly hand: ObservedResourceHand;
  readonly devs: ObservedDevState;
  readonly awards: {
    readonly hasLongestRoad: boolean;
    readonly hasLargestArmy: boolean;
    readonly roadLength: number;
    readonly computedRoadLength: number;
    readonly armySize: number;
  };
  readonly vp: ObservedVpBreakdown;
  readonly pendingDiscardCount: number;
  readonly behavior: ObservedPlayerBehaviorTelemetry;
}

export interface ObservedBankState {
  /** Exact bank resource counts when known; null when hidden by gameSettings.hideBankCards and not derivable. */
  readonly resources: ResourceHand | null;
  readonly totalResourcesLeft: number | null;
  readonly confidence: "exact" | "derived_from_exact_hands" | "hidden_by_settings" | "unknown";
}

export interface ObservedDevDeckState {
  readonly bankRemaining: number;
  readonly bankRemainingConfidence: "authoritative" | "derived_from_25_deck" | "unknown";
  /**
   * Remaining copies of each dev card type not yet publicly played or confirmed in a player's hand.
   * When full history is available on a standard 25-card deck,
   * sum(unseenPool) === bankRemaining + sum_{p in players}(p.devs.unknownInHand).
   */
  readonly unseenPool: Record<ConcreteDevCardKind, number>;
  readonly unseenTotal: number;
}

export interface ObservedRulesState {
  readonly maxPlayers: { readonly value: number; readonly source: "authoritative" | "observed_players" | "default" };
  readonly victoryPointsToWin: { readonly value: number; readonly source: "authoritative" | "default" };
  readonly cardDiscardLimit: { readonly value: number; readonly source: "authoritative" | "player_state" | "default" };
  readonly friendlyRobber: { readonly value: boolean; readonly minVisibleVp: number; readonly source: "authoritative" | "default" };
  readonly hideBankCards: { readonly value: boolean; readonly source: "authoritative" | "default" };
  readonly diceMode: {
    readonly setting?: number;
    readonly mode: "balanced" | "random" | "unknown";
    readonly source: "authoritative" | "unknown";
  };
  readonly extensionSetting?: number;
  readonly mapSetting?: number;
}

export interface ObservedDiceState {
  readonly thrown: boolean;
  readonly d1?: number;
  readonly d2?: number;
  readonly total?: number;
  readonly observedRolls: ReadonlyArray<{ total: number; d1?: number; d2?: number; player?: string }>;
  readonly completedTurns?: number;
  readonly alignmentStatus: "aligned" | "misaligned_midgame" | "unknown";
  /**
   * Explicitly records that even when aligned with roll history, the client-side balanced-dice model
   * is an approximate heuristic and not an exact server-side probability distribution.
   */
  readonly distributionConfidence: "approximate_heuristic" | "unaligned_prior";
}

export interface StateProvenance {
  readonly fullGameFromStart: boolean;
  readonly hasSnapshot: boolean;
  readonly warnings: readonly string[];
}

export interface ObservedGameState {
  readonly kind: "observed";
  readonly topology: BoardTopology;
  readonly cornerOwner: Array<string | null>;
  readonly cornerPiece: Uint8Array; // 0 = empty, 1 = settlement, 2 = city
  readonly edgeOwner: Array<string | null>;
  readonly robberHexIndex: number | null;
  readonly robberHexId?: string;
  readonly robberConfidence: "authoritative" | "events" | "board_default" | "unknown";
  /** Player states in deterministic seat order (structurally supports 2–6 players; validated on 2-player 1v1). */
  readonly players: readonly ObservedPlayerState[];
  /** Ordered player IDs matching `players.map(p => p.id)`. */
  readonly playerOrder: readonly string[];
  readonly playerById: Readonly<Record<string, ObservedPlayerState>>;
  readonly selfId?: string;
  readonly turnPlayerId?: string;
  readonly turnPlayerIndex?: number;
  readonly phase: ObservedTurnPhase;
  readonly phaseConfidence: "authoritative" | "inferred_from_events" | "unrecognized" | "missing";
  readonly rawTurnState?: number;
  readonly rawActionState?: number;
  readonly dice: ObservedDiceState;
  readonly bank: ObservedBankState;
  readonly devDeck: ObservedDevDeckState;
  readonly rules: ObservedRulesState;
  readonly observedTrades: readonly ObservedTradeRecord[];
  readonly provenance: StateProvenance;
}

/**
 * Concrete, fully determined state used ONLY inside a single rollout simulation trial
 * after sampling unknown opponent resources and face-down development cards.
 * Kept strictly separate from `ObservedGameState` so sampled hidden VP or sampled cards
 * can never be mistaken for confirmed live information in the coach overlay.
 */
export interface ConcreteSimulatedPlayerState {
  id: string;
  seatIndex?: number;
  hand: ResourceHand;
  ratios: ResourceHand;
  settlementsLeft: number;
  citiesLeft: number;
  roadsLeft: number;
  readyDevs: ActionDevCardKind[];
  boughtDevsThisTurn: ActionDevCardKind[];
  vpDevs: number;
  playedDevs: DevCardKind[];
  knightsPlayed: number;
  hasUsedDevThisTurn: boolean;
  hasLongestRoad: boolean;
  hasLargestArmy: boolean;
  roadLength: number;
  visibleVp: number;
  /** Visible VP + confirmed hidden VP from the observer's perspective before sampling. */
  observedConfirmedVp: number;
  /** Actual VP inside this simulation trial: visibleVp + vpDevs (includes sampled VP dev cards). */
  actualSimulatedVp: number;
  pendingDiscardCount: number;
}

export interface ConcreteSimulatedGameState {
  kind: "simulated";
  topology: BoardTopology;
  cornerOwner: Array<string | null>;
  cornerPiece: Uint8Array;
  edgeOwner: Array<string | null>;
  robberHexIndex: number;
  bank: ResourceHand;
  devDeckOrder: ConcreteDevCardKind[];
  /** Player states in seat order (structurally supports 2–6 players; currently validated on 2-player 1v1). */
  players: ConcreteSimulatedPlayerState[];
  playerOrder?: string[];
  turnPlayerIndex: number;
  phase: ConcreteTurnPhase;
  completedTurns: number;
  dice: { thrown: boolean; d1?: number; d2?: number; total?: number };
  rules: {
    victoryPointsToWin: number;
    cardDiscardLimit: number;
    friendlyRobber: boolean;
    friendlyRobberMinVisibleVp: number;
    diceMode: "balanced" | "random";
  };
  winnerId?: string;
}

export interface ObservedStateInput {
  board: Board;
  placements: Placements;
  snapshot?: GameSnapshot;
  events?: GameEvent[];
  players?: ReadonlyArray<{ id: string; name?: string; color?: number }>;
  selfId?: string;
  selfHand?: ResourceHand;
  selfHandKnown?: boolean;
  /** 1v1 convenience input for a single opponent's tracked hand view. */
  oppHandView?: PlayerHandView;
  /** Multi-player compatible map of tracked hand views keyed by player ID or player name. */
  handViewsByPlayer?: Readonly<Record<string, PlayerHandView>>;
  /** Optional imperfect prior evidence (e.g. rank/rating/history) keyed by player ID. */
  opponentPriorsByPlayer?: Readonly<Record<string, OpponentPriorEvidence>>;
  tableRead?: TableRead;
  warnings?: string[];
}

export interface StateValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const emptyHand = (): ResourceHand => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const sumHand = (h: ResourceHand): number => RESOURCES.reduce((s, r) => s + h[r], 0);

function isActionDev(c: DevCardKind): c is ActionDevCardKind {
  return c === "knight" || c === "roadBuilding" || c === "yearOfPlenty" || c === "monopoly";
}

function isConcreteDev(c: DevCardKind): c is ConcreteDevCardKind {
  return isActionDev(c) || c === "victoryPoint";
}

export function classifyTurnPhase(
  turnState: number | undefined,
  actionState: number | undefined,
  events?: GameEvent[]
): { phase: ObservedTurnPhase; confidence: ObservedGameState["phaseConfidence"] } {
  if (turnState !== undefined) {
    if (turnState === 3) return { phase: "game_over", confidence: "authoritative" };
    if (turnState === 0) {
      if (actionState === 0 || actionState === undefined) return { phase: "setup_waiting", confidence: "authoritative" };
      if (actionState === 1) return { phase: "setup_settlement", confidence: "authoritative" };
      if (actionState === 3) return { phase: "setup_road", confidence: "authoritative" };
      return { phase: "unknown", confidence: "unrecognized" };
    }
    if (turnState === 1) {
      if (actionState === 0 || actionState === undefined) return { phase: "pre_roll", confidence: "authoritative" };
      if (actionState === 24) return { phase: "robber_move", confidence: "authoritative" };
      if (actionState === 28) return { phase: "discard", confidence: "authoritative" };
      if (actionState === 30) return { phase: "road_building_1", confidence: "authoritative" };
      if (actionState === 31) return { phase: "road_building_2", confidence: "authoritative" };
      if (actionState === 32) return { phase: "year_of_plenty", confidence: "authoritative" };
      if (actionState === 33) return { phase: "monopoly", confidence: "authoritative" };
      return { phase: "unknown", confidence: "unrecognized" };
    }
    if (turnState === 2) {
      if (actionState === undefined || actionState === 0 || actionState === 1 || actionState === 3 || actionState === 4 || actionState === 6 || actionState === 7) {
        return { phase: "main", confidence: "authoritative" };
      }
      if (actionState === 24) return { phase: "robber_move", confidence: "authoritative" };
      if (actionState === 30) return { phase: "road_building_1", confidence: "authoritative" };
      if (actionState === 31) return { phase: "road_building_2", confidence: "authoritative" };
      if (actionState === 32) return { phase: "year_of_plenty", confidence: "authoritative" };
      if (actionState === 33) return { phase: "monopoly", confidence: "authoritative" };
      return { phase: "unknown", confidence: "unrecognized" };
    }
    return { phase: "unknown", confidence: "unrecognized" };
  }

  if (events && events.length > 0) {
    const last = events[events.length - 1];
    if (last.type === "gameEnd") return { phase: "game_over", confidence: "inferred_from_events" };
    const hasRolls = events.some((e) => e.type === "roll");
    if (!hasRolls) return { phase: "setup_settlement", confidence: "inferred_from_events" };
    return { phase: "main", confidence: "inferred_from_events" };
  }

  return { phase: "unknown", confidence: "missing" };
}

export function computeRoadLengthOnTopology(
  topology: BoardTopology,
  cornerOwner: Array<string | null>,
  edgeOwner: Array<string | null>,
  playerId: string
): number {
  const graph = new Map<string, Set<string>>();
  for (let ei = 0; ei < topology.edges.length; ei++) {
    if (edgeOwner[ei] !== playerId) continue;
    const edge = topology.edges[ei];
    const [a, b] = edge.cornerAtPair;
    const setA = graph.get(a) ?? new Set<string>();
    setA.add(b);
    graph.set(a, setA);
    const setB = graph.get(b) ?? new Set<string>();
    setB.add(a);
    graph.set(b, setB);
  }
  if (graph.size === 0) return 0;
  const blocked = new Set<string>();
  for (let ci = 0; ci < topology.corners.length; ci++) {
    const owner = cornerOwner[ci];
    if (owner && owner !== playerId) blocked.add(topology.corners[ci].at);
  }
  return longestRoad(graph, blocked).len;
}

export function buildObservedGameState(input: ObservedStateInput): ObservedGameState {
  const topology = getBoardTopology(input.board);
  const warnings = [...(input.warnings ?? [])];
  const fullGameFromStart = !warnings.some((w) => /start mid-game/i.test(w));

  const cornerOwner = new Array<string | null>(topology.corners.length).fill(null);
  const cornerPiece = new Uint8Array(topology.corners.length);
  const edgeOwner = new Array<string | null>(topology.edges.length).fill(null);

  for (const [at, owner] of input.placements.settlements) {
    const idx = topology.cornerIndexByAt.get(at);
    if (idx !== undefined) {
      cornerOwner[idx] = owner;
      cornerPiece[idx] = 1;
    } else {
      warnings.push(`Unmapped settlement coordinate: ${at}`);
    }
  }
  for (const [at, owner] of input.placements.cities) {
    const idx = topology.cornerIndexByAt.get(at);
    if (idx !== undefined) {
      cornerOwner[idx] = owner;
      cornerPiece[idx] = 2;
    } else {
      warnings.push(`Unmapped city coordinate: ${at}`);
    }
  }
  for (const [at, owner] of input.placements.roads) {
    const idx = topology.edgeIndexByAt.get(at);
    if (idx !== undefined) {
      edgeOwner[idx] = owner;
    } else {
      warnings.push(`Unmapped road coordinate: ${at}`);
    }
  }

  // Discover all participating player IDs in deterministic seat order (supports 2–6 players structurally)
  const discoveredIds: string[] = [];
  const playerMetaById = new Map<string, { name?: string; color?: number }>();
  const addPlayerId = (id?: string, meta?: { name?: string; color?: number }) => {
    if (!id) return;
    if (!discoveredIds.includes(id)) discoveredIds.push(id);
    if (meta) {
      const prev = playerMetaById.get(id);
      playerMetaById.set(id, {
        name: meta.name ?? prev?.name,
        color: meta.color ?? prev?.color
      });
    }
  };
  for (const p of input.players ?? []) addPlayerId(p.id, { name: p.name, color: p.color });
  for (const p of input.snapshot?.players ?? []) addPlayerId(p.id);
  addPlayerId(input.selfId);
  for (const [, owner] of input.placements.settlements) addPlayerId(owner);
  for (const [, owner] of input.placements.cities) addPlayerId(owner);
  for (const [, owner] of input.placements.roads) addPlayerId(owner);
  if (discoveredIds.length === 0) discoveredIds.push("c1", "c2");
  else if (discoveredIds.length === 1) discoveredIds.push(discoveredIds[0] === "c1" ? "c2" : "c1");

  const selfId = input.selfId ?? discoveredIds[0];

  // Compute or reuse TableRead when events are provided
  const snapHandSizes: Record<string, number> = {};
  const snapUnknownDevs: Record<string, number> = {};
  const snapKnights: Record<string, number> = {};
  for (const sp of input.snapshot?.players ?? []) {
    snapHandSizes[sp.id] = sp.handSize;
    snapUnknownDevs[sp.id] = sp.unknownDevsInHand;
    snapKnights[sp.id] = sp.knights;
  }
  const tableRead =
    input.tableRead ??
    (input.events
      ? readTable(input.board, input.events, selfId, {
          handSize: snapHandSizes,
          devsInHand: snapUnknownDevs,
          knights: snapKnights,
          completedTurns: input.snapshot?.completedTurns
        })
      : undefined);

  // Rules & settings reconstruction
  const gs = input.snapshot?.gameSettings;
  const maxPlayers =
    gs?.maxPlayers !== undefined
      ? { value: gs.maxPlayers, source: "authoritative" as const }
      : discoveredIds.length > 2
        ? { value: discoveredIds.length, source: "observed_players" as const }
        : { value: 2, source: "default" as const };

  const vpGoal = gs?.victoryPointsToWin !== undefined
    ? { value: gs.victoryPointsToWin, source: "authoritative" as const }
    : { value: 15, source: "default" as const };

  const playerDiscardLimit = input.snapshot?.players.find((p) => p.discardLimit !== undefined)?.discardLimit;
  const discardLimit = gs?.cardDiscardLimit !== undefined
    ? { value: gs.cardDiscardLimit, source: "authoritative" as const }
    : playerDiscardLimit !== undefined
      ? { value: playerDiscardLimit, source: "player_state" as const }
      : { value: 9, source: "default" as const };

  const friendlyRobber = gs?.friendlyRobber !== undefined
    ? { value: gs.friendlyRobber, minVisibleVp: 3, source: "authoritative" as const }
    : { value: true, minVisibleVp: 3, source: "default" as const };

  const hideBankCards = gs?.hideBankCards !== undefined
    ? { value: gs.hideBankCards, source: "authoritative" as const }
    : { value: false, source: "default" as const };

  const diceMode: ObservedRulesState["diceMode"] =
    gs?.diceSetting === 1
      ? { setting: 1, mode: "balanced", source: "authoritative" }
      : gs?.diceSetting === 0
        ? { setting: 0, mode: "random", source: "authoritative" }
        : { setting: gs?.diceSetting, mode: "unknown", source: "unknown" };

  const rules: ObservedRulesState = {
    maxPlayers,
    victoryPointsToWin: vpGoal,
    cardDiscardLimit: discardLimit,
    friendlyRobber,
    hideBankCards,
    diceMode,
    ...(gs?.extensionSetting !== undefined ? { extensionSetting: gs.extensionSetting } : {}),
    ...(gs?.mapSetting !== undefined ? { mapSetting: gs.mapSetting } : {})
  };

  // Robber location reconstruction
  let robberHexId = input.snapshot?.robberHex;
  let robberConfidence: ObservedGameState["robberConfidence"] = "unknown";
  if (robberHexId !== undefined) {
    robberConfidence = "authoritative";
  } else if (input.events) {
    for (let i = input.events.length - 1; i >= 0; i--) {
      const e = input.events[i];
      if (e.type === "robberMove" && e.hex !== undefined) {
        robberHexId = e.hex;
        robberConfidence = "events";
        break;
      }
    }
  }
  if (robberHexId === undefined && input.board.robberStart !== undefined) {
    robberHexId = input.board.robberStart;
    robberConfidence = "board_default";
  }
  const robberHexIndex = robberHexId !== undefined ? (topology.hexIndexByColonistId.get(robberHexId) ?? null) : null;

  // Turn phase reconstruction
  const { phase, confidence: phaseConfidence } = classifyTurnPhase(
    input.snapshot?.turnState,
    input.snapshot?.actionState,
    input.events
  );

  // Development-card deck accounting across all players
  const unseenPool: Record<ConcreteDevCardKind, number> = { ...STANDARD_DEV_DECK_COUNTS };
  const decUnseen = (card: DevCardKind) => {
    if (isConcreteDev(card) && unseenPool[card] > 0) unseenPool[card]--;
  };

  for (const sp of input.snapshot?.players ?? []) {
    for (const c of sp.devCards ?? []) decUnseen(c);
    for (const c of sp.devsPlayedCards ?? []) decUnseen(c);
  }
  if (!input.snapshot && input.events) {
    for (const e of input.events) {
      if (e.type === "devPlay") decUnseen(e.card);
    }
  }

  const unseenTotal = Object.values(unseenPool).reduce((a, b) => a + b, 0);
  const totalUnknownHeld = (input.snapshot?.players ?? []).reduce((s, p) => s + p.unknownDevsInHand, 0);
  const bankRemaining =
    input.snapshot?.bankDevsLeft !== undefined
      ? input.snapshot.bankDevsLeft
      : Math.max(0, unseenTotal - totalUnknownHeld);
  const bankRemainingConfidence: ObservedDevDeckState["bankRemainingConfidence"] =
    input.snapshot?.bankDevsLeft !== undefined
      ? "authoritative"
      : input.snapshot || input.events
        ? "derived_from_25_deck"
        : "unknown";

  const devDeck: ObservedDevDeckState = {
    bankRemaining,
    bankRemainingConfidence,
    unseenPool,
    unseenTotal
  };

  // Pre-aggregate per-player behavioral telemetry and trade records from observed events
  const observedTrades: ObservedTradeRecord[] = [];
  const behaviorByPlayer = new Map<
    string,
    {
      settlementsBuilt: number;
      citiesBuilt: number;
      roadsBuilt: number;
      devsBought: number;
      devsPlayed: number;
      knightsPlayed: number;
      robberMoves: number;
      bankTradesCount: number;
      playerTradesCount: number;
      monopoliesPlayed: number;
    }
  >();
  const ensureBehavior = (pid: string) => {
    let b = behaviorByPlayer.get(pid);
    if (!b) {
      b = {
        settlementsBuilt: 0,
        citiesBuilt: 0,
        roadsBuilt: 0,
        devsBought: 0,
        devsPlayed: 0,
        knightsPlayed: 0,
        robberMoves: 0,
        bankTradesCount: 0,
        playerTradesCount: 0,
        monopoliesPlayed: 0
      };
      behaviorByPlayer.set(pid, b);
    }
    return b;
  };
  for (const e of input.events ?? []) {
    if (e.type === "build") {
      const b = ensureBehavior(e.player);
      if (e.piece === "settlement") b.settlementsBuilt++;
      else if (e.piece === "city") b.citiesBuilt++;
      else if (e.piece === "road") b.roadsBuilt++;
    } else if (e.type === "devBuy") {
      ensureBehavior(e.player).devsBought++;
    } else if (e.type === "devPlay") {
      const b = ensureBehavior(e.player);
      b.devsPlayed++;
      if (e.card === "knight") b.knightsPlayed++;
      if (e.card === "monopoly") b.monopoliesPlayed++;
    } else if (e.type === "robberMove") {
      ensureBehavior(e.player).robberMoves++;
    } else if (e.type === "bankTrade") {
      ensureBehavior(e.player).bankTradesCount++;
      observedTrades.push({
        kind: "bank_trade",
        proposerId: e.player,
        gave: { ...e.gave },
        got: { ...e.got },
        turn: e.turn
      });
    } else if (e.type === "trade") {
      ensureBehavior(e.player).playerTradesCount++;
      if (e.partner) ensureBehavior(e.partner).playerTradesCount++;
      observedTrades.push({
        kind: "player_trade",
        proposerId: e.player,
        partnerId: e.partner,
        gave: { ...e.gave },
        got: { ...e.got },
        turn: e.turn
      });
    } else if (e.type === "monopoly") {
      ensureBehavior(e.player).monopoliesPlayed++;
    }
  };

  // Helper to resolve a player's tracked hand view from multi-player map or 1v1 oppHandView
  const resolveHandView = (pid: string, name?: string): PlayerHandView | undefined => {
    if (input.handViewsByPlayer) {
      if (input.handViewsByPlayer[pid]) return input.handViewsByPlayer[pid];
      if (name && input.handViewsByPlayer[name]) return input.handViewsByPlayer[name];
    }
    if (pid !== selfId && input.oppHandView) {
      if (discoveredIds.length === 2 || input.oppHandView.name === pid || (name && input.oppHandView.name === name)) {
        return input.oppHandView;
      }
    }
    return undefined;
  };

  // Build per-player observed state
  const buildPlayer = (pid: string, seatIndex: number): ObservedPlayerState => {
    const isSelf = pid === selfId;
    const meta = playerMetaById.get(pid);
    const snap = input.snapshot?.players.find((p) => p.id === pid);
    const trackedView = resolveHandView(pid, meta?.name);
    const settlementCorners: number[] = [];
    const cityCorners: number[] = [];
    const roadEdges: number[] = [];
    const productionPips = emptyHand();
    const ratios: ResourceHand = { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 };

    for (let ci = 0; ci < topology.corners.length; ci++) {
      if (cornerOwner[ci] !== pid) continue;
      const corner = topology.corners[ci];
      const weight = cornerPiece[ci] === 2 ? 2 : 1;
      if (cornerPiece[ci] === 2) cityCorners.push(ci);
      else settlementCorners.push(ci);
      for (const hi of corner.hexIndices) {
        const hex = topology.hexes[hi];
        if (hex.resource && hex.pips > 0) {
          productionPips[hex.resource] += hex.pips * weight;
        }
      }
      if (corner.port === "any") {
        for (const r of RESOURCES) ratios[r] = Math.min(ratios[r], 3);
      } else if (corner.port) {
        ratios[corner.port] = Math.min(ratios[corner.port], 2);
      }
    }

    let ratiosConfidence: ObservedPlayerState["ratiosConfidence"] = "derived_from_ports";
    if (snap && Object.keys(snap.ratios).length > 0) {
      for (const r of RESOURCES) {
        if (snap.ratios[r] !== undefined) ratios[r] = snap.ratios[r]!;
      }
      ratiosConfidence = "authoritative";
    }

    for (let ei = 0; ei < topology.edges.length; ei++) {
      if (edgeOwner[ei] === pid) roadEdges.push(ei);
    }

    const settlementsLeft = snap?.settlementsLeft ?? Math.max(0, MAX_SETTLEMENTS - settlementCorners.length);
    const citiesLeft = snap?.citiesLeft ?? Math.max(0, MAX_CITIES - cityCorners.length);
    const roadsLeft = snap?.roadsLeft ?? Math.max(0, MAX_ROADS - roadEdges.length);
    const suppliesConfidence: ObservedPlayerState["supplies"]["confidence"] =
      snap?.settlementsLeft !== undefined && snap?.citiesLeft !== undefined && snap?.roadsLeft !== undefined
        ? "authoritative"
        : fullGameFromStart
          ? "derived_from_placements"
          : "partial_midgame";

    // Resource hand knowledge: strictly separate directly observed hands (exact !== null)
    // from log/event inferences (exact === null, inferenceSource = "hand_tracker" | "table_read").
    const readSide = isSelf ? tableRead?.me : tableRead?.opp?.id === pid ? tableRead?.opp : undefined;
    const handSize =
      isSelf && input.selfHandKnown !== false && input.selfHand
        ? sumHand(input.selfHand)
        : snap?.handSize ?? (trackedView ? sumHand(trackedView.hand) + trackedView.unknown : readSide?.handSize ?? 0);

    let hand: ObservedResourceHand;
    const exactFromSnap = snap?.hand && sumHand(snap.hand) === handSize ? snap.hand : undefined;
    if (isSelf && input.selfHandKnown !== false && (input.selfHand || exactFromSnap)) {
      const exact = { ...(input.selfHand ?? exactFromSnap!) };
      hand = {
        exact,
        knownMin: { ...exact },
        maxPossible: { ...exact },
        likely: { ...exact },
        handSize: sumHand(exact),
        unknownCount: 0,
        confidence: "exact",
        inferenceSource: "authoritative"
      };
    } else if (handSize === 0 && snap !== undefined) {
      const zero = emptyHand();
      hand = {
        exact: zero,
        knownMin: { ...zero },
        maxPossible: { ...zero },
        likely: { ...zero },
        handSize: 0,
        unknownCount: 0,
        confidence: "exact",
        inferenceSource: "authoritative"
      };
    } else if (!isSelf && trackedView) {
      const rawTracked = { ...trackedView.hand };
      const rawSum = sumHand(rawTracked);
      // In HandTracker, when an unknown card is stolen from a player whose `unknown` count was 0,
      // `unknownLoss` increments without subtracting from `hand[r]`, so `rawSum + unknown` can exceed `handSize`.
      const unattributedLoss = Math.max(0, rawSum + trackedView.unknown - handSize);
      const knownMin = emptyHand();
      const likely = emptyHand();
      for (const r of RESOURCES) {
        knownMin[r] = fullGameFromStart ? Math.max(0, rawTracked[r] - unattributedLoss) : 0;
        likely[r] = Math.min(handSize, rawTracked[r]);
      }
      const minSum = sumHand(knownMin);
      const unknownCount = Math.max(trackedView.unknown, handSize - minSum);
      const maxPossible = emptyHand();
      for (const r of RESOURCES) {
        maxPossible[r] = Math.min(BANK_RESOURCE_CAP, knownMin[r] + unknownCount);
      }
      // Never promote a log-derived HandTracker inference into `exact`: keep `exact: null`
      // so inferred opponent hands remain strictly distinct from directly observed facts.
      hand = {
        exact: null,
        knownMin,
        maxPossible,
        likely,
        handSize,
        unknownCount,
        confidence: "bounded",
        inferenceSource: "hand_tracker"
      };
    } else if (readSide && (sumHand(readSide.likely) > 0 || readSide.unknownCards > 0)) {
      // TableRead only observes dice production minus builds/dev-buys (not trades, steals, or discards),
      // so `readSide.likely` is a heuristic estimate rather than a guaranteed lower bound (`knownMin = 0`).
      const likely = emptyHand();
      for (const r of RESOURCES) likely[r] = Math.min(handSize, Math.max(0, readSide.likely[r]));
      const zero = emptyHand();
      const maxPossible = emptyHand();
      for (const r of RESOURCES) {
        maxPossible[r] = Math.min(BANK_RESOURCE_CAP, handSize);
      }
      hand = {
        exact: null,
        knownMin: zero,
        maxPossible,
        likely,
        handSize,
        unknownCount: handSize,
        confidence: "bounded",
        inferenceSource: "table_read"
      };
    } else if (snap !== undefined) {
      const zero = emptyHand();
      const maxPossible = emptyHand();
      for (const r of RESOURCES) maxPossible[r] = Math.min(BANK_RESOURCE_CAP, handSize);
      hand = {
        exact: null,
        knownMin: zero,
        maxPossible,
        likely: { ...zero },
        handSize,
        unknownCount: handSize,
        confidence: "count_only",
        inferenceSource: "none"
      };
    } else {
      const zero = emptyHand();
      hand = {
        exact: null,
        knownMin: zero,
        maxPossible: { lumber: BANK_RESOURCE_CAP, brick: BANK_RESOURCE_CAP, wool: BANK_RESOURCE_CAP, grain: BANK_RESOURCE_CAP, ore: BANK_RESOURCE_CAP },
        likely: { ...zero },
        handSize: 0,
        unknownCount: 0,
        confidence: "untracked",
        inferenceSource: "none"
      };
    }

    // Development-card state
    const identifiedOwned = snap?.devCards ?? [];
    const confirmedVpDevs = Math.max(
      snap?.hiddenVp ?? 0,
      identifiedOwned.filter((c) => c === "victoryPoint").length
    );
    const boughtActionDevsThisTurn = (snap?.devsBoughtThisTurn ?? []).filter(isActionDev);
    const readyActionDevs: ActionDevCardKind[] = (() => {
      const actions = identifiedOwned.filter(isActionDev);
      for (const b of boughtActionDevsThisTurn) {
        const idx = actions.indexOf(b);
        if (idx >= 0) actions.splice(idx, 1);
      }
      return actions;
    })();
    const totalInHand = snap?.devsInHand ?? readSide?.devsHidden ?? identifiedOwned.length;
    const unknownInHand = snap?.unknownDevsInHand ?? Math.max(0, totalInHand - identifiedOwned.length);
    const unknownBoughtThisTurn = Math.min(unknownInHand, snap?.unknownDevsBoughtThisTurn ?? 0);
    const unknownPlayableNow = Math.max(0, unknownInHand - unknownBoughtThisTurn);
    const playedCards = snap?.devsPlayedCards ?? readSide?.devsPlayed ?? [];
    const playedCount = snap?.devsPlayed ?? playedCards.length;
    const knightsPlayed = snap?.knights ?? readSide?.knights ?? playedCards.filter((c) => c === "knight").length;
    const hasUsedDevThisTurn = snap?.hasUsedDevThisTurn === true;
    const devsConfidence: ObservedDevState["confidence"] =
      snap !== undefined
        ? unknownInHand === 0
          ? "exact"
          : "partial_unknown_faces"
        : "inferred_from_events";

    // Road length and awards
    const computedRoadLength = computeRoadLengthOnTopology(topology, cornerOwner, edgeOwner, pid);
    const roadLength = snap ? Math.max(snap.roadLength, computedRoadLength) : computedRoadLength;
    const hasLongestRoad = snap?.hasLongestRoad === true;
    const hasLargestArmy = snap?.hasLargestArmy === true;
    const armySize = snap?.army ?? knightsPlayed;

    // VP Breakdown: strictly separate visibleVp, confirmedHiddenVp, and maxUnrevealedVpDevs
    const settlementsVp = settlementCorners.length;
    const citiesVp = cityCorners.length * 2;
    const longestRoadVp = hasLongestRoad ? 2 : 0;
    const largestArmyVp = hasLargestArmy ? 2 : 0;
    const boardVisibleVp = settlementsVp + citiesVp + longestRoadVp + largestArmyVp;
    const visibleVp = snap && snap.visibleVp > 0 ? Math.max(snap.visibleVp, boardVisibleVp) : Math.max(boardVisibleVp, publicVp(input.placements, pid));
    const totalConfirmedVp = visibleVp + confirmedVpDevs;
    const maxUnrevealedVpDevs = Math.min(unknownInHand, unseenPool.victoryPoint);
    const maxPossibleVp = totalConfirmedVp + maxUnrevealedVpDevs;

    const pendingDiscardCount =
      phase === "discard" && (snap?.isTakingAction === true || (snap?.isTakingAction === undefined && handSize > discardLimit.value))
        ? Math.floor(handSize / 2)
        : 0;

    const rawBehavior = ensureBehavior(pid);
    const prior = input.opponentPriorsByPlayer?.[pid];
    const behavior: ObservedPlayerBehaviorTelemetry = {
      settlementsBuilt: Math.max(rawBehavior.settlementsBuilt, settlementCorners.length + cityCorners.length),
      citiesBuilt: Math.max(rawBehavior.citiesBuilt, cityCorners.length),
      roadsBuilt: Math.max(rawBehavior.roadsBuilt, roadEdges.length),
      devsBought: Math.max(rawBehavior.devsBought, totalInHand + playedCount),
      devsPlayed: Math.max(rawBehavior.devsPlayed, playedCount),
      knightsPlayed: Math.max(rawBehavior.knightsPlayed, knightsPlayed),
      robberMoves: rawBehavior.robberMoves,
      bankTradesCount: rawBehavior.bankTradesCount,
      playerTradesCount: rawBehavior.playerTradesCount,
      monopoliesPlayed: rawBehavior.monopoliesPlayed,
      ...(prior ? { prior } : {})
    };

    return {
      id: pid,
      seatIndex,
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.color !== undefined ? { color: meta.color } : {}),
      isSelf,
      settlementCorners,
      cityCorners,
      roadEdges,
      productionPips,
      ratios,
      ratiosConfidence,
      supplies: {
        settlementsLeft,
        citiesLeft,
        roadsLeft,
        confidence: suppliesConfidence
      },
      hand,
      devs: {
        totalInHand,
        readyActionDevs,
        boughtActionDevsThisTurn,
        confirmedVpDevs,
        unknownInHand,
        unknownBoughtThisTurn,
        unknownPlayableNow,
        playedCards,
        playedCount,
        knightsPlayed,
        hasUsedDevThisTurn,
        confidence: devsConfidence
      },
      awards: {
        hasLongestRoad,
        hasLargestArmy,
        roadLength,
        computedRoadLength,
        armySize
      },
      vp: {
        settlementsVp,
        citiesVp,
        longestRoadVp,
        largestArmyVp,
        visibleVp,
        confirmedHiddenVp: confirmedVpDevs,
        totalConfirmedVp,
        maxUnrevealedVpDevs,
        maxPossibleVp
      },
      pendingDiscardCount,
      behavior
    };
  };

  const players = discoveredIds.map((pid, idx) => buildPlayer(pid, idx));
  const playerOrder = players.map((p) => p.id);
  const playerById: Record<string, ObservedPlayerState> = {};
  for (const p of players) playerById[p.id] = p;

  // Bank resource state reconstruction across arbitrary player count
  let bank: ObservedBankState;
  const rawBank = input.snapshot?.bank;
  const hasAllFiveBankResources = Boolean(rawBank && RESOURCES.every((r) => typeof rawBank[r] === "number"));
  const allHandsExact = players.length >= 2 && players.every((p) => p.hand.exact !== null);
  const totalHeld = players.reduce((s, p) => s + p.hand.handSize, 0);

  if (hasAllFiveBankResources && !hideBankCards.value) {
    const resources: ResourceHand = {
      lumber: rawBank!.lumber!,
      brick: rawBank!.brick!,
      wool: rawBank!.wool!,
      grain: rawBank!.grain!,
      ore: rawBank!.ore!
    };
    bank = {
      resources,
      totalResourcesLeft: sumHand(resources),
      confidence: "exact"
    };
  } else if (allHandsExact) {
    const resources = emptyHand();
    for (const r of RESOURCES) {
      const heldOfR = players.reduce((s, p) => s + p.hand.exact![r], 0);
      resources[r] = Math.max(0, BANK_RESOURCE_CAP - heldOfR);
    }
    bank = {
      resources,
      totalResourcesLeft: sumHand(resources),
      confidence: "derived_from_exact_hands"
    };
  } else if (hasAllFiveBankResources && hideBankCards.value) {
    const resources: ResourceHand = {
      lumber: rawBank!.lumber!,
      brick: rawBank!.brick!,
      wool: rawBank!.wool!,
      grain: rawBank!.grain!,
      ore: rawBank!.ore!
    };
    const totalBank = sumHand(resources);
    if (totalBank + totalHeld === BANK_RESOURCE_CAP * RESOURCES.length) {
      bank = {
        resources,
        totalResourcesLeft: totalBank,
        confidence: "exact"
      };
    } else {
      bank = {
        resources: null,
        totalResourcesLeft: Math.max(0, BANK_RESOURCE_CAP * RESOURCES.length - totalHeld),
        confidence: "hidden_by_settings"
      };
    }
  } else if (hideBankCards.value) {
    bank = {
      resources: null,
      totalResourcesLeft: Math.max(0, BANK_RESOURCE_CAP * RESOURCES.length - totalHeld),
      confidence: "hidden_by_settings"
    };
  } else {
    bank = {
      resources: null,
      totalResourcesLeft: null,
      confidence: "unknown"
    };
  }

  // Refine uncertain hand bounds using exact bank counts and all other players' known minimums
  for (const player of players) {
    if (!player.hand.exact && bank.resources) {
      for (const r of RESOURCES) {
        const othersKnownMin = players.reduce((s, other) => s + (other.id === player.id ? 0 : other.hand.knownMin[r]), 0);
        const inCirc = Math.max(0, BANK_RESOURCE_CAP - bank.resources[r] - othersKnownMin);
        player.hand.maxPossible[r] = Math.min(player.hand.maxPossible[r], inCirc);
        player.hand.knownMin[r] = Math.min(player.hand.knownMin[r], player.hand.maxPossible[r]);
        player.hand.likely[r] = Math.min(player.hand.likely[r], player.hand.maxPossible[r]);
      }
    }
  }

  // Dice state & alignment reconstruction
  // In Colonist, `completedTurns` includes the 2 setup turns per player (`2 * players.length`) before the first dice roll.
  const observedRolls = (input.events ?? [])
    .filter((e): e is Extract<GameEvent, { type: "roll" }> => e.type === "roll")
    .map((e) => ({ total: e.total, d1: e.d1, d2: e.d2, player: e.player }));
  const completedTurns = input.snapshot?.completedTurns;
  const maxSetupTurns = Math.max(4, players.length * 2) + 1;
  const setupTurnDiff = completedTurns !== undefined ? completedTurns - observedRolls.length : undefined;
  const rollsAlignedWithTurns =
    bagAligned(completedTurns, observedRolls.length) ||
    (setupTurnDiff !== undefined && setupTurnDiff >= 0 && setupTurnDiff <= maxSetupTurns);
  const alignmentStatus: ObservedDiceState["alignmentStatus"] =
    completedTurns === undefined && observedRolls.length === 0
      ? "unknown"
      : rollsAlignedWithTurns && fullGameFromStart
        ? "aligned"
        : "misaligned_midgame";

  const d1 = input.snapshot?.dice?.d1;
  const d2 = input.snapshot?.dice?.d2;
  const dice: ObservedDiceState = {
    thrown: input.snapshot?.dice?.thrown === true,
    d1,
    d2,
    total: d1 !== undefined && d2 !== undefined ? d1 + d2 : undefined,
    observedRolls,
    completedTurns,
    alignmentStatus,
    distributionConfidence: alignmentStatus === "aligned" && diceMode.mode === "balanced" ? "approximate_heuristic" : "unaligned_prior"
  };

  const turnPlayerId = input.snapshot?.turnPlayer;
  const turnPlayerIndex = turnPlayerId !== undefined ? playerOrder.indexOf(turnPlayerId) : undefined;

  return {
    kind: "observed",
    topology,
    cornerOwner,
    cornerPiece,
    edgeOwner,
    robberHexIndex,
    robberHexId,
    robberConfidence,
    players,
    playerOrder,
    playerById,
    selfId,
    turnPlayerId,
    turnPlayerIndex: turnPlayerIndex !== undefined && turnPlayerIndex >= 0 ? turnPlayerIndex : undefined,
    phase,
    phaseConfidence,
    rawTurnState: input.snapshot?.turnState,
    rawActionState: input.snapshot?.actionState,
    dice,
    bank,
    devDeck,
    rules,
    observedTrades,
    provenance: {
      fullGameFromStart,
      hasSnapshot: Boolean(input.snapshot),
      warnings
    }
  };
}

export function cloneObservedGameState(state: ObservedGameState): ObservedGameState {
  const clonePlayer = (p: ObservedPlayerState): ObservedPlayerState => ({
    ...p,
    settlementCorners: [...p.settlementCorners],
    cityCorners: [...p.cityCorners],
    roadEdges: [...p.roadEdges],
    productionPips: { ...p.productionPips },
    ratios: { ...p.ratios },
    supplies: { ...p.supplies },
    hand: {
      ...p.hand,
      exact: p.hand.exact ? { ...p.hand.exact } : null,
      knownMin: { ...p.hand.knownMin },
      maxPossible: { ...p.hand.maxPossible },
      likely: { ...p.hand.likely }
    },
    devs: {
      ...p.devs,
      readyActionDevs: [...p.devs.readyActionDevs],
      boughtActionDevsThisTurn: [...p.devs.boughtActionDevsThisTurn],
      playedCards: [...p.devs.playedCards]
    },
    awards: { ...p.awards },
    vp: { ...p.vp },
    behavior: {
      ...p.behavior,
      ...(p.behavior.prior ? { prior: { ...p.behavior.prior } } : {})
    }
  });
  const clonedPlayers = state.players.map(clonePlayer);
  const playerById: Record<string, ObservedPlayerState> = {};
  for (const p of clonedPlayers) playerById[p.id] = p;
  return {
    ...state,
    cornerOwner: [...state.cornerOwner],
    cornerPiece: new Uint8Array(state.cornerPiece),
    edgeOwner: [...state.edgeOwner],
    players: clonedPlayers,
    playerOrder: [...state.playerOrder],
    playerById,
    dice: {
      ...state.dice,
      observedRolls: state.dice.observedRolls.map((r) => ({ ...r }))
    },
    bank: {
      ...state.bank,
      resources: state.bank.resources ? { ...state.bank.resources } : null
    },
    devDeck: {
      ...state.devDeck,
      unseenPool: { ...state.devDeck.unseenPool }
    },
    rules: {
      ...state.rules,
      maxPlayers: { ...state.rules.maxPlayers },
      victoryPointsToWin: { ...state.rules.victoryPointsToWin },
      cardDiscardLimit: { ...state.rules.cardDiscardLimit },
      friendlyRobber: { ...state.rules.friendlyRobber },
      hideBankCards: { ...state.rules.hideBankCards },
      diceMode: { ...state.rules.diceMode }
    },
    observedTrades: state.observedTrades.map((t) => ({
      ...t,
      gave: { ...t.gave },
      got: { ...t.got }
    })),
    provenance: {
      ...state.provenance,
      warnings: [...state.provenance.warnings]
    }
  };
}

/**
 * Confidence-aware validation for `ObservedGameState`.
 * Enforces strict geometric, distance-rule, award-exclusivity, and VP-accounting invariants,
 * while applying confidence-aware checks for bank conservation, player hands, and mid-game supplies.
 */
export function validateObservedState(state: ObservedGameState): StateValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { topology, cornerOwner, cornerPiece, edgeOwner, players } = state;

  if (players.length < 2) {
    errors.push(`ObservedGameState requires at least 2 players, found ${players.length}.`);
  }
  if (state.playerOrder.length !== players.length) {
    errors.push(`playerOrder length (${state.playerOrder.length}) !== players length (${players.length}).`);
  }
  if (cornerOwner.length !== topology.corners.length || cornerPiece.length !== topology.corners.length) {
    errors.push("Corner state array length mismatch with topology.");
  }
  if (edgeOwner.length !== topology.edges.length) {
    errors.push("Edge state array length mismatch with topology.");
  }

  // 1. Corner piece / owner consistency & settlement distance rule
  for (let ci = 0; ci < topology.corners.length; ci++) {
    const owner = cornerOwner[ci];
    const piece = cornerPiece[ci];
    if ((owner === null) !== (piece === 0)) {
      errors.push(`Corner ${ci} (${topology.corners[ci].at}) has inconsistent owner=${owner} and piece=${piece}.`);
    }
    if (piece !== 0 && piece !== 1 && piece !== 2) {
      errors.push(`Corner ${ci} has invalid piece code ${piece}.`);
    }
    if (piece > 0) {
      for (const adj of topology.corners[ci].adjacentCornerIndices) {
        if (cornerPiece[adj] > 0) {
          errors.push(`Distance rule violation between corner ${ci} (${topology.corners[ci].at}) and ${adj} (${topology.corners[adj].at}).`);
        }
      }
    }
  }

  // 2. Robber index validity
  if (state.robberHexIndex !== null && (state.robberHexIndex < 0 || state.robberHexIndex >= topology.hexes.length)) {
    errors.push(`Invalid robberHexIndex: ${state.robberHexIndex}`);
  }

  // 3. Award mutual exclusion & minimum thresholds across all players
  const lrHolders = players.filter((p) => p.awards.hasLongestRoad);
  if (lrHolders.length > 1) {
    errors.push(`Multiple players simultaneously hold Longest Road: ${lrHolders.map((p) => p.id).join(", ")}.`);
  }
  const laHolders = players.filter((p) => p.awards.hasLargestArmy);
  if (laHolders.length > 1) {
    errors.push(`Multiple players simultaneously hold Largest Army: ${laHolders.map((p) => p.id).join(", ")}.`);
  }
  for (const p of players) {
    if (p.awards.hasLongestRoad && p.awards.roadLength < 5) {
      errors.push(`Player ${p.id} holds Longest Road with roadLength=${p.awards.roadLength} (< 5).`);
    }
    if (p.awards.hasLargestArmy && p.awards.armySize < 3) {
      errors.push(`Player ${p.id} holds Largest Army with armySize=${p.awards.armySize} (< 3).`);
    }
  }

  // 4. Per-player piece, VP, hand, and dev checks
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.seatIndex !== i) {
      errors.push(`Player ${p.id} seatIndex (${p.seatIndex}) !== array index (${i}).`);
    }
    if (p.settlementCorners.length > MAX_SETTLEMENTS) {
      errors.push(`Player ${p.id} exceeds max settlements (${p.settlementCorners.length} > ${MAX_SETTLEMENTS}).`);
    }
    if (p.cityCorners.length > MAX_CITIES) {
      errors.push(`Player ${p.id} exceeds max cities (${p.cityCorners.length} > ${MAX_CITIES}).`);
    }
    if (p.roadEdges.length > MAX_ROADS) {
      errors.push(`Player ${p.id} exceeds max roads (${p.roadEdges.length} > ${MAX_ROADS}).`);
    }
    if (p.supplies.confidence !== "partial_midgame") {
      if (p.settlementCorners.length + p.supplies.settlementsLeft !== MAX_SETTLEMENTS) {
        errors.push(`Player ${p.id} settlement supply mismatch: placed=${p.settlementCorners.length}, left=${p.supplies.settlementsLeft}.`);
      }
      if (p.cityCorners.length + p.supplies.citiesLeft !== MAX_CITIES) {
        errors.push(`Player ${p.id} city supply mismatch: placed=${p.cityCorners.length}, left=${p.supplies.citiesLeft}.`);
      }
      if (p.roadEdges.length + p.supplies.roadsLeft !== MAX_ROADS) {
        errors.push(`Player ${p.id} road supply mismatch: placed=${p.roadEdges.length}, left=${p.supplies.roadsLeft}.`);
      }
    } else {
      warnings.push(`Player ${p.id} piece supplies observed mid-game; skipping strict supply sum check.`);
    }

    // VP checks
    const expectedBoardVisible =
      p.vp.settlementsVp + p.vp.citiesVp + p.vp.longestRoadVp + p.vp.largestArmyVp;
    if (p.vp.visibleVp < expectedBoardVisible) {
      errors.push(`Player ${p.id} visibleVp (${p.vp.visibleVp}) is less than board visible VP (${expectedBoardVisible}).`);
    }
    if (p.vp.totalConfirmedVp !== p.vp.visibleVp + p.vp.confirmedHiddenVp) {
      errors.push(`Player ${p.id} totalConfirmedVp (${p.vp.totalConfirmedVp}) !== visibleVp (${p.vp.visibleVp}) + confirmedHiddenVp (${p.vp.confirmedHiddenVp}).`);
    }
    if (p.vp.maxPossibleVp !== p.vp.totalConfirmedVp + p.vp.maxUnrevealedVpDevs) {
      errors.push(`Player ${p.id} maxPossibleVp mismatch.`);
    }

    // Resource hand bounds
    for (const r of RESOURCES) {
      if (p.hand.knownMin[r] < 0 || p.hand.likely[r] < 0 || p.hand.maxPossible[r] < 0) {
        errors.push(`Player ${p.id} has negative resource bound for ${r}.`);
      }
      if (p.hand.knownMin[r] > p.hand.maxPossible[r]) {
        errors.push(`Player ${p.id} has knownMin[${r}] (${p.hand.knownMin[r]}) > maxPossible[${r}] (${p.hand.maxPossible[r]}).`);
      }
    }
    if (p.hand.exact) {
      if (p.hand.inferenceSource !== "authoritative") {
        errors.push(`Player ${p.id} has non-null exact hand with non-authoritative source ${p.hand.inferenceSource}.`);
      }
      if (p.hand.unknownCount !== 0) {
        errors.push(`Player ${p.id} has exact hand but unknownCount=${p.hand.unknownCount}.`);
      }
      if (sumHand(p.hand.exact) !== p.hand.handSize) {
        errors.push(`Player ${p.id} exact hand sum (${sumHand(p.hand.exact)}) !== handSize (${p.hand.handSize}).`);
      }
    } else if (sumHand(p.hand.knownMin) > p.hand.handSize) {
      errors.push(`Player ${p.id} knownMin sum (${sumHand(p.hand.knownMin)}) exceeds handSize (${p.hand.handSize}).`);
    }

    // Dev card bounds
    const confirmedInHand =
      p.devs.readyActionDevs.length + p.devs.boughtActionDevsThisTurn.length + p.devs.confirmedVpDevs;
    if (confirmedInHand + p.devs.unknownInHand !== p.devs.totalInHand) {
      errors.push(
        `Player ${p.id} dev hand count mismatch: confirmed(${confirmedInHand}) + unknown(${p.devs.unknownInHand}) !== totalInHand(${p.devs.totalInHand}).`
      );
    }
  }

  // 5. Confidence-aware bank conservation check across all players
  if (state.bank.resources) {
    const allExact = players.every((p) => p.hand.exact !== null);
    for (const r of RESOURCES) {
      if (state.bank.resources[r] < 0 || state.bank.resources[r] > BANK_RESOURCE_CAP) {
        errors.push(`Bank resource ${r} out of range: ${state.bank.resources[r]}`);
      }
      if (allExact) {
        const total = state.bank.resources[r] + players.reduce((s, p) => s + p.hand.exact![r], 0);
        if (total !== BANK_RESOURCE_CAP) {
          errors.push(`Exact resource conservation violated for ${r}: bank + hands = ${total} !== ${BANK_RESOURCE_CAP}`);
        }
      } else {
        const minTotal = state.bank.resources[r] + players.reduce((s, p) => s + p.hand.knownMin[r], 0);
        if (minTotal > BANK_RESOURCE_CAP) {
          errors.push(`Bounded resource conservation violated for ${r}: bank + knownMin = ${minTotal} > ${BANK_RESOURCE_CAP}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Strict invariant validator for a fully determined `ConcreteSimulatedGameState`
 * (where all hidden cards and opponent resources have been sampled for a rollout trial).
 */
export function validateConcreteSimState(state: ConcreteSimulatedGameState): StateValidationResult {
  const errors: string[] = [];
  const { topology, cornerOwner, cornerPiece, edgeOwner, players, bank } = state;

  if (players.length < 2) {
    errors.push(`ConcreteSimulatedGameState requires at least 2 players, found ${players.length}.`);
  }
  if (state.turnPlayerIndex < 0 || state.turnPlayerIndex >= players.length) {
    errors.push(`Invalid turnPlayerIndex: ${state.turnPlayerIndex}`);
  }

  for (let ci = 0; ci < topology.corners.length; ci++) {
    if ((cornerOwner[ci] === null) !== (cornerPiece[ci] === 0)) {
      errors.push(`Corner ${ci} owner/piece mismatch.`);
    }
    if (cornerPiece[ci] > 0) {
      for (const adj of topology.corners[ci].adjacentCornerIndices) {
        if (cornerPiece[adj] > 0) errors.push(`Distance rule violation at corners ${ci} and ${adj}.`);
      }
    }
  }

  if (state.robberHexIndex < 0 || state.robberHexIndex >= topology.hexes.length) {
    errors.push(`Invalid robberHexIndex: ${state.robberHexIndex}`);
  }

  if (players.filter((p) => p.hasLongestRoad).length > 1) errors.push("Simultaneous Longest Road holders.");
  if (players.filter((p) => p.hasLargestArmy).length > 1) errors.push("Simultaneous Largest Army holders.");

  for (const r of RESOURCES) {
    if (bank[r] < 0 || players.some((p) => p.hand[r] < 0)) {
      errors.push(`Negative resource count for ${r}.`);
    }
    const total = bank[r] + players.reduce((s, p) => s + p.hand[r], 0);
    if (total !== BANK_RESOURCE_CAP) {
      errors.push(`Strict resource conservation failed for ${r}: ${total} !== ${BANK_RESOURCE_CAP}`);
    }
  }

  for (const p of players) {
    if (p.actualSimulatedVp !== p.visibleVp + p.vpDevs) {
      errors.push(`Player ${p.id} actualSimulatedVp (${p.actualSimulatedVp}) !== visibleVp (${p.visibleVp}) + vpDevs (${p.vpDevs}).`);
    }
  }

  const totalDevs =
    state.devDeckOrder.length +
    players.reduce(
      (s, p) => s + p.readyDevs.length + p.boughtDevsThisTurn.length + p.vpDevs + p.playedDevs.length,
      0
    );
  if (totalDevs !== 25) {
    errors.push(`Strict 25-card dev deck conservation failed: total=${totalDevs} !== 25.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: []
  };
}
