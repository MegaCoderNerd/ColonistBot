// Recovered from content.js (lines 4969-5359)
import type { DecodedFrame } from "../decode";
import { portKind } from "../geometry";
import { RESOURCE_BY_ID, type GameSnapshot, type PlayerSnapshot } from "../snapshot";
import type { Board, DevCardKind, GameEvent, GameEventDraft, HexTile, PlayerInfo, Resource, ResourceBag } from "../types";
import { isObject, num, type AdapterParseResult, type FrameAdapter } from "./types";

const HEX_RESOURCE: Record<number, Resource | null> = {
  0: null,
  1: "lumber",
  2: "brick",
  3: "wool",
  4: "grain",
  5: "ore"
};


export const DEV_CARD: Record<number, DevCardKind> = {
  11: "knight",
  12: "victoryPoint",
  13: "monopoly",
  14: "roadBuilding",
  15: "yearOfPlenty"
};


export function cloneWithoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneWithoutNulls);
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = cloneWithoutNulls(x);
    return out;
  }
  return v;
}

export function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete target[key];
    } else if (isObject(value)) {
      const existing = target[key];
      if (isObject(existing) || Array.isArray(existing)) deepMerge(existing as Record<string, unknown>, value);
      else target[key] = cloneWithoutNulls(value);
    } else {
      target[key] = value;
    }
  }
}

const STATE_KEYS = ["mapState", "playerStates", "diceState", "currentState", "mechanicRobberState"];

