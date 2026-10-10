// Recovered from content.js (lines 5482-5489)
import { stateDiffAdapter } from "./adapters/stateDiff";
import type { AdapterParseResult } from "./adapters/types";
import { typedEventsAdapter } from "./adapters/typedEvents";

export function pickPrimary(stateDiff: AdapterParseResult, typed: AdapterParseResult): AdapterParseResult & { name: string } {
  const a = { ...stateDiff, name: stateDiffAdapter.name };
  const b = { ...typed, name: typedEventsAdapter.name };
  const score = (r: AdapterParseResult) => r.events.length + (r.board ? 1e3 : 0);
  const [best, other] = score(b) > score(a) ? [b, a] : [a, b];
  return {
    ...best,
    board: best.board ?? other.board,
    players: best.players.length ? best.players : other.players,
    selfId: best.selfId ?? other.selfId,
    selfCards: best.selfCards ?? other.selfCards,
    handSizes: best.handSizes ?? other.handSizes,
    turnPlayer: best.turnPlayer ?? other.turnPlayer,
    snapshot: best.snapshot ?? other.snapshot
  };
}
