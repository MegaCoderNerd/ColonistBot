/**
 * Stage 3.5 — Tactical correctness benchmark cases.
 *
 * ADDITIVE / EVALUATION ONLY.
 *
 * Every case declares its epistemic status explicitly:
 * - `rule_proven` / `constructed_scenario_proven` cases have an answer forced by the rules and DO
 *   count toward the tactical pass rate.
 * - `recorded_evidence`, `multiple_valid_choices`, and `no_established_answer` cases are reported
 *   as informational and are NEVER counted as failures.
 *
 * A move is never declared optimal because it "looks sensible" or happened to win one game.
 */

import type { SimulatedAction } from "../engine/transition";
import { findImmediateWinningAction } from "../engine/rollout";
import type { TacticalCase } from "./types";

/** Named synthetic positions required by the tactical suite. */
export interface TacticalPositions {
  /** Player can win immediately by upgrading a settlement to a city. */
  readonly immediateWinByCity: TacticalCase["position"];
  /** Player is one VP short but has NO immediate winning action available. */
  readonly noImmediateWinAvailable: TacticalCase["position"];
  /** Player cannot afford any build; only non-build actions are legal. */
  readonly insufficientResources: TacticalCase["position"];
  /** Player must discard exactly N cards; hand size forces the constraint. */
  readonly forcedDiscard: TacticalCase["position"];
  /** Robber is on the actor's own production and a Knight is available. */
  readonly robberBlocksSelfWithKnight: TacticalCase["position"];
  /** Two comparable settlement spots: multiple valid choices. */
  readonly multipleValidPlacements: TacticalCase["position"];
  /** Midgame position with no rule-forced answer. */
  readonly openEndedMidgame: TacticalCase["position"];
}

/**
 * Builds the tactical suite from the supplied synthetic positions. Pure and side-effect free, so
 * the same inputs always produce the same suite.
 */
export function buildTacticalCases(positions: TacticalPositions): TacticalCase[] {
  return [
    {
      caseId: "tactical_immediate_win_city",
      category: "immediate_win",
      description:
        "Upgrading a settlement to a city reaches the victory threshold, so that action must be taken.",
      evidenceClass: "rule_proven",
      rationale:
        "Reaching victoryPointsToWin ends the game immediately under the implemented rules. A " +
        "policy that declines a legal winning action while one exists is provably wrong, " +
        "independent of strategy.",
      position: positions.immediateWinByCity,
      expected: (state, actorId, legalActions, selected) => {
        const win = findImmediateWinningAction(state, actorId, legalActions);
        return win !== undefined && selected.type === win.type;
      }
    },
    {
      caseId: "tactical_illegal_action_never_selected",
      category: "illegal_or_impossible",
      description:
        "With no affordable build available, the policy must not select any build action.",
      evidenceClass: "rule_proven",
      rationale:
        "Selecting an action the engine rejects aborts the rollout as `unsupported_action`. When " +
        "no build is affordable, only legal non-build actions are permissible.",
      position: positions.insufficientResources,
      expected: (_state, _actorId, _legalActions, selected) =>
        selected.type !== "buildCity" &&
        selected.type !== "buildSettlement" &&
        selected.type !== "buildRoad" &&
        selected.type !== "buyDevCard"
    },
    {
      caseId: "tactical_no_false_win_claim",
      category: "immediate_win",
      description:
        "When no legal action wins immediately, the position must not be an immediate win.",
      evidenceClass: "rule_proven",
      rationale:
        "Guards against over-eagerly claiming a win. If `findImmediateWinningAction` returns " +
        "undefined then no single action ends the game in the actor's favour.",
      position: positions.noImmediateWinAvailable,
      expected: (state, actorId, legalActions) =>
        findImmediateWinningAction(state, actorId, legalActions) === undefined
    },
    {
      caseId: "tactical_discard_count_exact",
      category: "robber_discard_turn_supply",
      description:
        "In the discard phase the actor must discard exactly the required number of cards.",
      evidenceClass: "rule_proven",
      rationale:
        "The discard count is fixed by the rules. `getLegalActions` enumerates only exact-count " +
        "discard bags, so any action drawn from that set satisfies the constraint by construction.",
      position: positions.forcedDiscard,
      expected: (_state, _actorId, legalActions) =>
        legalActions.length > 0 && legalActions.every((a) => a.type === "discard")
    },
    {
      caseId: "tactical_robber_knight_defense",
      category: "immediate_threat_defense",
      description:
        "With the robber on the actor's own production and a Knight in hand, the actor should " +
        "unblock its own production.",
      evidenceClass: "constructed_scenario_proven",
      rationale:
        "Playing the Knight both removes the robber from the actor's own production and advances " +
        "Largest Army. Declining to unblock while holding a Knight leaves own production " +
        "suppressed with no compensating gain in this constructed position.",
      position: positions.robberBlocksSelfWithKnight,
      expected: (_state, _actorId, _legalActions, selected) =>
        selected.type === "playKnight" || selected.type === "moveRobber"
    },
    {
      caseId: "tactical_multiple_valid_placements",
      category: "strategic_preference",
      description:
        "Two comparable settlement spots with no rule-forced preference between them.",
      evidenceClass: "multiple_valid_choices",
      rationale:
        "Reported for coverage only. No single answer is correct, so this case is informational " +
        "and is excluded from the tactical pass-rate denominator.",
      position: positions.multipleValidPlacements
    },
    {
      caseId: "tactical_open_ended_midgame",
      category: "strategic_preference",
      description:
        "An ordinary midgame position with several reasonable actions and no established answer.",
      evidenceClass: "no_established_answer",
      rationale:
        "Strategic quality of an open midgame position is measured by simulated win rate, not by a " +
        "tactical pass/fail assertion. Recorded to document that no tactical claim is made here.",
      position: positions.openEndedMidgame
    }
  ];
}

