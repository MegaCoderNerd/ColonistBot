// Recovered from content.js (lines 3219-3921)
import { publicVp } from "../advisor";
import type { GameSnapshot, PlayerSnapshot } from "../snapshot";
import { contextFor, hexDependence, profileOf, roadDistance, type BoardContext } from "../strategy";
import { COSTS } from "../tracker";
import { RESOURCES, type Board, type DevCardKind, type GameEvent, type Placements, type Resource, type ResourceBag, type ResourceHand } from "../types";
import type { CoachTip } from "./actions";
import { portAccess, type PortAccessItem } from "./ports";
import { bagAligned, canBuild, chooseSettlement, cityPick, holdingResource, rankLiveSpots, situationBrief, worthTheRoad, type RankedLiveSpot } from "./read";
import { longestExtensions, networkLength, roadToward } from "./roads";
import { bestEdge, mostLikelyRolls, nextRollText, positionWin, sevensText } from "./value";

// [RECONSTRUCTED TYPE DECLARATIONS]
export interface TurnPlanInput {
  board: Board;
  placements: Placements;
  me: string;
  goal?: number;
  hand?: ResourceHand;
  handKnown?: boolean;
  snapshot?: GameSnapshot;
  events?: GameEvent[];
  oppNeeds?: Resource[];
  oppHand?: ResourceHand;
  oppUnknown?: number;
}

export interface TurnPlan {
  headline: string;
  why: string;
  race: string;
  tips: CoachTip[];
  settle?: { at: string; dist: number; mark: boolean; reason: string };
  alt?: { at: string; reason: string };
  road?: { edge: string; toward?: string; buildNow: boolean; reason: string };
  road2?: { edge: string; toward?: string; reason: string };
  roadLater?: { edge: string; reason: string };
}

const LABEL: Record<Resource, string> = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };

