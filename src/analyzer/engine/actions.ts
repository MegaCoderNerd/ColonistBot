// Recovered from content.js (lines 2262-2301)
import type { OpeningPlan } from "../strategy";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface CoachTip {
  title: string;
  why: string;
}

export interface CoachAdvice {
  phase: "opening" | "midgame";
  headline: string;
  why: string;
  race?: string;
  at?: string;
  tips: CoachTip[];
  next: string[];
}

export function coachFromOpening(plan: OpeningPlan, portLine?: string, roads?: { first?: string; second?: string }): CoachAdvice {
  const top = plan.picks[0];
  const follow = top?.followUp;
  const here = top ? `${top.numbers.join("/")} (${top.pips} pips)` : "the spot";
  const tips: CoachTip[] = [];
  if (roads?.first) tips.push({ title: plan.mode === "pair" ? "First road" : "Road", why: roads.first });
  if (roads?.second) tips.push({ title: "Second road", why: roads.second });
  if (portLine) tips.push({ title: "Ports", why: portLine });
  if (top?.tags?.some((t) => /his best|blocks his|#\d/.test(t))) {
    tips.push({ title: "Denial", why: "One of these spots is also a spot he wants. Taking it is worth more than a slightly higher pip count somewhere he cannot reach." });
  }
  let headline = "No legal spot from this position.";
  let why = plan.note;
  if (plan.mode === "waiting") {
    headline = "Wait. Watch the dashed spots.";
    why = plan.oppWants[0] ? `He is likely to take ${plan.oppWants[0].reason}` : plan.note;
  } else if (plan.mode === "pair" && top && follow) {
    headline = `First, settle ${here}. Then settle ${follow.reason.replace(/\.$/, "")}.`;
    why = `You place both now, in that order. The first road leaves the first settlement. The second road leaves the second settlement. Do not point either road across the board at the other starting spot.`;
  } else if (plan.mode === "first" && top && follow) {
    headline = `Settle ${here} now.`;
    why = `He places twice before you come back. The road below leaves this settlement. Come back for ${follow.reason.replace(/\.$/, "")} if he has not taken it.`;
  } else if (plan.mode === "second" && top) {
    headline = `Second settlement: ${here}.`;
    why = follow
      ? `Place this one now. It is still your turn. The road below leaves this settlement, not the one you just placed. The other spot was ${follow.reason.replace(/\.$/, "")}.`
      : "Place this one now. It is still your turn. The road below leaves this settlement.";
  } else if (top) {
    headline = `Settle ${here}.`;
    why = plan.mode === "last" ? `This is your second settlement. He has already placed both of his. ${plan.note}` : plan.note;
  }
  if (follow && plan.mode !== "pair") tips.push({ title: "The other settlement", why: follow.reason });
  return {
    phase: "opening",
    headline,
    why,
    at: top?.at,
    tips: tips.slice(0, 4),
    next: plan.mode === "waiting" ? plan.oppWants.slice(0, 3).map((w) => w.reason) : plan.picks.slice(1, 3).map((p) => p.reason)
  };
}