export function findStatePatch(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStatePatch(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (isObject(value.diff)) return value.diff;
  if (isObject(value.gameState)) return value.gameState;
  if (isObject(value.initialState)) return value.initialState;
  if (STATE_KEYS.some((k) => isObject(value[k]))) return value;
  for (const v of Object.values(value)) {
    if (isObject(v) || Array.isArray(v)) {
      const found = findStatePatch(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function holdersOf(value: unknown): Array<Record<string, unknown>> {
  if (!isObject(value)) return [];
  const data = isObject(value.data) ? value.data : undefined;
  const payload = isObject(value.payload) ? value.payload : isObject(data?.payload) ? data?.payload : undefined;
  return [value, data, payload].filter((h): h is Record<string, unknown> => Boolean(h));
}

function userStatesOf(value: unknown): unknown[] | undefined {
  if (!isObject(value)) return undefined;
  const data = isObject(value.data) ? value.data : undefined;
  for (const holder of [value, data, isObject(value.payload) ? value.payload : undefined, isObject(data?.payload) ? data?.payload : undefined]) {
    if (holder && Array.isArray(holder.playerUserStates)) return holder.playerUserStates;
  }
  return undefined;
}

export function sumVp(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (isObject(v)) {
    let total = 0;
    for (const x of Object.values(v)) if (typeof x === "number") total += x;
    return total;
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) return Object.fromEntries(v.flatMap((x, i) => (x === null || x === undefined ? [] : [[String(i), x]])));
  return isObject(v) ? v : undefined;
}

function get(tree: unknown, ...path: string[]): unknown {
  let cur: unknown = tree;
  for (const key of path) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function playerId(color: string | number): string {
  return `c${color}`;
}

export const stateDiffAdapter: FrameAdapter = {
  name: "state-diff",
  parse(frames: DecodedFrame[]): AdapterParseResult {
    const state: Record<string, unknown> = {};
    const events: GameEvent[] = [];
    const players = new Map<string, PlayerInfo>();
    const seenCorners = new Map<string, number>();
    const seenEdges = new Set<string>();
    const vpByPlayer = new Map<string, number>();
    const handByPlayer = new Map<string, number>();
    const devOwned = new Map<string, number>();
    const devUsed = new Map<string, number>();
    const awards: Record<"longestRoad" | "largestArmy", string> = { longestRoad: "", largestArmy: "" };
    let lastRobber: number | undefined;
    let robberStartIndex: number | undefined;
    let rolls = 0;
    let lastDiceKey = "";
    let diceWasThrown = false;
    let sawState = false;
    const warnings: string[] = [];
    const userNames = new Map<string, string>();
    let topSelf: number | undefined;
    let firstStateBuildings = -1;

    for (const f of frames) {
      if (f.frame.dir !== "in" || f.value === undefined) continue;
      const users = userStatesOf(f.value);
      if (users) {
        for (const u of users) {
          if (!isObject(u)) continue;
          const color = num(u.selectedColor ?? u.color);
          const name = typeof u.username === "string" && u.username ? u.username : undefined;
          if (color === undefined || !name) continue;
          userNames.set(playerId(color), name);
          players.set(playerId(color), { id: playerId(color), color, name });
        }
      }
      for (const holder of holdersOf(f.value)) {
        const pc = num(holder.playerColor);
        if (pc !== undefined) topSelf = pc;
      }
      const patch = findStatePatch(f.value);
      if (!patch) continue;
      deepMerge(state, patch);
      sawState = true;
      const t = f.frame.t;
      const push = (e: GameEventDraft) => events.push({ ...e, t, turn: rolls });
      const turnColor = get(state, "currentState", "currentTurnPlayerColor") ?? get(state, "currentState", "turnPlayerColor");
      const turnPlayer = turnColor !== undefined ? playerId(turnColor as string | number) : undefined;
      const playerStates = get(state, "playerStates");
      if (isObject(playerStates)) {
        for (const [key, raw] of Object.entries(playerStates)) {
          if (!isObject(raw)) continue;
          const color = num(raw.color) ?? num(key);
          const id = playerId(color ?? key);
          const name = [raw.username, raw.displayName, raw.name].find((n): n is string => typeof n === "string" && n.length > 0);
          const prev = players.get(id);
          players.set(id, { id, color, name: name ?? userNames.get(id) ?? prev?.name ?? `Player ${color ?? key}` });
        }
      }
      const dice = get(state, "diceState");
      if (isObject(dice)) {
        const thrown = dice.diceThrown === true;
        const d1 = num(dice.dice1);
        const d2 = num(dice.dice2);
        const key = `${d1}-${d2}`;
        if (thrown && d1 !== undefined && d2 !== undefined && (!diceWasThrown || key !== lastDiceKey)) {
          rolls++;
          push({ type: "roll", player: turnPlayer, d1, d2, total: d1 + d2 });
        }
        diceWasThrown = thrown;
        lastDiceKey = key;
      }
      const corners = asRecord(get(state, "mapState", "tileCornerStates"));
      let buildingsThisMessage = 0;
      if (corners) {
        for (const [id, raw] of Object.entries(corners)) {
          if (!isObject(raw)) continue;
          const owner = raw.owner as string | number | undefined | null;
          const kind = num(raw.buildingType);
          if (owner === undefined || owner === null || !kind) continue;
          if (seenCorners.get(id) === kind) continue;
          seenCorners.set(id, kind);
          buildingsThisMessage++;
          push({
            type: "build",
            player: playerId(owner),
            piece: kind >= 2 ? "city" : "settlement",
            at: `${raw.x},${raw.y},${raw.z}`,
            setup: rolls === 0
          });
        }
      }
      const edges = asRecord(get(state, "mapState", "tileEdgeStates"));
      if (edges) {
        for (const [id, raw] of Object.entries(edges)) {
          if (!isObject(raw) || seenEdges.has(id)) continue;
          if (raw.owner === undefined || raw.owner === null || !num(raw.type)) continue;
          seenEdges.add(id);
          buildingsThisMessage++;
          push({ type: "build", player: playerId(raw.owner as string | number), piece: "road", at: `${raw.x},${raw.y},${raw.z}`, setup: rolls === 0 });
        }
      }
      if (firstStateBuildings < 0) firstStateBuildings = buildingsThisMessage;
      const devState = get(state, "mechanicDevelopmentCardsState", "players");
      if (isObject(devState)) {
        for (const [color, raw] of Object.entries(devState)) {
          if (!isObject(raw)) continue;
          const id = playerId(color);
          const owned = Array.isArray(get(raw, "developmentCards", "cards")) ? (get(raw, "developmentCards", "cards") as unknown[]).length : undefined;
          const used = get(raw, "developmentCardsUsed");
          const usedList = Array.isArray(used) ? used : undefined;
          if (owned !== undefined) {
            const prev = devOwned.get(id);
            const prevUsed = devUsed.get(id) ?? 0;
            const bought = prev === undefined ? 0 : owned + (usedList ? usedList.length - prevUsed : 0) - prev;
            devOwned.set(id, owned);
            for (let i = 0; i < bought; i++) push({ type: "devBuy", player: id });
          }
          if (usedList) {
            const before = devUsed.get(id) ?? 0;
            for (let i = before; i < usedList.length; i++) {
              push({ type: "devPlay", player: id, card: DEV_CARD[num(usedList[i]) ?? -1] ?? "unknown" });
            }
            devUsed.set(id, usedList.length);
          }
        }
      }
      const robber = get(state, "mechanicRobberState");
      if (isObject(robber)) {
        const loc = num(robber.locationTileIndex);
        if (loc !== undefined) {
          if (robberStartIndex === undefined) robberStartIndex = loc;
          if (lastRobber !== undefined && loc !== lastRobber) {
            push({ type: "robberMove", player: turnPlayer ?? "unknown", hex: String(loc) });
          }
          lastRobber = loc;
        }
      }
      for (const [stateKey, flag, eventType] of [
        ["mechanicLongestRoadState", "hasLongestRoad", "longestRoad"],
        ["mechanicLargestArmyState", "hasLargestArmy", "largestArmy"]
      ] as const) {
        const award = get(state, stateKey);
        if (!isObject(award)) continue;
        for (const [color, raw] of Object.entries(award)) {
          if (isObject(raw) && raw[flag] === true && awards[eventType] !== color) {
            awards[eventType] = color;
            push({ type: eventType, player: playerId(color) });
          }
        }
      }
      if (isObject(playerStates)) {
        for (const [key, raw] of Object.entries(playerStates)) {
          if (!isObject(raw)) continue;
          const id = playerId(num(raw.color) ?? key);
          const cards = get(raw, "resourceCards", "cards");
          if (Array.isArray(cards) && handByPlayer.get(id) !== cards.length) {
            handByPlayer.set(id, cards.length);
            push({ type: "hand", player: id, size: cards.length });
          }
          const vp = sumVp(raw.victoryPoints);
          if (vp !== undefined && vpByPlayer.get(id) !== vp) {
            vpByPlayer.set(id, vp);
            push({ type: "vp", player: id, vp });
          }
        }
      }
    }

    if (!sawState) return { players: [], events: [], warnings: [] };
    if (firstStateBuildings > 4) {
      warnings.push("Recording appears to start mid-game; earlier moves are missing.");
    }
    const board = buildBoard(state, robberStartIndex);
    if (!board) warnings.push("No board (tileHexStates) found in state; production stats are unavailable.");
    const selfColor = num(get(state, "playerColor")) ?? topSelf;
    const ownCards = selfColor === undefined ? undefined : get(state, "playerStates", String(selfColor), "resourceCards", "cards");
    const selfCards = Array.isArray(ownCards) && ownCards.every((c): c is number => typeof c === "number") ? ownCards : undefined;
    const handSizes: Record<string, number> = {};
    const finalStates = asRecord(get(state, "playerStates")) ?? {};
    for (const [key, raw] of Object.entries(finalStates)) {
      const cards = get(isObject(raw) ? raw : {}, "resourceCards", "cards");
      if (Array.isArray(cards)) handSizes[playerId((isObject(raw) ? num(raw.color) : undefined) ?? key)] = cards.length;
    }
    const turnPlayer = (() => {
      const c = num(get(state, "currentState", "currentTurnPlayerColor") ?? get(state, "currentState", "turnPlayerColor"));
      return c === undefined ? undefined : playerId(c);
    })();
    return {
      players: [...players.values()],
      events,
      board,
      warnings,
      selfId: selfColor === undefined ? undefined : playerId(selfColor),
      selfCards,
      handSizes,
      turnPlayer,
      snapshot: readSnapshot(state, turnPlayer)
    };
  }
};

export function readSnapshot(state: Record<string, unknown>, turnPlayer?: string): GameSnapshot {
  const players: PlayerSnapshot[] = [];
  for (const [key, raw] of Object.entries(asRecord(get(state, "playerStates")) ?? {})) {
    if (!isObject(raw)) continue;
    const color = String(num(raw.color) ?? key);
    const id = playerId(num(raw.color) ?? key);
    const ratios: ResourceBag = {};
    const ratioState = raw.bankTradeRatiosState;
    if (isObject(ratioState)) {
      for (const [rid, value] of Object.entries(ratioState)) {
        const resource = RESOURCE_BY_ID[Number(rid)];
        const rate = num(value);
        if (resource && rate) ratios[resource] = rate;
      }
    }
    const cards = get(raw, "resourceCards", "cards");
    const dev = get(state, "mechanicDevelopmentCardsState", "players", color);
    const owned = Array.isArray(get(isObject(dev) ? dev : {}, "developmentCards", "cards")) ? (get(isObject(dev) ? dev : {}, "developmentCards", "cards") as unknown[]) : [];
    const used = Array.isArray(get(isObject(dev) ? dev : {}, "developmentCardsUsed")) ? (get(isObject(dev) ? dev : {}, "developmentCardsUsed") as unknown[]) : [];
    const devCards = owned.every((c) => DEV_CARD[num(c) ?? -1]) ? owned.map((c) => DEV_CARD[num(c) ?? -1]) : undefined;
    const knights = used.filter((c) => (DEV_CARD[num(c) ?? -1] ?? "") === "knight").length;
    const road = get(state, "mechanicLongestRoadState", color);
    const army = get(state, "mechanicLargestArmyState", color);
    const piece = (group: string, field: string) => num(get(state, group, color, field));
    players.push({
      id,
      vp: sumVp(raw.victoryPointsState) ?? sumVp(raw.victoryPoints) ?? 0,
      handSize: Array.isArray(cards) ? cards.length : 0,
      ratios,
      roadLength: num(isObject(road) ? road.longestRoad : undefined) ?? 0,
      hasLongestRoad: isObject(road) && road.hasLongestRoad === true,
      army: num(isObject(army) ? army.armySize ?? army.largestArmy : undefined) ?? knights,
      hasLargestArmy: isObject(army) && army.hasLargestArmy === true,
      devsInHand: owned.length,
      devsPlayed: used.length,
      knights,
      devCards,
      settlementsLeft: piece("mechanicSettlementState", "bankSettlementAmount"),
      citiesLeft: piece("mechanicCityState", "bankCityAmount"),
      roadsLeft: piece("mechanicRoadState", "bankRoadAmount"),
      discardLimit: num(raw.cardDiscardLimit)
    });
  }
  const bankRaw = get(state, "bankState", "resourceCards");
  const bank: ResourceBag = {};
  if (isObject(bankRaw)) {
    for (const [rid, value] of Object.entries(bankRaw)) {
      const resource = RESOURCE_BY_ID[Number(rid)];
      const count = num(value);
      if (resource && count !== undefined) bank[resource] = count;
    }
  }
  const dice = get(state, "diceState");
  const current = get(state, "currentState");
  const robber = num(get(state, "mechanicRobberState", "locationTileIndex"));
  return {
    players,
    bank: Object.keys(bank).length ? bank : undefined,
    dice: isObject(dice) ? { thrown: dice.diceThrown === true, d1: num(dice.dice1), d2: num(dice.dice2) } : undefined,
    turnPlayer,
    turnState: isObject(current) ? num(current.turnState) : undefined,
    actionState: isObject(current) ? num(current.actionState) : undefined,
    completedTurns: isObject(current) ? num(current.completedTurns) : undefined,
    robberHex: robber === undefined ? undefined : String(robber)
  };
}

export function buildBoard(state: Record<string, unknown>, robberStartIndex?: number): Board | undefined {
  const tiles = asRecord(get(state, "mapState", "tileHexStates"));
  if (!tiles) return undefined;
  const hexes: HexTile[] = [];
  for (const [id, raw] of Object.entries(tiles)) {
    if (!isObject(raw)) continue;
    const x = num(raw.x);
    const y = num(raw.y);
    if (x === undefined || y === undefined) continue;
    const resource = HEX_RESOURCE[num(raw.type) ?? 0] ?? null;
    hexes.push({ id, x, y, resource, number: resource ? num(raw.diceNumber) ?? null : null });
  }
  if (!hexes.length) return undefined;
  const desert = hexes.find((h) => h.resource === null);
  const ports = Object.values(asRecord(get(state, "mapState", "portEdgeStates")) ?? {}).flatMap((raw) => {
    if (!isObject(raw)) return [];
    const kind = portKind(num(raw.type) ?? 0);
    const [x, y, z] = [num(raw.x), num(raw.y), num(raw.z)];
    return kind && x !== undefined && y !== undefined && z !== undefined ? [{ at: `${x},${y},${z}`, kind }] : [];
  });
  return {
    hexes,
    ports: ports.length ? ports : undefined,
    robberStart: robberStartIndex !== undefined ? String(robberStartIndex) : desert?.id
  };
}