export function planTurn(input: TurnPlanInput): TurnPlan {
  const goal = input.goal ?? 15;
  const ctx = contextFor(input.board);
  const own = profileOf(ctx, input.placements, (o) => o === input.me);
  const his = profileOf(ctx, input.placements, (o) => o !== input.me);
  const meSnap = input.snapshot?.players.find((p) => p.id === input.me);
  const oppSnap = input.snapshot?.players.find((p) => p.id !== input.me);
  const oppId = oppSnap?.id ?? [...input.placements.settlements, ...input.placements.cities, ...input.placements.roads].map(([, owner]) => owner).find((owner) => owner !== input.me);
  const myVp = vpOf(meSnap, input.placements, input.me);
  const hisVp = vpOf(oppSnap, input.placements, oppId);
  const ratios = ratiosOf(meSnap);
  const hand = input.hand ?? { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  const known = input.handKnown !== false && input.hand !== undefined;
  const cards = meSnap?.devCards ?? [];
  const rolled = input.snapshot?.dice?.thrown === true;
  const roadsLeft = meSnap?.roadsLeft !== 0;
  const settlesLeft = meSnap?.settlementsLeft !== 0;
  const citiesLeft = meSnap?.citiesLeft !== 0;
  const ownSettlement = [...input.placements.settlements.values()].some((o) => o === input.me);
  const handSizes: Record<string, number> = {};
  const devsInHand: Record<string, number> = {};
  const knightCount: Record<string, number> = {};
  for (const p of input.snapshot?.players ?? []) {
    handSizes[p.id] = p.handSize;
    devsInHand[p.id] = p.devsInHand;
    knightCount[p.id] = p.knights;
  }
  const ranked = rankLiveSpots(input.board, input.placements, input.me, input.events ?? [], {
    handSize: handSizes,
    devsInHand,
    knights: knightCount,
    completedTurns: input.snapshot?.completedTurns
  });
  const roadRich = own.lumber >= 4 && own.brick >= 4;
  const choice = chooseSettlement(ranked.spots, roadRich);
  let spot = choice.toward;
  if (cards.includes("roadBuilding") && spot && spot.dist > 2) {
    const nearer = ranked.spots.filter((s) => s.dist >= 1 && s.dist <= 2 && s.value >= spot!.value - 4).sort((a, b) => b.value - a.value)[0];
    if (nearer) spot = nearer;
  }
  const touching = choice.now;
  const myLen = Math.max(meSnap?.roadLength ?? 0, networkLength(input.board, input.placements, input.me));
  const oppLen = Math.max(oppSnap?.roadLength ?? 0, oppId ? networkLength(input.board, input.placements, oppId) : 0);
  const battle = roadBattle(myLen, oppLen, meSnap?.hasLongestRoad === true, oppSnap?.hasLongestRoad === true);
  const needVp = goal - myVp;
  const canCity = known && citiesLeft && ownSettlement && canPay(hand, COSTS.city);
  const cityClose = known && citiesLeft && ownSettlement && !canCity && tradesToPay(hand, ratios, COSTS.city) === 1;
  const yopCards = cards.includes("yearOfPlenty") ? finishWith(hand, COSTS.city, 2) : undefined;
  const yopCity = Boolean(yopCards && citiesLeft && ownSettlement && yopCards.length > 0);
  const canPlaceNow = Boolean(known && settlesLeft && touching && canPay(hand, COSTS.settlement));
  const settleClose = Boolean(known && settlesLeft && touching && !canPlaceNow && tradesToPay(hand, ratios, COSTS.settlement) === 1);
  const goodSpot = Boolean(spot && spot.dist >= 1 && spot.dist <= (roadRich ? 5 : 3) && spot.value > 8);
  const oneAway = Boolean(spot && spot.dist === 1 && spot.value > 8);
  const canPayRoad = known && canPay(hand, COSTS.road);
  const roadTrade = known && !canPayRoad && tradesToPay(hand, ratios, COSTS.road) === 1;
  const canRoad = roadsLeft && (!known || canPayRoad || roadTrade);
  const nextKnights = (meSnap?.knights ?? 0) + 1;
  const armyNow = cards.includes("knight") && meSnap?.hasLargestArmy !== true && nextKnights >= 3 && nextKnights > (oppSnap?.army ?? 0);
  const extensions = longestExtensions(input.board, input.placements, input.me);
  const extension = extensions.slice().sort((a, b) => {
    const av = ranked.spots.find((s) => s.step?.edge === a.edge)?.value ?? 0;
    const bv = ranked.spots.find((s) => s.step?.edge === b.edge)?.value ?? 0;
    return bv - av;
  })[0];
  const trophy1 = battle.worth && battle.roadsNeeded === 1 && roadsLeft;
  const trophy2 = battle.worth && battle.roadsNeeded === 2 && roadsLeft && !oneAway && !canPlaceNow;
  const canTrophyNow = trophy1 && Boolean(extension) && (canRoad || cards.includes("roadBuilding"));
  const canTrophy2 = trophy2 && Boolean(extension) && (canRoad || cards.includes("roadBuilding"));
  const winningTwo = needVp === 2;
  const city = cityPick(ctx, input.board, input.placements, input.me, ranked.read.dice.weight);
  const cityWorth = (city?.gain ?? 0) >= 4;
  const producingCity = own.ore > 0 && own.grain > 0;
  const cityThisTurn = (cityWorth || producingCity) && (canCity || cityClose || yopCity);
  const robberOnMe = robberHits(ctx, input.placements, input.me, input.snapshot?.robberHex);
  const burst = Boolean(known && settlesLeft && citiesLeft && ownSettlement && touching && cityWorth && canPay(hand, { lumber: 1, brick: 1, wool: 1, grain: 3, ore: 3 }));
  const myCities = [...input.placements.cities.values()].filter((o) => o === input.me).length;
  const myBuildings = myCities + [...input.placements.settlements.values()].filter((o) => o === input.me).length;
  const haveCity = myCities >= 1;
  const thirdClose = Boolean(haveCity && spot && spot.dist >= 1 && spot.dist <= 2);
  const nearPort = portAccess(ctx, roadDistance(ctx, input.placements, (o) => o === input.me), own).find((p) => p.roads >= 1 && p.roads <= 2);
  const portStep = nearPort ? roadToward(input.board, input.placements, input.me, nearPort.at) : undefined;
  const portName = nearPort ? (nearPort.kind === "any" ? "3:1 port" : `2:1 ${LABEL[nearPort.kind]} port`) : "port";
  const onFour = RESOURCES.every((r) => ratios[r] >= 4);
  const endgame = needVp <= 4;
  const portWithinTwo = Boolean(nearPort && portStep);
  let action = "hold";
  const roadBuildReach = cards.includes("roadBuilding") && roadsLeft && (canTrophyNow || canTrophy2 || (goodSpot && spot!.dist <= 2) || portWithinTwo);
  if (winningTwo && armyNow) action = "army";
  else if (winningTwo && canTrophyNow && !canCity) action = "trophy";
  else if (burst) action = "burst";
  else if (cityThisTurn) action = canCity ? "city" : yopCity && !cityClose ? "yop" : "cityTrade";
  else if (canPlaceNow) action = "settle";
  else if (settleClose) action = "settleTrade";
  else if (armyNow) action = "army";
  else if (roadBuildReach && (canTrophyNow || canTrophy2)) action = "roadBuild";
  else if (canTrophyNow) action = "trophy";
  else if (roadBuildReach) action = "roadBuild";
  else if (canTrophy2 && !cityThisTurn) action = "trophy2";
  else if (haveCity && oppSnap?.hasLongestRoad && known && canPay(hand, COSTS.dev) && !thirdClose && !canPlaceNow) action = "buyDev";
  else if (goodSpot && canRoad) action = "road";
  else if (cards.includes("knight") && robberOnMe) action = "knight";
  else if (known && canPay(hand, COSTS.dev) && !oneAway && !(goodSpot && canRoad)) action = "buyDev";
  const scarce = own.lumber < 3 && own.brick < 3;
  const oppCanCity = Boolean(input.oppHand && (input.oppUnknown ?? 0) === 0 && canBuild(input.oppHand, "city"));
  let heldBrick = false;
  let refused: RankedLiveSpot | undefined;
  if (action === "road" && scarce && spot && !worthTheRoad(spot, own)) {
    refused = spot;
    const better = ranked.spots.filter((s) => s.dist >= 1 && s.dist <= 2 && worthTheRoad(s, own)).sort((a, b) => b.value - 2.05 * b.dist - (a.value - 2.05 * a.dist))[0];
    if (better) spot = better;
    else {
      heldBrick = true;
      action = cards.includes("knight") && robberOnMe ? "knight" : known && canPay(hand, COSTS.dev) ? "buyDev" : "hold";
    }
  }
  if (!scarce && myCities === 0 && action === "road" && spot && spot.pipsBy.ore < 3 && spot.pipsBy.grain < 3 && own.ore < 4) {
    const cityRoad = ranked.spots
      .filter((s) => s.dist >= 1 && s.dist <= 2 && (s.pipsBy.ore >= 3 || s.pipsBy.grain >= 3) && s.pips >= 6)
      .sort((a, b) => b.pipsBy.ore + b.pipsBy.grain - (a.pipsBy.ore + a.pipsBy.grain))[0];
    if (cityRoad) spot = cityRoad;
  }
  const settleReady = known && (canPay(hand, COSTS.settlement) || tradesToPay(hand, ratios, COSTS.settlement) === 1);
  const settleMissing = known ? missingNames(hand, COSTS.settlement) : [];
  let portHold = false;
  if (nearPort && portStep && known && action !== "city" && action !== "cityTrade" && action !== "yop" && action !== "burst" && action !== "roadBuild") {
    const bankRoad = (action === "road" || action === "trophy" || action === "trophy2") && roadTrade && bankFour(hand, ratios, COSTS.road);
    const bankSettle = action === "settleTrade" && bankFour(hand, ratios, COSTS.settlement);
    if (bankRoad || bankSettle) {
      portHold = true;
      heldBrick = false;
      action = "port";
    }
  }
  if (endgame && known && canPay(hand, COSTS.dev) && !canTrophyNow && !canPlaceNow && (action === "road" || action === "hold" || action === "trophy2")) action = "buyDev";
  const third = myCities >= 1 && myBuildings >= 2 && myBuildings < 3;
  const knightNote = robberOnMe ? "" : keyBlock(ctx, input.placements, input.me, input.snapshot?.robberHex);
  const seen = (input.events ?? []).filter((e): e is Extract<GameEvent, { type: "roll" }> => e.type === "roll");
  const seenRolls = seen.map((e) => e.total);
  const seenFaces = seen.map((e) => ({ total: e.total, d1: e.d1, d2: e.d2, player: e.player }));
  const alignedBag = bagAligned(input.snapshot?.completedTurns, seenRolls.length);
  const discardLimit = meSnap?.discardLimit ?? 9;
  if (action === "yop" && !rolled && known && total(hand) + 2 > discardLimit) action = canCity ? "city" : cityClose ? "cityTrade" : "hold";
  const edgePick = bestEdge(input.board, input.placements, input.me, { rolls: seenRolls, aligned: alignedBag, hand, maxDist: 2 });
  const locked = action === "army" || action === "knight" || action === "yop" || action === "roadBuild" || action === "burst" || action === "trophy" || action === "trophy2" || action === "port";
  if (!locked && known) {
    const heAheadKnights = (oppSnap?.knights ?? 0) > (meSnap?.knights ?? 0) || (oppSnap?.army ?? 0) > (meSnap?.army ?? meSnap?.knights ?? 0);
    const awardPressure = Boolean(oppSnap?.hasLongestRoad || oppSnap?.hasLargestArmy || heAheadKnights);
    const cityOk = Boolean((canCity || cityClose) && ownSettlement && citiesLeft && city && (cityWorth || producingCity));
    const settleOk = Boolean(canPlaceNow && touching);
    const roadSettles = Boolean(spot && spot.dist === 1 && (settleReady || canPlaceNow));
    let roadOk = Boolean(canRoad && edgePick && !heldBrick);
    if (cityOk && producingCity && !trophy1 && !roadSettles) roadOk = false;
    if (awardPressure && !cityOk && !trophy1) roadOk = false;
    const devOk = canPay(hand, COSTS.dev);
    const ids: Array<"hold" | "city" | "settle" | "road" | "dev"> = ["hold"];
    if (cityOk) ids.push("city");
    if (settleOk) ids.push("settle");
    if (roadOk) ids.push("road");
    if (devOk) ids.push("dev");
    const rank: Record<"city" | "dev" | "settle" | "road" | "hold", number> = { city: 0, dev: 1, settle: 2, road: 3, hold: 4 };
    let bestId = ids[0];
    let bestPct = -1;
    let bestCards = total(hand);
    for (const id of ids) {
      const placed: Placements = {
        settlements: new Map(input.placements.settlements),
        cities: new Map(input.placements.cities),
        roads: new Map(input.placements.roads)
      };
      const next = { ...hand };
      let vp = myVp;
      const pay = (cost: ResourceBag) => {
        for (const r of RESOURCES) next[r] = Math.max(0, next[r] - (cost[r] ?? 0));
      };
      if (id === "city" && city) {
        placed.settlements.delete(city.at);
        placed.cities.set(city.at, input.me);
        pay(COSTS.city);
        vp += 1;
      } else if (id === "settle" && touching) {
        placed.settlements.set(touching.at, input.me);
        pay(COSTS.settlement);
        vp += 1;
      } else if (id === "road" && edgePick) {
        placed.roads.set(edgePick.edge, input.me);
        pay(COSTS.road);
      } else if (id === "dev") pay(COSTS.dev);
      const pct = positionWin(input.board, placed, input.me, { hand: next, myVp: vp, hisVp, ratios, rollCount: seenRolls.length + 20 + rank[id] });
      const cards = total(next);
      if (pct > bestPct || (pct === bestPct && (rank[id] < rank[bestId] || (rank[id] === rank[bestId] && cards < bestCards)))) {
        bestId = id;
        bestPct = pct;
        bestCards = cards;
      }
    }
    const building = action === "settle" || action === "settleTrade" || action === "city" || action === "cityTrade";
    const sitting = action === "hold";
    const adopt = bestId === "city" || (bestId === "settle" && !building) || (bestId === "dev" && !building) || sitting || (bestId === "road" && (sitting || action === "buyDev"));
    if (adopt) {
      if (bestId === "city") action = canCity ? "city" : "cityTrade";
      else if (bestId === "settle") action = "settle";
      else if (bestId === "road") action = "road";
      else if (bestId === "dev") action = "buyDev";
      else if (action === "hold") action = "hold";
    }
    if (cityOk && producingCity && (action === "road" || action === "hold" || action === "buyDev") && !trophy1 && !roadSettles) {
      action = canCity ? "city" : "cityTrade";
    } else if (awardPressure && !cityOk && action === "road" && !trophy1) {
      if (devOk) action = "buyDev";
      else if (cards.includes("knight")) action = "knight";
    }
  }
  if ((action === "road" || action === "roadBuild") && edgePick?.toward && !trophy1 && !trophy2) {
    const aimed = ranked.spots.find((s) => s.at === edgePick.toward);
    if (aimed && (!scarce || worthTheRoad(aimed, own))) spot = aimed;
  }
  const trophyRoad = action === "trophy" || action === "trophy2" || (action === "roadBuild" && (trophy1 || trophy2));
  const aimedStep =
    edgePick && (action === "road" || (action === "roadBuild" && !trophy1 && !trophy2)) ? { edge: edgePick.edge, toward: edgePick.toward ?? spot?.at } : undefined;
  const firstStep =
    action === "port" && portStep && nearPort
      ? { edge: portStep.edge, toward: nearPort.at }
      : trophyRoad && extension
        ? { edge: extension.edge, toward: extension.to }
        : aimedStep
          ? aimedStep
          : edgePick
            ? { edge: edgePick.edge, toward: edgePick.toward ?? spot?.at }
            : spot?.step
              ? { edge: spot.step.edge, toward: spot.at }
              : undefined;
  const secondPick =
    action === "roadBuild" && firstStep && !trophy1 && !trophy2
      ? bestEdge(input.board, withRoad(input.placements, firstStep.edge, input.me), input.me, { rolls: seenRolls, aligned: alignedBag, hand, maxDist: 2 })
      : undefined;
  const secondStep =
    action === "roadBuild" && firstStep
      ? trophy1 || trophy2
        ? secondFreeRoad(input.board, input.placements, input.me, firstStep.edge, spot, ranked.spots, nearPort, true, false)
        : secondPick
          ? {
              edge: secondPick.edge,
              toward: secondPick.toward,
              reason: secondPick.toward
                ? `Second road toward ${ranked.spots.find((s) => s.at === secondPick.toward)?.numbers.join("/") ?? "the next spot"}. ${secondPick.reason}`
                : `Second road. ${secondPick.reason}`
            }
          : undefined
      : undefined;
  const cityName = city?.name;
  const spotName = spot ? `${spot.numbers.join("/")} (${spot.pips} pips)` : "the settlement";
  const portNote = spot?.port ? (spot.port === "any" ? " It takes a 3:1 port." : ` It takes the 2:1 ${LABEL[spot.port]} port.`) : "";
  let headline = "Hold the cards and roll.";
  let why = "Nothing you can buy this turn improves the position more than keeping the hand.";
  if (action === "burst" && touching) {
    headline = `Settle ${touching.numbers.join("/")} (${touching.pips} pips), then city${cityName ? ` ${cityName}` : ""} on the same turn.`;
    why = "The hand pays for both. Playing them together is the one time to leave 2 VP. Do not city on one turn and settle on the next while he can rob you in between.";
  } else if ((action === "settle" || action === "settleTrade") && touching) {
    headline = action === "settleTrade" ? `Trade, then settle ${touching.numbers.join("/")} (${touching.pips} pips).` : `Settle ${touching.numbers.join("/")} (${touching.pips} pips).`;
    why = `Your road already reaches it, and it is better than the next spot down the road. ${touching.reason}`;
  } else if (action === "city") {
    headline = cityName ? `Build a city on ${cityName}.` : "Build a city on your best settlement.";
    why = "A city is a point and it doubles that spot. That income beats a road, unless one road is the two points that win the game right now.";
  } else if (action === "cityTrade") {
    headline = cityName ? `Trade, then city ${cityName}.` : "Trade, then build the city.";
    why = "You are one trade from a city. Take the trade below, then city. Do not spend those cards on a road.";
  } else if (action === "yop" && yopCards) {
    headline = `Play Year of Plenty for ${yopCards.map((r) => LABEL[r]).join(" and ")}, then city.`;
    why = cityName ? `Those two cards finish the city on ${cityName}. A free city beats spending the turn on a road.` : "Those two cards finish a city. Play the card, then city.";
  } else if (action === "army") {
    headline = "Play the knight and take the largest army.";
    why = `That knight is your number ${nextKnights}, which is the largest army: 2 VP. Play it before you spend the turn on a road${winningTwo ? ". It wins the game" : ""}.`;
  } else if (action === "roadBuild") {
    const firstLabel = trophy1 || trophy2 ? "the longest road" : spotName;
    const secondLabel = secondStep?.reason ?? "Second road continues from that edge.";
    headline = `Play Road Building. First road toward ${firstLabel}. ${secondLabel}`;
    why =
      trophy1 || trophy2
        ? `${battle.text} Lay the first road, then the second, in that order.`
        : `Lay the first road, then the second, in that order.${portNote} Do not spend brick and wood on a road while this card does it.`;
  } else if (action === "trophy" || action === "trophy2") {
    headline = action === "trophy" ? "Build one road and take the longest road." : "Start the longest-road fight. Two roads take it.";
    why = battle.text;
  } else if (action === "port" && nearPort) {
    headline = portHold ? `Do not 4:1. Road to the ${portName}.` : `Road to the ${portName}.`;
    why = portHold
      ? `${nearPort.text} A 4:1 is only worth it when it finishes the city.`
      : `${nearPort.text} You are still trading 4:1, so this is the road to build. The third settlement comes after the port.`;
  } else if (heldBrick && action === "hold" && refused) {
    headline = "Hold the wood and brick.";
    why = brickWhy(refused, settleMissing, oppCanCity);
  } else if (action === "road" && spot) {
    const left =
      spot.dist === 1 && settleReady
        ? "The settlement is legal after this road."
        : spot.dist === 1
          ? known
            ? `You still need ${settleMissing.join(" and ")} before you can settle there.`
            : "Do not treat the settlement as this turn until the hand shows you can pay for it."
          : `${spot.dist} roads in total.${known && !settleReady && settleMissing.length ? ` You still need ${settleMissing.join(" and ")} before you can settle.` : ""}`;
    const thirdName = third && spot.dist <= 2;
    headline = roadTrade
      ? `Trade, then road toward ${spotName}.`
      : thirdName && spot.dist === 1 && settleReady
        ? `Road, then the third settlement ${spotName}.`
        : thirdName
          ? `Road toward the third settlement, ${spotName}.`
          : spot.dist === 1 && settleReady
            ? `Road, then settle ${spotName}.`
            : spot.dist === 1
              ? `Road toward ${spotName}.`
              : `Build toward ${spotName}, ${spot.dist} roads away.`;
    why = `That is the strongest settlement your roads can reach.${portNote} ${left}${choice.skipped ? ` The corner you already reach is ${choice.skipped.pips} pips on ${choice.skipped.numbers.join("/")}. It is the worse spot. Leave it.` : ""}`;
  } else if (action === "knight") {
    headline = rolled ? "Play the knight before you end the turn." : "Play the knight before you roll.";
    why = rolled
      ? "The roll already happened, so this steals a card and moves the robber off you for the next round. You may play one dev card, and never the turn you bought it."
      : "The robber is on you. Move it before the roll, or this production is lost. You may play one dev card, and never the turn you bought it.";
  } else if (action === "buyDev") {
    headline = "Buy a development card.";
    why = endgame
      ? "This is the end of the game. A dev card is a knight toward the largest army, or a hidden point about one time in five. You cannot play it on the turn you buy it."
      : "No city and no settlement is close. A dev card is a knight toward the largest army, or a hidden point about one time in five. You cannot play it on the turn you buy it.";
  }
  if (heldBrick && action === "buyDev" && refused) {
    why = `${brickWhy(refused, settleMissing, oppCanCity)} You can pay for a dev card without spending that wood and brick.`;
  }
  if (action !== "knight" && action !== "army" && cards.includes("knight") && robberOnMe && !rolled) {
    why = `Play the knight before you roll. The robber is on you. ${why}`;
  }
  if (needVp <= 4) {
    why += ` You need ${needVp} VP and he needs ${Math.max(0, goal - hisVp)}. One dev card in five is a hidden point you cannot see.`;
  }
  const rolls = Math.max((input.events ?? []).filter((e) => e.type === "roll").length, input.snapshot?.completedTurns ?? 0);
  if (own.ore > 0 && own.grain > 0 && myCities === 0 && rolls >= 18 && action !== "city" && action !== "cityTrade" && action !== "yop" && action !== "burst") {
    why += " Your wins city around roll 19 and your losses around roll 28. The city is still waiting.";
  }
  if (myCities >= 1 && myBuildings < 3 && rolls >= 22 && action !== "road" && action !== "port" && action !== "settle" && action !== "settleTrade" && action !== "burst" && !(onFour && nearPort)) {
    why += " The third settlement is the next build, before the game runs long.";
  }
  if ((action === "road" || action === "roadBuild") && edgePick && !trophy1 && !trophy2) why += ` ${edgePick.reason}`;
  const dice = input.snapshot?.dice;
  const safeRoll = rolled && dice?.d1 !== undefined && dice.d2 !== undefined && dice.d1 + dice.d2 !== 7;
  const sevenMode = mostLikelyRolls(seenFaces, alignedBag).includes(7);
  if (known && total(hand) > discardLimit && !rolled) {
    const dropped = cardsToDrop(hand, own, keepFor(hand, own, action), Math.floor(total(hand) / 2));
    headline = dropSentence(dropped, hand, keepFor(hand, own, action));
    why = `You hold ${total(hand)} cards and you have not rolled, so nothing can be placed first. A 7 makes you drop ${Math.floor(total(hand) / 2)}. ${sevensText(seenFaces, alignedBag, input.me)} ${why}`;
  } else if (known && total(hand) > discardLimit && safeRoll) {
    const spent = spendDown(hand, ratios, own, action, discardLimit, spotName);
    if (spent) {
      headline = spent;
      why = `${spent} ${sevensText(seenFaces, alignedBag, input.me)} ${why}`;
    }
  } else if (
    !rolled &&
    sevenMode &&
    known &&
    total(hand) >= 8 &&
    total(hand) <= discardLimit &&
    !/city/i.test(headline) &&
    action !== "settle" &&
    action !== "settleTrade" &&
    action !== "army" &&
    action !== "knight" &&
    action !== "yop" &&
    action !== "roadBuild"
  ) {
    const spendAction = action === "hold" ? (canPay(hand, COSTS.road) ? "road" : canPay(hand, COSTS.dev) ? "buyDev" : action) : action;
    const spent = spendDown(hand, ratios, own, spendAction, discardLimit, spotName);
    if (spent) {
      headline = spent;
      why = `${spent} ${sevensText(seenFaces, alignedBag, input.me)} ${why}`;
    }
  } else if (known && total(hand) >= discardLimit - 2 && total(hand) <= discardLimit) {
    why += ` ${sevensText(seenFaces, alignedBag, input.me)} Do not take cards that cross ${discardLimit} unless this turn spends them. A production roll on his turn can still push a legal hand over ${discardLimit}.`;
  }
  const mono = cards.includes("monopoly") ? monopolyCall(input.oppHand, input.oppUnknown, his, input.oppNeeds ?? [], input.oppHand ? richest(input.oppHand) : holdingResource(ranked.read)) : undefined;
  const oppSize = input.oppHand && (input.oppUnknown ?? 0) === 0 && total(input.oppHand) > 0 ? total(input.oppHand) : oppSnap?.handSize ?? 0;
  const playMono = Boolean(mono && (oppSize >= 6 || oppCanCity));
  const spendsDev = action === "yop" || action === "roadBuild" || action === "army" || action === "knight";
  if (mono && playMono && !spendsDev) {
    const call = `Play Monopoly on ${LABEL[mono.resource]}.`;
    if (action === "city" || action === "cityTrade" || action === "burst" || action === "settle" || action === "settleTrade") {
      headline = `${call} Then ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;
      why = `${mono.why} ${why}`;
    } else if (action === "port") {
      headline = call;
      why = `${mono.why} Then road to the ${portName}. ${why}`;
    } else {
      headline = call;
      why = `${mono.why} ${why}`;
    }
  }
  const firstLabel = trophy1 || trophy2 ? "the longest road" : spotName;
  const rbLine = action === "roadBuild" ? `Play Road Building. First road toward ${firstLabel}. ${secondStep?.reason ?? "Second road continues from that edge."}` : undefined;
  const buildNow = !heldBrick && (action === "trophy" || action === "trophy2" || action === "roadBuild" || action === "port" || (action === "road" && (spot?.dist ?? 9) <= 2));
  const step = firstStep;
  const toward = firstStep?.toward;
  const edgeNote = edgePick && step && step.edge === edgePick.edge ? ` ${edgePick.reason}` : "";
  const afterRoad =
    spot && spot.dist === 1 && settleReady
      ? " The settlement is legal after this road."
      : spot && spot.dist === 1 && known && settleMissing.length
        ? ` You still need ${settleMissing.join(" and ")} before that settlement.`
        : spot && spot.dist > 1
          ? ` ${spot.dist} roads in total.`
          : "";
  let road = step
    ? {
        edge: step.edge,
        toward,
        buildNow,
        reason: buildNow
          ? trophyRoad
            ? `${battle.text} The highlighted road is the one that lengthens it.`
            : action === "port"
              ? `This is the road to the ${portName}. ${nearPort?.text ?? ""}`
              : action === "roadBuild"
                ? `First road toward ${firstLabel}.`
                : `This is the road toward ${spotName}.${afterRoad}${edgeNote}${roadTrade ? " Make the trade below first." : ""}`
          : action === "road" && spot && spot.dist > 2
            ? `${spotName} is ${spot.dist} roads away.${edgeNote} The settlement is not this turn.`
            : `Not this turn. ${headline} When you do spend a road, this is the one, toward ${spot ? spotName : "the next settlement"}.${edgeNote}`
      }
    : undefined;
  if (action === "port" && portStep && nearPort) {
    road = { edge: portStep.edge, toward: nearPort.at, buildNow: true, reason: `This is the road to the ${portName}. ${nearPort.text}` };
  }
  const road2 = action === "roadBuild" && secondStep ? { edge: secondStep.edge, toward: secondStep.toward, reason: secondStep.reason } : undefined;
  const roadLater =
    edgePick?.follow && step && step.edge === edgePick.edge && !road2 ? { edge: edgePick.follow, reason: "Then this road. It is the next one toward the settlement." } : undefined;
  const brief = situationBrief(ranked.read, input.oppHand ? { hand: input.oppHand, unknown: input.oppUnknown ?? 0 } : undefined);
  const tips: CoachTip[] = [
    ...(brief ? [{ title: "What he did", why: brief }] : []),
    { title: "Road battle", why: battle.text },
    { title: "Trade", why: tradeLine(hand, known, ratios, own, input.oppNeeds ?? [], action, canCity, nearPort) },
    {
      title: "Dev cards",
      why: devLine(
        cards,
        known,
        hand,
        robberOnMe,
        rolled,
        cityThisTurn,
        canPlaceNow,
        settleClose,
        battle,
        his,
        oppSize,
        input.oppNeeds ?? [],
        spot,
        input.oppHand ? richest(input.oppHand) : holdingResource(ranked.read),
        knightNote,
        rbLine,
        mono ? monopolySentence(mono, playMono, spendsDev) : undefined
      )
    }
  ];
  if (known && total(hand) > discardLimit) {
    tips.unshift({
      title: "A 7 discards from this hand",
      why: rolled ? `You hold ${total(hand)} cards after the roll. ${headline}` : `You hold ${total(hand)} cards. Drop ${Math.floor(total(hand) / 2)} if a 7 comes before you have rolled. ${headline}`
    });
  }
  const shown = heldBrick || action === "port" ? undefined : action === "settle" || action === "settleTrade" || action === "burst" ? touching : spot;
  const mark = !heldBrick && action !== "port" && (action === "settle" || action === "settleTrade" || action === "burst" || action === "road" || (action === "roadBuild" && !trophy1 && !trophy2));
  const heLeadsArmy = Boolean(oppSnap?.hasLargestArmy || ((oppSnap?.army ?? 0) >= 3 && meSnap?.hasLargestArmy !== true));
  const raceLead = heLeadsArmy ? " He leads the army, so the road is the other two points." : oppSnap?.hasLongestRoad ? " He holds the longest road, so dev cards are the other way after the city." : "";
  const phase = phaseLine(myCities, myBuildings, onFour, Boolean(nearPort), endgame, own);
  const pct = positionWin(input.board, input.placements, input.me, { hand: known ? hand : undefined, myVp, hisVp, ratios, rollCount: seenRolls.length });
  const nextRoll = nextRollText(seenFaces, alignedBag);
  const sevenLine =
    headline.startsWith("Drop ") || headline.startsWith("Spend ") || headline.startsWith("Give ")
      ? `${headline} ${sevensText(seenFaces, alignedBag, input.me)}`
      : `${sevensText(seenFaces, alignedBag, input.me)}${known ? ` You hold ${total(hand)}.` : ""}`;
  tips.unshift(
    { title: "Win", why: `About ${pct}% from here. This model's share under one shared build policy. Not a promise.` },
    { title: "Next roll", why: nextRoll },
    { title: "A 7", why: sevenLine }
  );
  return {
    headline,
    why,
    race: `About ${pct}% from here. ${nextRoll} You have ${myVp} VP, he has ${hisVp}. First to ${goal}. Buildings alone stop at 13, so the last points are the army, the road, or a dev card.${phase}${raceLead}${(oppSnap?.devsInHand ?? 0) > 0 ? " He holds a dev card, and one in five is a hidden point." : ""}`,
    tips,
    settle: shown
      ? {
          at: shown.at,
          dist: shown.dist,
          mark: Boolean(mark),
          reason: shown.reason
        }
      : undefined,
    alt: choice.alt && choice.alt.at !== shown?.at ? { at: choice.alt.at, reason: choice.alt.reason } : undefined,
    road,
    road2,
    roadLater
  };
}

function vpOf(snap: PlayerSnapshot | undefined, placements: Placements, id?: string): number {
  const built = id ? publicVp(placements, id) : 0;
  if (snap && snap.vp > 0) return Math.max(snap.vp, built);
  return built;
}

function ratiosOf(snap?: PlayerSnapshot): ResourceHand {
  const out: ResourceHand = { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 };
  if (!snap) return out;
  for (const r of RESOURCES) if (snap.ratios[r]) out[r] = snap.ratios[r]!;
  return out;
}

function bankFour(hand: ResourceHand, ratios: ResourceHand, cost: ResourceBag): boolean {
  const scratch = { ...hand };
  for (const want of RESOURCES) {
    while (scratch[want] < (cost[want] ?? 0)) {
      const give = RESOURCES.filter((r) => r !== want && scratch[r] >= ratios[r] && scratch[r] - ratios[r] >= (cost[r] ?? 0)).sort((a, b) => scratch[b] - scratch[a])[0];
      if (!give) return false;
      if (ratios[give] >= 4) return true;
      scratch[give] -= ratios[give];
      scratch[want]++;
    }
  }
  return false;
}

function keyBlock(ctx: BoardContext, placements: Placements, me: string, robberHex?: string): string {
  const dep = hexDependence(ctx, placements, (o) => o !== me);
  const ports = new Set<Resource>();
  for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
    if (owner === me) continue;
    const port = ctx.byAt.get(at)?.port;
    if (port && port !== "any") ports.add(port);
  }
  const hex = robberHex ? ctx.hexById.get(robberHex) : undefined;
  const share = robberHex ? dep.get(robberHex)?.share ?? 0 : 0;
  const onKey = Boolean(hex?.resource && ((hex.resource === "grain" && share >= 0.9) || (hex.resource === "ore" && share >= 0.9) || (ports.has(hex.resource) && share >= 0.5)));
  if (onKey && hex?.resource) return `Hold the knight. The robber is already on his ${LABEL[hex.resource]}. When he clears it, put it back.`;
  for (const [id, info] of dep) {
    const h = ctx.hexById.get(id);
    if (h?.resource === "grain" && info.share >= 0.9 && id !== robberHex) return "Put the robber back on his wheat when you play the knight.";
  }
  return "";
}

function missingNames(hand: ResourceHand, cost: ResourceBag): string[] {
  const names: string[] = [];
  for (const r of RESOURCES) {
    const miss = (cost[r] ?? 0) - hand[r];
    if (miss > 0) names.push(LABEL[r]);
  }
  return names;
}

function richest(hand: ResourceHand): Resource | undefined {
  return RESOURCES.filter((r) => hand[r] > 0).sort((a, b) => hand[b] - hand[a])[0];
}

function brickWhy(spot: RankedLiveSpot, missing: string[], oppCanCity: boolean): string {
  const name = `${spot.numbers.join("/")} (${spot.pips} pips)`;
  const miss = missing.length ? ` You cannot settle there: you are missing ${missing.join(" and ")}.` : "";
  const city = oppCanCity ? " He can pay for a city right now." : "";
  return `${name} is not worth the brick. You barely produce wood or brick, so this is the last road for a while.${miss} Do not trade the wood away.${city}`;
}

function phaseLine(cities: number, buildings: number, onFour: boolean, portNear: boolean, endgame: boolean, own: ResourceHand): string {
  if (endgame) return " Endgame: the army, the longest road, or a dev point. Monopoly takes the cards that finish it.";
  if (cities === 0) return own.ore > 0 && own.grain > 0 ? " Early: city before you spread." : " Early: road to the ore and wheat, or the wood and brick you do not make.";
  if (onFour && portNear) return " After the city: the better settlement, a port only when that spot beats the inland one.";
  if (buildings < 3) return " Midgame: the third settlement is the next build.";
  return " Late: the remaining points are the army, the road, or a dev card.";
}

function monopolyCall(
  oppHand: ResourceHand | undefined,
  oppUnknown: number | undefined,
  his: ResourceHand,
  oppNeeds: Resource[],
  holding?: Resource
): { resource: Resource; why: string } {
  const counted = Boolean(oppHand && (oppUnknown ?? 0) === 0 && total(oppHand) > 0);
  if (counted && oppHand) {
    if (canBuild(oppHand, "city") && (oppHand.grain > 0 || oppHand.ore > 0)) {
      const resource: Resource = oppHand.grain > 0 && oppHand.grain >= oppHand.ore ? "grain" : "ore";
      return { resource, why: `He holds ${oppHand.grain} wheat and ${oppHand.ore} ore, and he can pay for a city. Calling ${LABEL[resource]} takes that city off the table.` };
    }
    const resource = richest(oppHand) ?? "ore";
    return { resource, why: `He holds ${oppHand[resource]} ${LABEL[resource]}, which is the largest pile in his hand.` };
  }
  const resource = holding ?? oppNeeds[0] ?? RESOURCES.slice().sort((a, b) => his[b] - his[a])[0];
  return { resource, why: `His hand is not fully counted, so call ${LABEL[resource]}, the resource showing up most.` };
}

function monopolySentence(call: { resource: Resource; why: string }, play: boolean, spendsDev: boolean): string {
  if (spendsDev) return `One dev card this turn, so save Monopoly. Call ${LABEL[call.resource]} next turn. ${call.why}`;
  if (play) return `Play Monopoly on ${LABEL[call.resource]}. ${call.why}`;
  return `Hold Monopoly. Call ${LABEL[call.resource]} when his hand is large. ${call.why}`;
}

function withRoad(placements: Placements, edge: string, owner: string): Placements {
  const roads = new Map(placements.roads);
  roads.set(edge, owner);
  return { settlements: placements.settlements, cities: placements.cities, roads };
}

function secondFreeRoad(
  board: Board,
  placements: Placements,
  me: string,
  firstEdge: string,
  spot: RankedLiveSpot | undefined,
  spots: RankedLiveSpot[],
  port: PortAccessItem | undefined,
  trophy: boolean,
  preferPort: boolean
): { edge: string; toward?: string; reason: string } | undefined {
  const after = withRoad(placements, firstEdge, me);
  let best: { edge: string; toward: string; reason: string; score: number } | undefined;
  const aim = (at: string, reason: string, score: number) => {
    const step = roadToward(board, after, me, at);
    if (!step || step.edge === firstEdge) return;
    if (!best || score > best.score) best = { edge: step.edge, toward: at, reason, score };
  };
  if (trophy) {
    const ext = longestExtensions(board, after, me).find((e) => e.edge !== firstEdge);
    if (ext) return { edge: ext.edge, toward: ext.to, reason: "Second road takes the longest road." };
  }
  if (port && preferPort) aim(port.at, `Second road to the port. ${port.text}`, 40);
  if (spot && spot.dist > 1) aim(spot.at, `Second road toward ${spot.numbers.join("/")} (${spot.pips} pips).`, 28);
  for (const s of spots) {
    if (s.dist < 1 || s.dist > 4) continue;
    const portBonus = s.port && s.port !== "any" ? 4 : s.port === "any" ? 2 : 0;
    aim(s.at, `Second road toward ${s.numbers.join("/")} (${s.pips} pips).`, s.value - 2 * s.dist + portBonus);
  }
  if (port) aim(port.at, `Second road to the port. ${port.text}`, preferPort ? 40 : 12);
  if (best) return { edge: best.edge, toward: best.toward, reason: best.reason };
  const ext = longestExtensions(board, after, me).find((e) => e.edge !== firstEdge);
  if (ext) return { edge: ext.edge, toward: ext.to, reason: "Second road continues that line." };
  return undefined;
}

function total(h: ResourceHand): number {
  return RESOURCES.reduce((s, r) => s + h[r], 0);
}

function listCards(counts: ResourceBag): string {
  const parts = RESOURCES.filter((r) => (counts[r] ?? 0) > 0).map((r) => `${counts[r]} ${LABEL[r]}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function keepFor(hand: ResourceHand, own: ResourceHand, action: string): ResourceBag {
  const keep: ResourceBag = {};
  const cityish = action === "city" || action === "cityTrade" || action === "yop" || action === "burst" || (own.ore > 0 && own.grain > 0);
  if (cityish) {
    keep.grain = Math.min(hand.grain, 2);
    keep.ore = Math.min(hand.ore, 3);
  }
  keep.lumber = Math.min(hand.lumber, 1);
  keep.brick = Math.min(hand.brick, 1);
  return keep;
}

function cardsToDrop(hand: ResourceHand, own: ResourceHand, keep: ResourceBag, n: number): ResourceBag {
  const left = { ...hand };
  const dropped: ResourceBag = {};
  let need = n;
  const take = (r: Resource, k: number) => {
    const m = Math.min(k, left[r], need);
    if (m <= 0) return;
    left[r] -= m;
    dropped[r] = (dropped[r] ?? 0) + m;
    need -= m;
  };
  const byProd = (a: Resource, b: Resource) => own[b] - own[a] || left[b] - left[a];
  for (const r of RESOURCES.slice().sort(byProd)) take(r, left[r] - (keep[r] ?? 0));
  for (const r of RESOURCES.slice().sort(byProd)) take(r, left[r]);
  return dropped;
}

function dropSentence(dropped: ResourceBag, hand: ResourceHand, keep: ResourceBag): string {
  const kept = RESOURCES.filter((r) => (keep[r] ?? 0) > 0 && hand[r] - (dropped[r] ?? 0) > 0).map((r) => LABEL[r]);
  const hold = kept.length ? ` Keep the ${kept.join(" and the ")}.` : "";
  return `Drop ${listCards(dropped)}.${hold}`;
}

function spendDown(hand: ResourceHand, ratios: ResourceHand, own: ResourceHand, action: string, limit: number, spotName: string): string | undefined {
  const goal =
    action === "city" || action === "cityTrade" || action === "yop"
      ? { cost: COSTS.city, name: "the city" }
      : action === "settle" || action === "settleTrade" || action === "burst"
        ? {
            cost: action === "burst" ? { lumber: 1, brick: 1, wool: 1, grain: 3, ore: 3 } : COSTS.settlement,
            name: action === "burst" ? "the settlement and the city" : "the settlement"
          }
        : action === "road" || action === "trophy" || action === "trophy2" || action === "port"
          ? { cost: COSTS.road, name: action === "port" ? "the road to the port" : `the road toward ${spotName}` }
          : action === "buyDev"
            ? { cost: COSTS.dev, name: "the development card" }
            : undefined;
  if (!goal) return undefined;
  const next = { ...hand };
  const gave: ResourceBag = {};
  if (!canPay(next, goal.cost)) {
    if (action !== "city" && action !== "cityTrade" && action !== "yop") return undefined;
    for (let n = 0; n < 4 && !canPay(next, goal.cost); n++) {
      const want = RESOURCES.find((r) => next[r] < (goal.cost[r] ?? 0));
      if (!want) break;
      const give = RESOURCES.filter((r) => r !== want && next[r] >= ratios[r] && next[r] - ratios[r] >= (goal.cost[r] ?? 0)).sort((a, b) => next[b] - next[a])[0];
      if (!give || (ratios[give] >= 4 && action !== "city" && action !== "cityTrade")) return undefined;
      gave[give] = (gave[give] ?? 0) + ratios[give];
      next[give] -= ratios[give];
      next[want]++;
    }
    if (!canPay(next, goal.cost)) return undefined;
  }
  const paid: ResourceBag = {};
  for (const r of RESOURCES) {
    const n = goal.cost[r] ?? 0;
    if (n > 0) paid[r] = n;
    next[r] -= n;
  }
  let left = total(next);
  let extra = "";
  if (left > limit) {
    const more = cardsToDrop(next, own, {}, left - limit);
    for (const r of RESOURCES) next[r] -= more[r] ?? 0;
    left = total(next);
    extra = ` Drop ${listCards(more)} as well.`;
  }
  if (left > limit) return undefined;
  const trade = RESOURCES.some((r) => (gave[r] ?? 0) > 0) ? `Give ${listCards(gave)} ` : "";
  const verb = trade ? `and spend ${listCards(paid)} on ${goal.name}.` : `Spend ${listCards(paid)} on ${goal.name}.`;
  return `${trade}${verb}${extra} That leaves ${left} cards.`;
}

function canPay(h: ResourceHand, cost: ResourceBag): boolean {
  return RESOURCES.every((r) => h[r] >= (cost[r] ?? 0));
}

function finishWith(hand: ResourceHand, cost: ResourceBag, limit: number): Resource[] | undefined {
  const need: Resource[] = [];
  for (const r of RESOURCES) for (let i = hand[r]; i < (cost[r] ?? 0); i++) need.push(r);
  return need.length > 0 && need.length <= limit ? need : undefined;
}

export function tradesToPay(hand: ResourceHand, ratios: ResourceHand, cost: ResourceBag): number {
  const have = { ...hand };
  let trades = 0;
  for (let n = 0; n < 6 && !canPay(have, cost); n++) {
    const want = RESOURCES.find((r) => have[r] < (cost[r] ?? 0));
    if (!want) break;
    const give = RESOURCES.filter((r) => r !== want && have[r] >= ratios[r] && have[r] - ratios[r] >= (cost[r] ?? 0)).sort(
      (a, b) => have[b] / ratios[b] - have[a] / ratios[a]
    )[0];
    if (!give) return 99;
    have[give] -= ratios[give];
    have[want]++;
    trades++;
  }
  return canPay(have, cost) ? trades : 99;
}

function tradeLine(
  hand: ResourceHand,
  known: boolean,
  ratios: ResourceHand,
  own: ResourceHand,
  oppNeeds: Resource[],
  action: string,
  canCity: boolean,
  nearPort?: PortAccessItem
): string {
  if (!known) return "Your hand is not readable yet, so do not follow a card-for-card trade until the counter shows your cards.";
  if (action === "port") return nearPort ? `Do not 4:1. Road to the port. ${nearPort.text}` : "Do not 4:1. Road to the port.";
  const goal =
    action === "city" || action === "cityTrade" || action === "yop"
      ? COSTS.city
      : action === "settle" || action === "settleTrade"
        ? COSTS.settlement
        : action === "road" || action === "trophy" || action === "trophy2"
          ? COSTS.road
          : action === "buyDev"
            ? COSTS.dev
            : undefined;
  const name = goal === COSTS.city ? "city" : goal === COSTS.settlement ? "settlement" : goal === COSTS.dev ? "dev card" : "road";
  if (!goal || canPay(hand, goal) || action === "yop" || action === "roadBuild" || action === "army" || action === "knight") {
    if (canCity || (goal && canPay(hand, goal))) return `You can pay for the ${canCity ? "city" : name} without trading. Do not give cards away.`;
    return "Do not trade. You are not one trade from a city, a settlement or a dev card, and a trade now only feeds him or sets up a discard.";
  }
  const parts: string[] = [];
  const scratch = { ...hand };
  const missing = RESOURCES.filter((r) => scratch[r] < (goal[r] ?? 0));
  for (const want of missing) {
    while (scratch[want] < (goal[want] ?? 0)) {
      const give = RESOURCES.filter((r) => r !== want && scratch[r] >= ratios[r] && scratch[r] - ratios[r] >= (goal[r] ?? 0)).sort(
        (a, b) => scratch[b] - scratch[a] || own[b] - own[a]
      )[0];
      if (!give) break;
      const rate = ratios[give];
      const where = rate === 2 ? `your 2:1 ${LABEL[give]}` : rate === 3 ? "your 3:1 port" : "the bank at 4:1";
      const warn = oppNeeds.includes(want) ? ` Do not buy the ${LABEL[want]} from him; he needs it himself. Use ${where}.` : "";
      parts.push(`Give ${rate} ${LABEL[give]} for 1 ${LABEL[want]} at ${where}.${warn}`);
      scratch[give] -= rate;
      scratch[want]++;
      if (parts.length >= 2) break;
    }
    if (parts.length >= 2) break;
  }
  if (!parts.length) return `You cannot reach the ${name} with the cards you hold. Hold them.`;
  if (goal !== COSTS.city && nearPort && parts.some((p) => p.includes("bank at 4:1"))) return `Do not 4:1. Road to the port. ${nearPort.text}`;
  return `${parts.join(" ")} That is for the ${name}.`;
}

export function roadBattle(myLen: number, oppLen: number, iHold: boolean, heHolds: boolean): { worth: boolean; roadsNeeded: number; text: string } {
  const target = heHolds ? oppLen + 1 : Math.max(5, oppLen + 1);
  const roadsNeeded = iHold ? 0 : Math.max(0, target - myLen);
  if (iHold && oppLen <= myLen - 2) {
    return {
      worth: false,
      roadsNeeded: 0,
      text: `You hold the longest road at ${myLen}. He is on ${oppLen}, so he needs more than one road to take it. Do not build a road only to lengthen it.`
    };
  }
  if (iHold && oppLen === myLen - 1) {
    return {
      worth: false,
      roadsNeeded: 1,
      text: `You hold it at ${myLen} and he is on ${oppLen}. He takes it if he builds two roads and you build none. Extend only when that same road also moves toward a settlement or a port.`
    };
  }
  if (heHolds && roadsNeeded >= 2) {
    return {
      worth: false,
      roadsNeeded,
      text: `Skip the road battle. You have ${myLen}, he has ${oppLen} and he holds it. Catching him takes ${roadsNeeded} roads and he can match you. Spend roads on a settlement or a port instead.`
    };
  }
  if (!iHold && roadsNeeded === 1 && myLen + 1 >= 5) {
    return {
      worth: true,
      roadsNeeded: 1,
      text: `One road makes yours ${myLen + 1}, longer than his ${oppLen}. That is the longest road, worth 2 VP. Take it when you cannot city this turn; a city is permanent income, and he can steal the road back.`
    };
  }
  if (!iHold && roadsNeeded === 2 && myLen + 2 >= 5) {
    return {
      worth: true,
      roadsNeeded: 2,
      text: `Two roads take the longest road (you ${myLen}, him ${oppLen}, 2 VP). Do it only if you are not already one road from a good settlement.`
    };
  }
  if (roadsNeeded >= 3) {
    return {
      worth: false,
      roadsNeeded,
      text: `Skip the road battle. You have ${myLen} and he has ${oppLen}. Catching him takes ${roadsNeeded} roads. Spend roads on a settlement or a port instead.`
    };
  }
  return {
    worth: false,
    roadsNeeded,
    text: `No road battle yet. You have ${myLen} and he has ${oppLen}. Longest road starts at 5 and only pays when you can take it in one or two roads.`
  };
}

function devLine(
  cards: DevCardKind[],
  known: boolean,
  hand: ResourceHand,
  robberOnMe: boolean,
  rolled: boolean,
  citySoon: boolean,
  canPlace: boolean,
  spotClose: boolean,
  battle: { worth: boolean; roadsNeeded: number; text: string },
  his: ResourceHand,
  oppHand: number,
  oppNeeds: Resource[],
  spot: RankedLiveSpot | undefined,
  holding: Resource | undefined,
  knightNote = "",
  roadBuildText?: string,
  monopolyText?: string
): string {
  const lines: string[] = [];
  if (cards.includes("knight")) {
    lines.push(
      knightNote
        ? knightNote
        : robberOnMe
          ? rolled
            ? "You already rolled, so play the knight before you pass: it still steals a card and moves the robber off you."
            : "Play the knight before you roll. The robber is on you, and playing it after the roll wastes the production."
          : "Hold the knight until the robber lands on you or until you can move it onto the hex he depends on. You may play one dev card on your turn, and never the turn you bought it."
    );
  }
  if (cards.includes("victoryPoint")) lines.push("Keep the victory point hidden. It already counts, and showing it tells him how close you are.");
  if (cards.includes("roadBuilding")) {
    const toward = spot && spot.dist <= 2 && spot.dist > 0 ? ` toward ${spot.numbers.join("/")} (${spot.pips} pips)` : "";
    lines.push(
      roadBuildText
        ? roadBuildText
        : battle.worth && battle.roadsNeeded <= 2
          ? "Play Road Building and lay both roads into the longest-road fight."
          : toward
            ? `Play Road Building${toward}. Both free roads should end on that settlement or on the road that takes the longest road.`
            : "Hold Road Building until both free roads reach a settlement or take the longest road. Playing it into an empty coast wastes the card."
    );
  }
  if (cards.includes("yearOfPlenty")) {
    const cityNeed = finishWith(hand, COSTS.city, 2);
    const settleNeed = finishWith(hand, COSTS.settlement, 2);
    const need = cityNeed ?? settleNeed;
    lines.push(
      need
        ? `Play Year of Plenty for ${need.map((r) => LABEL[r]).join(" and ")}. That finishes the ${cityNeed ? "city" : "settlement"}.`
        : "Hold Year of Plenty until two cards finish a city or a settlement."
    );
  }
  if (cards.includes("monopoly")) {
    const rich = RESOURCES.slice().sort((a, b) => his[b] - his[a])[0];
    const named = holding ?? oppNeeds[0] ?? rich;
    lines.push(
      monopolyText ? monopolyText : oppHand >= 6 ? `Play Monopoly on ${LABEL[named]} while his hand is large (${oppHand} cards).` : `Hold Monopoly. Call ${LABEL[named]} when his hand is large.`
    );
  }
  if (!lines.length) {
    if (!known) return "Buy a dev card only when a city is not close and your hand is showing. You cannot play a card on the turn you buy it.";
    if (citySoon) return "Do not buy a dev card. Finish the city. A dev card cannot be played on the turn you buy it, so it does nothing for you right now.";
    if (canPlace || spotClose) return "Settle before you buy a dev card. The settlement produces every roll; the card sits for a turn.";
    if (canPay(hand, COSTS.dev))
      return "You can pay for a dev card and nothing better is ready. Buy it, then wait a turn to play it. Three knights are the largest army (2 VP), and one card in five is a hidden point.";
    return "No dev card to play. Buy one when you can pay and a city or settlement is not closer.";
  }
  return lines.join(" ");
}

export function robberHits(ctx: BoardContext, placements: Placements, me: string, robberHex?: string): boolean {
  if (!robberHex) return false;
  for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
    if (owner !== me) continue;
    if (ctx.byAt.get(at)?.hexIds.includes(robberHex)) return true;
  }
  return false;
}
