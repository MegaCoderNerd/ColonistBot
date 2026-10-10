(() => {
  // src/extension/api.ts
  var api = globalThis.browser ?? chrome;

  // src/extension/selectors.ts
  var SEL = {
    /** Each game-log / chat row in the virtual scroller carries a running index. */
    rowIndexAttr: "data-index",
    playerPanel: "[data-player-information-container]",
    playerBlock: "[data-player-color]",
    cardCount: "[data-resource-card]",
    strongName: 'span[style*="font-weight:600"], span[style*="font-weight: 600"]',
    headerUsername: ".web-header-username"
  };
  var END_TABS = ["Overview", "Dice Stats", "Res Card Stats", "Dev Card Stats", "Activity Stats", "Resource Stats"];

  // src/extension/logScrape.ts
  var ROW_VERBS = "rolled|got|received|built|placed|bought|used|played|gave|traded|moved|stole|discarded|took|won|upgraded|claimed|offered";
  var ROW_RE = new RegExp(`^(?:Player avatar\\s+)?(?:You|[^\\s:]{1,40})\\s+(?:${ROW_VERBS})\\b`, "i");
  var MAX_ROW_CHARS = 300;
  function isHidden(el) {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    return cs ? cs.display === "none" || cs.visibility === "hidden" : false;
  }
  function textOf(node, visibleOnly = false) {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        parts.push(n.textContent ?? "");
      } else if (n.nodeType === 1) {
        const el = n;
        if (visibleOnly && isHidden(el)) return;
        if (el.tagName === "IMG") {
          const img = el;
          const name = (img.getAttribute("alt") || (img.getAttribute("src") ?? "").split("/").pop() || "").replace(/\.\w+(\?.*)?$/, "");
          if (name) parts.push(` ${name} `);
        } else {
          parts.push(" ");
          el.childNodes.forEach(walk);
          parts.push(" ");
        }
      }
    };
    walk(node);
    return parts.join("").replace(/\s+/g, " ").trim();
  }
  function stripDecor(text) {
    return text.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ").replace(/\s+/g, " ").trim();
  }
  function looksLikeRow(text) {
    const clean = stripDecor(text);
    return clean.length > 0 && clean.length <= MAX_ROW_CHARS && ROW_RE.test(clean);
  }
  function isChatText(text) {
    return /^(?:Player avatar\s+)?[^\s:]{1,40}:\s/.test(stripDecor(text));
  }
  function rowIndex(el) {
    const holder = el.closest(`[${SEL.rowIndexAttr}]`);
    const raw = holder?.getAttribute(SEL.rowIndexAttr);
    if (raw === null || raw === void 0 || raw === "") return void 0;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : void 0;
  }
  function findIndexedRows(root) {
    const found = /* @__PURE__ */ new Set();
    const own = root.closest(`[${SEL.rowIndexAttr}]`);
    if (own) found.add(own);
    root.querySelectorAll(`[${SEL.rowIndexAttr}]`).forEach((e) => found.add(e));
    return [...found].filter((e) => {
      for (let p = e.parentElement; p; p = p.parentElement) if (found.has(p)) return false;
      return true;
    });
  }
  function playerColorOf(row) {
    const name = row.querySelector(SEL.strongName);
    return name?.style?.color || void 0;
  }
  function findLogScroller(doc) {
    const first = doc.querySelector(`[${SEL.rowIndexAttr}]`);
    for (let p = first?.parentElement ?? null; p; p = p.parentElement) {
      const oy = p.ownerDocument.defaultView?.getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return first?.parentElement ?? void 0;
  }
  function missingIndexes(seen, floor, max) {
    const out = [];
    for (let i = Math.max(0, floor); i <= max; i++) if (!seen.has(i)) out.push(i);
    return out;
  }
  function iconNumbers(root, visibleOnly = false) {
    const out = [];
    let icon = "";
    const walk = (n) => {
      if (n.nodeType === 3) {
        for (const m of (n.textContent ?? "").matchAll(/-?\d+/g)) {
          out.push({ icon: icon || "number", value: Number(m[0]) });
          icon = "";
        }
      } else if (n.nodeType === 1) {
        const el = n;
        if (visibleOnly && isHidden(el)) return;
        if (el.tagName === "IMG") {
          icon = (el.getAttribute("alt") || (el.getAttribute("src") ?? "").split("/").pop() || "").replace(/\.\w+(\?.*)?$/, "");
        } else el.childNodes.forEach(walk);
      }
    };
    walk(root);
    return out;
  }
  function scrapePanel(doc, after) {
    const container = doc.querySelector(SEL.playerPanel);
    if (!container) return void 0;
    const players = [...container.querySelectorAll(SEL.playerBlock)].map((block) => {
      const cardsEl = block.querySelector(SEL.cardCount);
      const n = Number.parseInt(cardsEl?.textContent?.trim() ?? "", 10);
      return {
        color: block.getAttribute("data-player-color") ?? "",
        text: textOf(block).slice(0, 120),
        cards: Number.isNaN(n) ? void 0 : n,
        stats: iconNumbers(block).slice(0, 12)
      };
    });
    return players.length ? { after, players } : void 0;
  }
  function findRows(root) {
    const text = textOf(root);
    if (!text) return [];
    const childRows = [...root.children].flatMap((c) => findRows(c));
    if (childRows.length) return childRows;
    return looksLikeRow(text) ? [root] : [];
  }
  function previousRowText(row) {
    let el = row;
    while (el && !el.previousElementSibling) el = el.parentElement;
    const prev = el?.previousElementSibling;
    if (!prev) return "";
    const rows = findRows(prev);
    return textOf(rows.at(-1) ?? prev).slice(0, 120);
  }

  // src/extension/logCapture.ts
  var SETTLE_MS = 40;
  var LEGACY_DEDUPE_MS = 300;
  var SWEEP_COOLDOWN_MS = 4e3;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function createLogCapture(doc, onEntry) {
    let seen = /* @__PURE__ */ new Set();
    let maxIdx = -1;
    let minIdx = Number.POSITIVE_INFINITY;
    let swept = false;
    let sweeping = false;
    let lastSweepAt = 0;
    let lastSweepMissing = "";
    let legacySeen = /* @__PURE__ */ new WeakSet();
    let legacyKeys = /* @__PURE__ */ new Map();
    let pending = /* @__PURE__ */ new Set();
    let timer;
    let observer;
    let stopped = false;
    const emit = (row) => {
      const idx = rowIndex(row);
      const text = stripDecor(textOf(row));
      if (idx !== void 0) {
        if (seen.has(idx)) return;
        seen.add(idx);
        maxIdx = Math.max(maxIdx, idx);
        minIdx = Math.min(minIdx, idx);
        if (!text || isChatText(text)) return;
        onEntry({ t: Date.now(), text, idx, color: playerColorOf(row) });
        return;
      }
      if (!text || legacySeen.has(row)) return;
      legacySeen.add(row);
      const now = Date.now();
      const key = `${text}|${previousRowText(row)}`;
      const prev = legacyKeys.get(key);
      if (prev !== void 0 && now - prev < LEGACY_DEDUPE_MS) return;
      legacyKeys.set(key, now);
      if (legacyKeys.size > 500) legacyKeys = new Map([...legacyKeys].slice(-200));
      if (!isChatText(text)) onEntry({ t: now, text });
    };
    const collect = (el) => {
      const indexed = findIndexedRows(el);
      return indexed.length || maxIdx >= 0 ? indexed : findRows(el);
    };
    const flushPending = () => {
      timer = void 0;
      const rows = [...pending];
      pending = /* @__PURE__ */ new Set();
      const sorted = rows.map((row) => ({ row, idx: rowIndex(row) ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.idx - b.idx);
      for (const { row } of sorted) emit(row);
    };
    const schedule = (els) => {
      if (stopped) return;
      for (const el of els) pending.add(el);
      timer ??= setTimeout(flushPending, SETTLE_MS);
    };
    const scanNow = () => {
      const root = doc.body;
      if (root) schedule(collect(root));
    };
    const sweep = async (_reason) => {
      if (sweeping) return;
      const scroller = findLogScroller(doc);
      if (!scroller) {
        swept = true;
        return;
      }
      sweeping = true;
      lastSweepAt = Date.now();
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 6;
      const saved = scroller.scrollTop;
      try {
        scroller.scrollTop = 0;
        await sleep(140);
        scanNow();
        for (let step = 0; step < 600; step++) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + Math.max(40, scroller.clientHeight * 0.6);
          await sleep(80);
          scanNow();
          const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
          if (end || scroller.scrollTop === before) {
            await sleep(120);
            scanNow();
            break;
          }
        }
        await sleep(SETTLE_MS * 2);
      } finally {
        scroller.scrollTop = atBottom ? scroller.scrollHeight : saved;
        swept = true;
        sweeping = false;
        lastSweepMissing = missingIndexes(seen, floor(), maxIdx).join(",");
      }
    };
    let lastHeight = 0;
    let lastPeekAt = 0;
    const peek = async (scroller) => {
      sweeping = true;
      lastPeekAt = Date.now();
      const saved = scroller.scrollTop;
      try {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(120);
        scanNow();
        await sleep(SETTLE_MS * 2);
      } finally {
        scroller.scrollTop = saved;
        sweeping = false;
      }
    };
    const floor = () => swept && Number.isFinite(minIdx) ? minIdx : 0;
    return {
      start() {
        if (observer) return;
        stopped = false;
        observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            m.addedNodes.forEach((node) => {
              const el = node instanceof Element ? node : node.parentElement;
              if (el) schedule(collect(el));
            });
          }
        });
        const begin = () => {
          if (!doc.body) return;
          observer?.observe(doc.body, { childList: true, subtree: true });
          scanNow();
        };
        if (doc.body) begin();
        else doc.addEventListener("DOMContentLoaded", begin, { once: true });
      },
      reset() {
        seen = /* @__PURE__ */ new Set();
        maxIdx = -1;
        minIdx = Number.POSITIVE_INFINITY;
        swept = false;
        lastSweepMissing = "";
        legacySeen = /* @__PURE__ */ new WeakSet();
        legacyKeys = /* @__PURE__ */ new Map();
      },
      scanNow,
      tick() {
        scanNow();
        if (sweeping) return;
        const scroller = findLogScroller(doc);
        if (scroller) {
          const away = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 60;
          const grew = scroller.scrollHeight !== lastHeight;
          lastHeight = scroller.scrollHeight;
          if (away && grew && Date.now() - lastPeekAt > 2e3) {
            void peek(scroller);
            return;
          }
        }
        if (maxIdx < 0 || Date.now() - lastSweepAt < SWEEP_COOLDOWN_MS) return;
        const missing = missingIndexes(seen, floor(), maxIdx).join(",");
        if (missing && missing !== lastSweepMissing) void sweep("gap");
      },
      sweep,
      status() {
        return {
          seen: seen.size,
          maxIdx,
          missing: maxIdx < 0 ? 0 : missingIndexes(seen, floor(), maxIdx).length,
          swept,
          sweeping
        };
      },
      stop() {
        stopped = true;
        observer?.disconnect();
        observer = void 0;
        if (timer) clearTimeout(timer);
        timer = void 0;
        pending = /* @__PURE__ */ new Set();
      }
    };
  }

  // src/analyzer/types.ts
  var RESOURCES = ["lumber", "brick", "wool", "grain", "ore"];

  // src/analyzer/adapters/logText.ts
  var RESOURCE_WORDS = [
    [/^(?:card[_-]?|res(?:ource)?[_-]?)?(lumber|wood|tree|forest)s?$/i, "lumber"],
    [/^(?:card[_-]?|res(?:ource)?[_-]?)?(brick|clay|hill)s?$/i, "brick"],
    [/^(?:card[_-]?|res(?:ource)?[_-]?)?(wool|sheep|pasture)s?$/i, "wool"],
    [/^(?:card[_-]?|res(?:ource)?[_-]?)?(grain|wheat|field)s?$/i, "grain"],
    [/^(?:card[_-]?|res(?:ource)?[_-]?)?(ore|stone|mountain)s?$/i, "ore"]
  ];
  function resourceCards(fragment) {
    const cards = {};
    for (const token of fragment.split(/[^A-Za-z_-]+/)) {
      if (!token) continue;
      for (const [re, resource] of RESOURCE_WORDS) {
        if (re.test(token)) {
          cards[resource] = (cards[resource] ?? 0) + 1;
          break;
        }
      }
    }
    return cards;
  }
  function firstResource(fragment) {
    return RESOURCES.find((r) => (resourceCards(fragment)[r] ?? 0) > 0);
  }
  var CARD_NAMES = [
    [/knight|soldier/i, "knight"],
    [/year of plenty/i, "yearOfPlenty"],
    [/monopoly/i, "monopoly"],
    [/road building/i, "roadBuilding"],
    [/victory point|\bvp\b/i, "victoryPoint"]
  ];
  function cardFrom(text) {
    return CARD_NAMES.find(([re]) => re.test(text))?.[1];
  }
  function normalizeRow(text) {
    return text.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ").replace(/\bPlayer avatar\b/gi, " ").replace(/\s+/g, " ").trim();
  }
  var VIEWER = "You";
  var NOISE = /\b(is blocked by the Robber|wants to give|proposed counter offer|Learn how to play|will take over|has disconnected|has reconnected)\b|\b(has left|have left|left the (game|room)|has joined|joined the (game|room)|disconnected|reconnected|rejoined|was kicked|votes?|spectat|is now ready|game (is )?starting)\b/i;
  var CHAT = /^\S+:\s/;
  var you = (name, me2) => name && /^you$/i.test(name) ? me2 ?? VIEWER : name;
  function parseRow(text, rolls, me2) {
    let m;
    const event = (draft, subject) => ({ kind: "event", draft, subject });
    const who = (name) => you(name, me2);
    if (CHAT.test(text) || NOISE.test(text)) return { kind: "ignored" };
    if (m = /^(\S+) rolled\b.*?dice[_ ]?([1-6])\D+dice[_ ]?([1-6])/i.exec(text)) {
      const d1 = Number(m[2]);
      const d2 = Number(m[3]);
      return event({ type: "roll", player: who(m[1]), d1, d2, total: d1 + d2 }, who(m[1]));
    }
    if ((m = /^(\S+) rolled\b\D{0,12}(\d{1,2})\b/i.exec(text)) && Number(m[2]) >= 2 && Number(m[2]) <= 12) {
      return event({ type: "roll", player: who(m[1]), total: Number(m[2]) }, who(m[1]));
    }
    if (m = /^(\S+) (?:placed|built)\b.*?\b(road|settlement|city)\b/i.exec(text)) {
      return event({ type: "build", player: who(m[1]), piece: m[2].toLowerCase(), setup: rolls === 0 }, who(m[1]));
    }
    if (m = /^(\S+) (?:upgraded|upgrade)\b.*\bcity\b/i.exec(text)) {
      return event({ type: "build", player: who(m[1]), piece: "city", setup: false }, who(m[1]));
    }
    if (m = /^(\S+) bought\b.*\b(?:development|dev)\b/i.exec(text)) {
      return event({ type: "devBuy", player: who(m[1]) }, who(m[1]));
    }
    if (m = /^(\S+) (?:used|played)\b(.*)$/i.exec(text)) {
      const card = cardFrom(m[2]);
      if (card) return event({ type: "devPlay", player: who(m[1]), card }, who(m[1]));
    }
    if (m = /^(\S+) (?:moved|placed)\b.*\brobber\b/i.exec(text)) {
      return event({ type: "robberMove", player: who(m[1]) }, who(m[1]));
    }
    if ((m = /^(\S+) stole\s+(\d+)\b(.*)$/i.exec(text)) && !/\bfrom\b/i.test(m[3])) {
      const resource = firstResource(m[3]);
      if (resource) return event({ type: "monopoly", player: who(m[1]), cards: { [resource]: Number(m[2]) } }, who(m[1]));
    }
    if (m = /^(\S+) stole\b(.*?)\bfrom (\S+)/i.exec(text)) {
      return event({ type: "steal", player: who(m[1]), victim: who(m[3]), card: firstResource(m[2]) }, who(m[1]));
    }
    if ((m = /^(\S+) gave bank\b(.*?)\band took\b(.*)$/i.exec(text)) || (m = /^(\S+) traded\b(.*?)\bwith the bank\b(.*)$/i.exec(text))) {
      return event({ type: "bankTrade", player: who(m[1]), gave: resourceCards(m[2]), got: resourceCards(m[3]) }, who(m[1]));
    }
    if (m = /^(\S+) (?:traded|gave)\b(.*?)\b(?:and took|and got|for)\b(.*?)\b(?:with|from) (\S+)\s*$/i.exec(text)) {
      return event({ type: "trade", player: who(m[1]), partner: who(m[4]), gave: resourceCards(m[2]), got: resourceCards(m[3]) }, who(m[1]));
    }
    if (m = /^(\S+) discarded\b(.*)$/i.exec(text)) {
      return event({ type: "discard", player: who(m[1]), cards: resourceCards(m[2]) }, who(m[1]));
    }
    if ((m = /^(\S+) .*\blongest road\b/i.exec(text)) && /received|took|got|has|claimed|gained/i.test(text)) {
      return event({ type: "longestRoad", player: who(m[1]) }, who(m[1]));
    }
    if ((m = /^(\S+) .*\blargest army\b/i.exec(text)) && /received|took|got|has|claimed|gained/i.test(text)) {
      return event({ type: "largestArmy", player: who(m[1]) }, who(m[1]));
    }
    if (m = /^(\S+) won the game/i.exec(text)) {
      return event({ type: "gameEnd", winner: who(m[1]) }, who(m[1]));
    }
    if (m = /^(\S+) took from bank\b(.*)$/i.exec(text)) {
      const cards = resourceCards(m[2]);
      if (Object.keys(cards).length) return event({ type: "gain", player: who(m[1]), cards, source: "other" }, who(m[1]));
    }
    if (m = /^(\S+) (?:got|received)\b(.*)$/i.exec(text)) {
      const cards = resourceCards(m[2]);
      if (Object.keys(cards).length) return event({ type: "gain", player: who(m[1]), cards, source: "other" }, who(m[1]));
    }
    return { kind: "unparsed" };
  }
  function unparsedKey(text) {
    return text.replace(/^\S+/, "<player>").replace(/\d+/g, "#").slice(0, 120);
  }
  var LogParser = class {
    events = [];
    players = /* @__PURE__ */ new Map();
    unparsed = /* @__PURE__ */ new Map();
    parsed = 0;
    ignored = 0;
    afterRoll = false;
    freeRoads = /* @__PURE__ */ new Map();
    rolls = 0;
    me;
    constructor(me2) {
      this.me = me2;
    }
    push(entry) {
      const text = normalizeRow(entry.text);
      if (!text) return { kind: "ignored" };
      const result = parseRow(text, this.rolls, this.me);
      if (result.kind === "ignored") {
        this.ignored++;
        return result;
      }
      if (result.kind === "unparsed") {
        const key = unparsedKey(text);
        const prev = this.unparsed.get(key);
        this.unparsed.set(key, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? text });
        this.afterRoll = false;
        return result;
      }
      this.parsed++;
      const draft = result.draft;
      if (draft.type === "roll") {
        this.rolls++;
        this.afterRoll = true;
      } else if (draft.type === "gain") {
        draft.source = this.afterRoll ? "roll" : "other";
      } else {
        this.afterRoll = false;
      }
      if (result.subject && !this.players.has(result.subject)) this.players.set(result.subject, { id: result.subject, name: result.subject });
      if (draft.type === "roll") this.freeRoads.clear();
      else if (draft.type === "devPlay" && draft.card === "roadBuilding") this.freeRoads.set(draft.player, 2);
      else if (draft.type === "build" && draft.piece === "road" && !draft.setup && (this.freeRoads.get(draft.player) ?? 0) > 0) {
        this.freeRoads.set(draft.player, (this.freeRoads.get(draft.player) ?? 0) - 1);
        draft.free = true;
      }
      const event = { ...draft, t: entry.t, turn: this.rolls };
      this.events.push(event);
      return { kind: "event", event };
    }
    stats() {
      const unparsedRows = [...this.unparsed.entries()].map(([text, v]) => ({ text, count: v.count, example: v.example })).sort((a, b) => b.count - a.count);
      const unparsed = unparsedRows.reduce((s, r) => s + r.count, 0);
      return { total: this.parsed + this.ignored + unparsed, parsed: this.parsed, ignored: this.ignored, unparsed, unparsedRows };
    }
  };

  // src/analyzer/rules.ts
  var COLONIST_1V1_RULES = {
    victoryPoints: 15,
    discardLimit: 9,
    friendlyRobber: true,
    friendlyRobberMaxVp: 2,
    balancedDice: true,
    hiddenBank: true
  };

  // src/analyzer/tracker.ts
  var COSTS = {
    road: { brick: 1, lumber: 1 },
    settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
    city: { grain: 2, ore: 3 },
    dev: { ore: 1, wool: 1, grain: 1 }
  };
  var emptyHand = () => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
  var handTotal = (h2) => RESOURCES.reduce((s, r) => s + h2[r], 0);
  function canPay(hand, unknown, cost) {
    let missing = 0;
    for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
    if (missing === 0) return "yes";
    return missing <= unknown ? "maybe" : "no";
  }
  var HandTracker = class _HandTracker {
    players = /* @__PURE__ */ new Map();
    rules;
    rolls = 0;
    roadBuildingLeft = /* @__PURE__ */ new Map();
    constructor(rules = COLONIST_1V1_RULES) {
      this.rules = rules;
    }
    ensure(name) {
      let p = this.players.get(name);
      if (!p) {
        p = { hand: emptyHand(), unknown: 0, unknownLoss: 0, devBought: 0, devPlayed: 0, knights: 0, warnings: [] };
        this.players.set(name, p);
      }
      return p;
    }
    names() {
      return [...this.players.keys()];
    }
    add(name, cards, sign, why) {
      if (!cards) return;
      const p = this.ensure(name);
      for (const r of RESOURCES) {
        const n = cards[r] ?? 0;
        if (!n) continue;
        if (sign === 1) p.hand[r] += n;
        else {
          if (p.hand[r] < n) {
            const short = n - p.hand[r];
            const covered = Math.min(short, p.unknown);
            p.unknown -= covered;
            if (short > covered) p.warnings.push(`${why}: log says ${name} spent ${n} ${r} but only ${p.hand[r] + covered} were tracked`);
            p.hand[r] = 0;
          } else p.hand[r] -= n;
        }
      }
    }
    apply(e) {
      switch (e.type) {
        case "roll":
          if (e.player) this.ensure(e.player);
          this.rolls++;
          this.roadBuildingLeft.clear();
          break;
        case "gain":
          this.add(e.player, e.cards, 1, "gain");
          break;
        case "build": {
          this.ensure(e.player);
          if (e.setup) break;
          if (e.piece === "road" && e.free) break;
          this.add(e.player, COSTS[e.piece], -1, `build ${e.piece}`);
          break;
        }
        case "devBuy": {
          this.add(e.player, COSTS.dev, -1, "development card");
          this.ensure(e.player).devBought++;
          break;
        }
        case "devPlay": {
          const p = this.ensure(e.player);
          p.devPlayed++;
          if (e.card === "knight") p.knights++;
          break;
        }
        case "bankTrade":
          this.add(e.player, e.gave, -1, "bank trade");
          this.add(e.player, e.got, 1, "bank trade");
          break;
        case "trade":
          this.add(e.player, e.gave, -1, "trade");
          this.add(e.player, e.got, 1, "trade");
          if (e.partner) {
            this.add(e.partner, e.got, -1, "trade");
            this.add(e.partner, e.gave, 1, "trade");
          }
          break;
        case "discard":
          this.add(e.player, e.cards, -1, "discard");
          break;
        case "steal": {
          if (!e.victim) break;
          if (e.card) {
            this.add(e.victim, { [e.card]: 1 }, -1, "steal");
            this.add(e.player, { [e.card]: 1 }, 1, "steal");
          } else {
            const victim = this.ensure(e.victim);
            if (victim.unknown > 0) victim.unknown--;
            else victim.unknownLoss++;
            this.ensure(e.player).unknown++;
          }
          break;
        }
        case "monopoly": {
          const thief = this.ensure(e.player);
          for (const r of RESOURCES) {
            const n = e.cards[r] ?? 0;
            if (!n) continue;
            let taken = 0;
            for (const [name, p] of this.players) {
              if (name === e.player) continue;
              taken += p.hand[r];
              p.hand[r] = 0;
            }
            if (taken !== n) thief.warnings.push(`Monopoly took ${n} ${r} but the tracker expected ${taken}`);
            thief.hand[r] += n;
          }
          break;
        }
        default:
          break;
      }
    }
    /** Manual correction from the overlay. */
    adjust(name, resource, delta) {
      const p = this.ensure(name);
      p.hand[resource] = Math.max(0, p.hand[resource] + delta);
    }
    /** Converts unexplained cards into a known resource, for example after the user spots a missed row. */
    resolveUnknown(name, resource) {
      const p = this.ensure(name);
      if (p.unknown > 0) {
        p.unknown--;
        p.hand[resource]++;
      }
    }
    setPanelCards(name, cards) {
      this.ensure(name).panelCards = cards;
    }
    clearWarnings(name) {
      this.ensure(name).warnings = [];
    }
    view(name) {
      const p = this.ensure(name);
      const total2 = handTotal(p.hand) + p.unknown;
      const delta = p.panelCards === void 0 ? 0 : p.panelCards - total2;
      const odds = {};
      for (const r of RESOURCES) odds[r] = total2 ? p.hand[r] / total2 : 0;
      return {
        name,
        hand: { ...p.hand },
        unknown: p.unknown,
        total: total2,
        panelCards: p.panelCards,
        delta,
        synced: p.panelCards === void 0 ? void 0 : delta === 0,
        devBought: p.devBought,
        devPlayed: p.devPlayed,
        devUnplayed: Math.max(0, p.devBought - p.devPlayed),
        knights: p.knights,
        afford: {
          road: canPay(p.hand, p.unknown, COSTS.road),
          settlement: canPay(p.hand, p.unknown, COSTS.settlement),
          city: canPay(p.hand, p.unknown, COSTS.city),
          dev: canPay(p.hand, p.unknown, COSTS.dev)
        },
        discardOnSeven: total2 > this.rules.discardLimit ? Math.floor(total2 / 2) : 0,
        stealOdds: odds,
        warnings: [...p.warnings]
      };
    }
    views() {
      return this.names().map((n) => this.view(n));
    }
    /** Persistable copy. */
    toJSON() {
      return {
        players: Object.fromEntries(
          [...this.players].map(([name, p]) => [name, { hand: p.hand, unknown: p.unknown, unknownLoss: p.unknownLoss, devBought: p.devBought, devPlayed: p.devPlayed, knights: p.knights }])
        )
      };
    }
    static restore(saved, rules) {
      const t = new _HandTracker(rules);
      for (const [name, s] of Object.entries(saved.players)) {
        const p = t.ensure(name);
        p.hand = { ...emptyHand(), ...s.hand };
        p.unknown = s.unknown;
        p.unknownLoss = s.unknownLoss;
        p.devBought = s.devBought;
        p.devPlayed = s.devPlayed;
        p.knights = s.knights;
      }
      return t;
    }
  };
  function panelCardsByName(snapshot, names) {
    const out = {};
    if (!snapshot) return out;
    const sorted = [...names].sort((a, b) => b.length - a.length);
    for (const block of snapshot.players) {
      if (block.cards === void 0) continue;
      const name = sorted.find((n) => block.text.includes(n));
      if (name && !(name in out)) out[name] = block.cards;
    }
    return out;
  }

  // src/extension/liveEngine.ts
  var NO_INDEX_BASE = 1e9;
  var LiveEngine = class {
    rows = /* @__PURE__ */ new Map();
    parser;
    tracker;
    lastIdx = -1;
    dirty = false;
    panel;
    adjustments = /* @__PURE__ */ new Map();
    me;
    noIndex = 0;
    rules;
    lastRowAt = 0;
    winner;
    constructor(me2, rules = COLONIST_1V1_RULES) {
      this.rules = rules;
      this.me = me2;
      this.parser = new LogParser(me2);
      this.tracker = new HandTracker(rules);
    }
    setMe(me2) {
      if (me2 && me2 !== this.me) {
        this.me = me2;
        this.dirty = true;
      }
    }
    reset() {
      this.rows = /* @__PURE__ */ new Map();
      this.adjustments = /* @__PURE__ */ new Map();
      this.lastIdx = -1;
      this.noIndex = 0;
      this.winner = void 0;
      this.rebuildNow();
    }
    addEntry(entry) {
      if (entry.panel || !entry.text) return;
      const idx = entry.idx ?? NO_INDEX_BASE + this.noIndex++;
      if (this.rows.has(idx)) return;
      this.rows.set(idx, entry);
      this.lastRowAt = Date.now();
      if (this.dirty || idx < this.lastIdx) {
        this.dirty = true;
        return;
      }
      this.lastIdx = idx;
      this.applyRow(entry);
    }
    applyRow(entry) {
      const r = this.parser.push(entry);
      if (r.kind === "event") {
        this.tracker.apply(r.event);
        if (r.event.type === "gameEnd") this.winner = r.event.winner;
      }
    }
    rebuildNow() {
      this.parser = new LogParser(this.me);
      this.tracker = new HandTracker(this.rules);
      this.winner = void 0;
      const sorted = [...this.rows.entries()].sort((a, b) => a[0] - b[0]);
      for (const [idx, entry] of sorted) {
        this.applyRow(entry);
        this.lastIdx = idx;
      }
      for (const [key, delta] of this.adjustments) {
        const [name, resource] = key.split("|");
        this.tracker.adjust(name, resource, delta);
      }
      this.dirty = false;
      this.applyPanel();
    }
    setPanel(snapshot) {
      this.panel = snapshot;
      if (!this.dirty) this.applyPanel();
    }
    applyPanel() {
      const counts = panelCardsByName(this.panel, this.tracker.names());
      for (const name of this.tracker.names()) this.tracker.setPanelCards(name, counts[name]);
    }
    adjust(name, resource, delta) {
      if (this.dirty) this.rebuildNow();
      this.tracker.adjust(name, resource, delta);
      const key = `${name}|${resource}`;
      this.adjustments.set(key, (this.adjustments.get(key) ?? 0) + delta);
    }
    clearAdjustments() {
      this.adjustments = /* @__PURE__ */ new Map();
      this.dirty = true;
    }
    adjustmentsJSON() {
      return Object.fromEntries(this.adjustments);
    }
    loadAdjustments(saved) {
      this.adjustments = new Map(Object.entries(saved).filter(([, v]) => v));
      this.dirty = true;
    }
    adjustmentCount() {
      return [...this.adjustments.values()].filter(Boolean).length;
    }
    views() {
      if (this.dirty) this.rebuildNow();
      const views = this.tracker.views();
      const me2 = this.me;
      return views.sort((a, b) => Number(b.name === me2) - Number(a.name === me2) || a.name.localeCompare(b.name));
    }
    rowCount() {
      return this.rows.size;
    }
    /** Row indexes between the first and last seen row that have not been received. */
    missingCount() {
      const idxs = [...this.rows.keys()].filter((i) => i < NO_INDEX_BASE);
      if (!idxs.length) return 0;
      return Math.max(...idxs) - Math.min(...idxs) + 1 - idxs.length;
    }
    /** Time of the first "<name> placed a ..." row, used to match a log name to a network player. */
    firstPlacedAt(name) {
      const re = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+placed a\\b`, "i");
      let best;
      for (const row of this.rows.values()) if (re.test(row.text) && (best === void 0 || row.t < best)) best = row.t;
      return best;
    }
    /** Settlements this player placed or built, from the log rows read so far. */
    loggedSettlements(name) {
      const re = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(placed|built) an? settlement\\b`, "i");
      let n = 0;
      for (const row of this.rows.values()) if (re.test(row.text)) n++;
      return n;
    }
    /** True once the first dice roll is in; before that nobody holds more than their starting cards. */
    rolls() {
      return this.parser.rolls;
    }
  };

  // src/analyzer/replay.ts
  function pips(n) {
    return n === null || n === 7 ? 0 : 6 - Math.abs(7 - n);
  }
  function cornerHexKeys(x, y, z) {
    return z === 0 ? [`${x},${y}`, `${x + 1},${y - 1}`, `${x},${y - 1}`] : [`${x},${y}`, `${x},${y + 1}`, `${x - 1},${y + 1}`];
  }
  function hexesAtCorner(board, at) {
    const [x, y, z] = at.split(",").map(Number);
    if ([x, y, z].some(Number.isNaN)) return [];
    const byCoord = new Map(board.hexes.map((h2) => [`${h2.x},${h2.y}`, h2]));
    return cornerHexKeys(x, y, z).flatMap((k) => byCoord.get(k) ?? []);
  }

  // src/analyzer/geometry.ts
  var SQRT3 = Math.sqrt(3);
  function hexCenter(x, y, size = 1) {
    return { x: size * SQRT3 * (x + y / 2), y: size * 1.5 * y };
  }
  function cornerPoint(at, size = 1) {
    const [x, y, z] = at.split(",").map(Number);
    if ([x, y, z].some(Number.isNaN)) return void 0;
    const c = hexCenter(x, y, size);
    return { x: c.x, y: c.y + (z === 0 ? -size : size) };
  }
  var EDGE_NEIGHBOUR = [
    [0, -1],
    [-1, 0],
    [-1, 1]
  ];
  function edgePoints(at, size = 1) {
    const [x, y, z] = at.split(",").map(Number);
    if ([x, y, z].some(Number.isNaN)) return void 0;
    const c = hexCenter(x, y, size);
    const top = { x: c.x, y: c.y - size };
    const upperLeft = { x: c.x - SQRT3 / 2 * size, y: c.y - size / 2 };
    const lowerLeft = { x: c.x - SQRT3 / 2 * size, y: c.y + size / 2 };
    const bottom = { x: c.x, y: c.y + size };
    if (z === 0) return [top, upperLeft];
    if (z === 1) return [upperLeft, lowerLeft];
    if (z === 2) return [lowerLeft, bottom];
    return void 0;
  }
  var DEFAULT_VIEW = { rot: 0, flip: false };
  function normalizeView(v) {
    const o = v ?? {};
    const rot = Number.isInteger(o.rot) ? (o.rot % 12 + 12) % 12 : 0;
    return { rot, flip: o.flip === true };
  }
  function mirrorView(v, vertical = false) {
    return { flip: !v.flip, rot: (((vertical ? 6 : 0) - v.rot) % 12 + 12) % 12 };
  }
  function turnView(v, steps) {
    return { ...v, rot: ((v.rot + steps) % 12 + 12) % 12 };
  }
  function viewPoint(p, view = DEFAULT_VIEW) {
    const x = view.flip ? -p.x : p.x;
    const a = view.rot * Math.PI / 6;
    return { x: x * Math.cos(a) - p.y * Math.sin(a), y: x * Math.sin(a) + p.y * Math.cos(a) };
  }
  var PORT_RESOURCES = ["lumber", "brick", "wool", "grain", "ore"];
  function portKind(type) {
    if (type === 1) return "any";
    return PORT_RESOURCES[type - 2];
  }
  function portAnchor(board, port, size = 1) {
    const edge = edgePoints(port.at, size);
    if (!edge) return void 0;
    const [x, y, z] = port.at.split(",").map(Number);
    const [dx, dy] = EDGE_NEIGHBOUR[z] ?? [0, 0];
    const land = new Set(board.hexes.map((h2) => `${h2.x},${h2.y}`));
    const here = land.has(`${x},${y}`);
    const there = land.has(`${x + dx},${y + dy}`);
    if (here === there) return void 0;
    const mid = { x: (edge[0].x + edge[1].x) / 2, y: (edge[0].y + edge[1].y) / 2 };
    const landHex = here ? { x, y } : { x: x + dx, y: y + dy };
    const lc = hexCenter(landHex.x, landHex.y, size);
    const len = Math.hypot(mid.x - lc.x, mid.y - lc.y) || 1;
    return { edge, mid, out: { x: (mid.x - lc.x) / len, y: (mid.y - lc.y) / len } };
  }
  function hexCornerIds(x, y) {
    return [`${x},${y},0`, `${x + 1},${y - 1},1`, `${x},${y + 1},0`, `${x},${y},1`, `${x - 1},${y + 1},0`, `${x},${y - 1},1`];
  }
  function pointKey(p) {
    return `${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)}`;
  }
  function boardCorners(board, size = 1) {
    const portAt = [];
    for (const port of board.ports ?? []) {
      const edge = edgePoints(port.at, size);
      if (edge) for (const p of edge) portAt.push({ p, kind: port.kind });
    }
    const byCoord = new Map(board.hexes.map((h2) => [`${h2.x},${h2.y}`, h2]));
    const seen = /* @__PURE__ */ new Map();
    for (const hex of board.hexes) {
      for (const at of hexCornerIds(hex.x, hex.y)) {
        if (seen.has(at)) continue;
        const [x, y, z] = at.split(",").map(Number);
        const touching = cornerHexKeys(x, y, z).flatMap((k) => byCoord.get(k) ?? []);
        const point = cornerPoint(at, size);
        if (!point) continue;
        seen.set(at, {
          at,
          point,
          pips: touching.reduce((s, h2) => s + pips(h2.number), 0),
          resources: touching.flatMap((h2) => h2.resource ? [h2.resource] : []),
          numbers: touching.flatMap((h2) => h2.number ? [h2.number] : []),
          hexIds: touching.map((h2) => h2.id),
          port: portAt.find((q) => Math.hypot(q.p.x - point.x, q.p.y - point.y) < size * 0.05)?.kind
        });
      }
    }
    return [...seen.values()];
  }
  function boardBounds(board, size = 1, pad = 1.2, view = DEFAULT_VIEW) {
    const pts = board.hexes.flatMap((h2) => {
      const c = hexCenter(h2.x, h2.y, size);
      return hexVertices(c, size).map((v) => viewPoint(v, view));
    });
    const margin = (pad - 1) * size;
    const minX = Math.min(...pts.map((p) => p.x)) - margin;
    const maxX = Math.max(...pts.map((p) => p.x)) + margin;
    const minY = Math.min(...pts.map((p) => p.y)) - margin;
    const maxY = Math.max(...pts.map((p) => p.y)) + margin;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }
  function hexVertices(c, size = 1) {
    return [0, 1, 2, 3, 4, 5].map((k) => {
      const a = Math.PI / 180 * (60 * k - 90);
      return { x: c.x + size * Math.cos(a), y: c.y + size * Math.sin(a) };
    });
  }

  // src/extension/endscreen.ts
  var LABELS = END_TABS;
  var WINDOW_HINT = /well played|victory|defeat|game over|won the game|winner/i;
  var ACTIVE_CLASS = /(^|[\s_-])(active|selected|current)([\s_-]|$)/i;
  function findTabs(doc) {
    const found = /* @__PURE__ */ new Map();
    const body = doc.body;
    if (!body) return found;
    const text = body.textContent ?? "";
    if (!text.includes("Dice Stats") || !text.includes("Res Card Stats")) return found;
    for (const el of body.querySelectorAll("*")) {
      if (el.children.length > 1) continue;
      const label = (el.textContent ?? "").trim();
      if (LABELS.includes(label) && !found.has(label) && !isHidden(el)) found.set(label, el);
    }
    return found;
  }
  function commonAncestor(els) {
    let node = els[0] ?? null;
    while (node && !els.every((e) => node.contains(e))) node = node.parentElement;
    return node;
  }
  function windowRoot(doc, tabEls) {
    const bar = commonAncestor(tabEls);
    if (!bar) return null;
    let node = bar;
    for (let i = 0; i < 8 && node && node !== doc.body; i++) {
      if (WINDOW_HINT.test(textOf(node, true))) return node;
      node = node.parentElement;
    }
    return bar.parentElement && bar.parentElement !== doc.body ? bar.parentElement : bar;
  }
  var styleSig = (el) => {
    const view = el.ownerDocument.defaultView;
    if (!view) return "";
    return [el, el.parentElement].map((e) => {
      if (!e) return "";
      const cs = view.getComputedStyle(e);
      return [cs.color, cs.fontWeight, cs.backgroundColor, cs.borderBottomColor, cs.borderBottomWidth, cs.opacity].join("|");
    }).join("//");
  };
  function activeTab(tabs, clicked) {
    const entries = [...tabs.entries()];
    const els = entries.map(([, e]) => e);
    const flagged = entries.filter(([, el]) => {
      let e = el;
      for (let i = 0; i < 3 && e; i++, e = e.parentElement) {
        if (els.some((o) => o !== el && e.contains(o))) return false;
        if (e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-current") === "true" || e.getAttribute("data-state") === "active") return true;
        if (ACTIVE_CLASS.test(e.getAttribute("class") ?? "")) return true;
      }
      return false;
    });
    if (flagged.length === 1) return { name: flagged[0][0], source: "aria" };
    const groups = /* @__PURE__ */ new Map();
    for (const [name, el] of entries) groups.set(styleSig(el), [...groups.get(styleSig(el)) ?? [], name]);
    if (groups.size === 2) {
      const single = [...groups.values()].filter((g) => g.length === 1);
      if (single.length === 1 && entries.length >= 4) return { name: single[0][0], source: "style" };
    }
    if (clicked && tabs.has(clicked)) return { name: clicked, source: "click" };
    return { name: tabs.has("Overview") ? "Overview" : null, source: tabs.has("Overview") ? "default" : null };
  }
  function extractRows(root, firstTab, names) {
    const rows = [];
    const trs = [...root.querySelectorAll('tr, [role="row"]')].filter((tr) => !isHidden(tr));
    if (trs.length) {
      for (const tr of trs) {
        const text = textOf(tr, true);
        if (!text) continue;
        const player = names.find((n) => text.includes(n)) ?? text.split(" ")[0];
        rows.push({ player, values: iconNumbers(tr, true), text });
      }
      return rows;
    }
    if (names.length < 2) return rows;
    const leaves = [...root.querySelectorAll("*")].filter((el) => el.children.length === 0 && !isHidden(el));
    for (const name of names) {
      const hit = leaves.find((el) => (el.textContent ?? "").includes(name) && Boolean(firstTab.compareDocumentPosition(el) & 4));
      if (!hit) continue;
      let row = hit;
      while (row.parentElement && row.parentElement !== root) {
        const text = row.parentElement.textContent ?? "";
        if (names.some((o) => o !== name && text.includes(o))) break;
        row = row.parentElement;
      }
      rows.push({ player: name, values: iconNumbers(row, true), text: textOf(row, true) });
    }
    return rows;
  }
  function createEndScreen(doc, opts) {
    const stableMs = opts.stableMs ?? 700;
    const end = { header: "", tabs: {} };
    let open = false;
    let wasOpen = false;
    let clicked = null;
    let state = { open: false, active: null, activeSource: null, captured: [], missing: [...END_TABS], next: "Overview" };
    let pending = { key: "", since: 0 };
    let lastCheck = 0;
    const onClick = (ev) => {
      const label = (ev.target?.textContent ?? "").trim();
      if (LABELS.includes(label)) clicked = label;
    };
    doc.addEventListener("click", onClick, true);
    function refreshState(active, source) {
      const captured = END_TABS.filter((t) => end.tabs[t]);
      const missing = END_TABS.filter((t) => !end.tabs[t]);
      const after = active ? missing.filter((t) => END_TABS.indexOf(t) > END_TABS.indexOf(active)) : [];
      state = { open, active, activeSource: source, captured, missing, next: after[0] ?? missing[0] ?? null };
    }
    function tick(now = Date.now()) {
      if (now - lastCheck < (open ? 250 : 600)) return state;
      lastCheck = now;
      const tabs = findTabs(doc);
      if (tabs.size < 4) {
        open = false;
        if (wasOpen) {
          wasOpen = false;
          refreshState(null, null);
          opts.onClosed();
        }
        return state;
      }
      open = true;
      wasOpen = true;
      const tabEls = [...tabs.values()];
      const root = windowRoot(doc, tabEls);
      const { name, source } = activeTab(tabs, clicked);
      refreshState(name, source);
      if (!root || !name) return state;
      const full = textOf(root, true);
      const firstLabel = [...tabs.values()].map((e) => textOf(e, true))[0];
      const cut = full.indexOf(firstLabel);
      const header = cut > 0 ? full.slice(0, cut).trim() : "";
      let content = cut >= 0 ? full.slice(cut) : full;
      for (const label of tabs.keys()) content = content.replace(label, " ");
      content = content.replace(/\s+/g, " ").trim();
      const key = `${name}|${content}`;
      if (key !== pending.key) {
        pending = { key, since: now };
        return state;
      }
      if (now - pending.since < stableMs || !content) return state;
      const existing = end.tabs[name];
      if (existing && existing.text === content) return state;
      const firstTab = tabEls.reduce((a, b) => a.compareDocumentPosition(b) & 4 ? a : b);
      const names = opts.names();
      end.tabs[name] = { text: content, rows: extractRows(root, firstTab, names), t: Date.now() };
      if (header) end.header = header;
      refreshState(name, source);
      opts.onCapture(end, name, !existing);
      return state;
    }
    return {
      tick,
      state: () => state,
      capture: () => end,
      reset() {
        for (const k of Object.keys(end.tabs)) delete end.tabs[k];
        end.header = "";
        open = false;
        wasOpen = false;
        clicked = null;
        pending = { key: "", since: 0 };
        refreshState(null, null);
      },
      stop: () => doc.removeEventListener("click", onClick, true)
    };
  }
  var PROMPT_CSS = `
:host { all: initial }
.box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646; max-width: min(92vw, 560px);
  font: 13px/1.4 system-ui, sans-serif; color: #f4f1e8; background: #20262eef; border: 1px solid #c9a227; border-radius: 10px;
  padding: 10px 14px; box-shadow: 0 8px 30px #0008 }
.title { font-weight: 700; margin-bottom: 6px }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px }
.chip { padding: 2px 8px; border-radius: 999px; border: 1px solid #5a6572; font-size: 12px }
.chip.done { background: #2e7d4f; border-color: #2e7d4f }
.chip.next { border-color: #c9a227; color: #ffd75e; font-weight: 700 }
.chip.here { outline: 1px dashed #9ec1ff }
`;
  function createEndPrompt(doc) {
    const host = doc.createElement("div");
    host.setAttribute("data-colonist-recorder", "end-prompt");
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = PROMPT_CSS;
    const box = doc.createElement("div");
    box.className = "box";
    root.append(style, box);
    host.style.display = "none";
    return {
      host,
      setVisible(on) {
        host.style.display = on ? "" : "none";
      },
      render(s, extra) {
        const title = doc.createElement("div");
        title.className = "title";
        if (extra?.done) title.textContent = extra.done;
        else if (!s.open) title.textContent = "";
        else if (s.next) title.textContent = `Game over: ${s.captured.length} of ${END_TABS.length} stats tabs saved. Next, click ${s.next}.`;
        else title.textContent = "All six stats tabs saved. Close this window to save the final board.";
        const chips = doc.createElement("div");
        chips.className = "tabs";
        for (const t of END_TABS) {
          const chip = doc.createElement("span");
          chip.className = `chip${s.captured.includes(t) ? " done" : ""}${s.next === t ? " next" : ""}${s.active === t ? " here" : ""}`;
          chip.textContent = `${s.captured.includes(t) ? "\u2713 " : ""}${t}`;
          chips.append(chip);
        }
        box.replaceChildren(title, ...extra?.done ? [] : [chips]);
      }
    };
  }

  // src/analyzer/engine/ports.ts
  function portsNear(ctx, at, max = 2) {
    const out = [];
    const seen = /* @__PURE__ */ new Set([at]);
    let ring = [at];
    for (let dist = 0; dist <= max; dist++) {
      const next = [];
      for (const id of ring) {
        const port = ctx.byAt.get(id)?.port;
        if (port) out.push({ at: id, kind: port, dist });
        if (dist === max) continue;
        for (const n of ctx.nbrs.get(id) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      ring = next;
    }
    return out;
  }
  var LABEL = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  function productionOf(kind, own, here) {
    if (kind === "any") return RESOURCES.reduce((s, r) => s + own[r] + here[r], 0);
    return own[kind] + here[kind];
  }
  function portWorth(kind, own, here, roads, oppRoads) {
    if (roads > 4) return 0;
    const decay = [1, 0.7, 0.4, 0.2, 0.1][roads] ?? 0;
    const produced = productionOf(kind, own, here);
    const kinds = /* @__PURE__ */ new Set([...RESOURCES.filter((r) => own[r] > 0), ...RESOURCES.filter((r) => here[r] > 0)]);
    let base = 0;
    if (kind === "any") base = kinds.size >= 3 || own.ore + own.grain + here.ore + here.grain >= 8 ? 1.4 : 0.55;
    else base = produced >= 8 ? 2.4 : produced >= 4 ? 1.5 : produced > 0 ? 0.45 : 0.15;
    let value = base * decay;
    if (oppRoads !== void 0 && oppRoads < roads) value *= 0.45;
    return value;
  }
  function portAccess(ctx, dist, own, oppDist) {
    const out = [];
    for (const c of ctx.corners) {
      if (!c.port) continue;
      const roads = dist.get(c.at);
      if (roads === void 0 || roads > 4) continue;
      const oppRoads = oppDist?.get(c.at);
      const value = portWorth(c.port, own, { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 }, roads, oppRoads);
      if (value <= 0) continue;
      const contested = oppRoads !== void 0 && oppRoads < roads;
      const name = c.port === "any" ? "3:1 port" : `2:1 ${LABEL[c.port]} port`;
      const where = roads === 0 ? "already on it" : `${roads} road${roads === 1 ? "" : "s"} away`;
      const extra = c.port !== "any" && own[c.port] >= 4 ? ", and it matches what you produce" : "";
      const race2 = contested ? ", but he is closer" : "";
      out.push({ at: c.at, kind: c.port, roads, value, contested, text: `${name}, ${where}${extra}${race2}` });
    }
    return out.sort((a, b) => b.value - a.value);
  }

  // src/analyzer/strategy.ts
  var LABEL2 = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  var emptyProfile = () => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
  var contexts = /* @__PURE__ */ new WeakMap();
  function contextFor(board) {
    const cached = contexts.get(board);
    if (cached) return cached;
    const corners = boardCorners(board);
    const byAt = new Map(corners.map((c) => [c.at, c]));
    const keyToAt = new Map(corners.map((c) => [pointKey(c.point), c.at]));
    const nbrs = /* @__PURE__ */ new Map();
    for (const a of corners) {
      nbrs.set(
        a.at,
        corners.filter((b) => b !== a && Math.abs(Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) - 1) < 0.05).map((b) => b.at)
      );
    }
    const ring2 = /* @__PURE__ */ new Map();
    for (const [at, near] of nbrs) {
      const out = /* @__PURE__ */ new Set();
      for (const n of near) for (const m of nbrs.get(n) ?? []) if (m !== at && !near.includes(m)) out.add(m);
      ring2.set(at, [...out]);
    }
    const resPips = emptyProfile();
    for (const h2 of board.hexes) if (h2.resource) resPips[h2.resource] += pips(h2.number);
    const total2 = RESOURCES.reduce((s, r) => s + resPips[r], 0);
    const avg = total2 / RESOURCES.length || 1;
    const resWeight = emptyProfile();
    for (const r of RESOURCES) resWeight[r] = resPips[r] === 0 ? 1.4 : Math.min(1.4, Math.max(0.8, avg / resPips[r]));
    const ctx = { board, corners, byAt, keyToAt, nbrs, ring2, hexById: new Map(board.hexes.map((h2) => [h2.id, h2])), resPips, resWeight };
    contexts.set(board, ctx);
    return ctx;
  }
  function occupiedMap(p) {
    return new Map([...p.settlements, ...p.cities]);
  }
  function profileOf(ctx, p, owner) {
    const out = emptyProfile();
    for (const [at, o] of p.settlements) if (owner(o)) addCorner(ctx, out, at, 1);
    for (const [at, o] of p.cities) if (owner(o)) addCorner(ctx, out, at, 2);
    return out;
  }
  function addCorner(ctx, profile, at, weight = 1) {
    const c = ctx.byAt.get(at);
    if (!c) return;
    for (const id of c.hexIds) {
      const h2 = ctx.hexById.get(id);
      if (h2?.resource) profile[h2.resource] += pips(h2.number) * weight;
    }
  }
  var withCorner = (ctx, profile, at) => {
    const next = { ...profile };
    addCorner(ctx, next, at);
    return next;
  };
  function isLegal(ctx, at, taken) {
    const c = ctx.byAt.get(at);
    if (!c || c.resources.length === 0 || taken.has(at)) return false;
    return !(ctx.nbrs.get(at) ?? []).some((n) => taken.has(n));
  }
  function scoreSpot(ctx, c, own, taken) {
    const tags = [];
    const hexes = c.hexIds.map((id) => ctx.hexById.get(id)).filter((h2) => Boolean(h2));
    const kinds = /* @__PURE__ */ new Set();
    const seenNumbers = /* @__PURE__ */ new Set();
    let value = 0;
    let dupNumber = 0;
    let dupResource = 0;
    let desert = 0;
    const pipsHere = emptyProfile();
    for (const h2 of hexes) {
      if (!h2.resource) {
        desert++;
        continue;
      }
      const p = pips(h2.number);
      pipsHere[h2.resource] += p;
      value += p * ctx.resWeight[h2.resource];
      if (h2.resource === "grain") value += p * 0.6;
      else if (h2.resource === "ore") value += p * 0.55;
      if (ctx.resWeight[h2.resource] >= 1.15) value += p * 0.4;
      if (kinds.has(h2.resource)) dupResource++;
      kinds.add(h2.resource);
      if (h2.number !== null) {
        if (seenNumbers.has(h2.number)) dupNumber++;
        seenNumbers.add(h2.number);
      }
    }
    value += 0.9 * kinds.size;
    if (dupNumber) {
      value -= 0.7 * dupNumber;
      tags.push("repeats a number");
    }
    if (dupResource) value -= 0.6 * dupResource;
    if (desert) {
      value -= 3.2 * desert;
      tags.push("touches the desert");
    }
    if (kinds.has("ore") && kinds.has("grain")) {
      value += pipsHere.ore >= 4 && pipsHere.grain >= 4 ? 4.4 : 3.2;
      tags.push("ore + wheat for cities");
    }
    if (kinds.has("brick") && kinds.has("lumber")) {
      value += 1.4;
      tags.push("brick + wood for roads");
    }
    if (!kinds.has("ore") && !kinds.has("grain") && pipsHere.wool >= c.pips * 0.5 && c.pips >= 8 && !c.port) {
      value -= 2.6;
      tags.push("no wheat or ore");
    }
    const hasOwn = RESOURCES.some((r) => own[r] > 0);
    const fresh = hasOwn ? [...kinds].filter((r) => own[r] === 0) : [];
    for (const r of fresh) {
      const need = r === "grain" || r === "ore" ? 2.6 : r === "lumber" || r === "brick" ? 1.5 : 0.5;
      value += need + 0.2 * pipsHere[r];
      tags.push(`adds ${LABEL2[r]}`);
    }
    for (const r of kinds) if (ctx.resWeight[r] >= 1.15) tags.push(`scarce ${LABEL2[r]}`);
    const after = new Set(taken);
    after.add(c.at);
    const room = (ctx.ring2.get(c.at) ?? []).filter((n) => isLegal(ctx, n, after)).length;
    value += Math.min(5, room) * 0.3;
    if (room <= 1) {
      value -= 1;
      tags.push("cramped");
    } else if (room >= 4) tags.push("room to expand");
    if (c.port === "any") {
      value += 3.2;
      tags.push("3:1 port");
    } else if (c.port) {
      const feed = pipsHere[c.port] + own[c.port];
      value += feed >= 4 ? 3.6 + Math.min(1.2, 0.12 * feed) : 1.8;
      tags.push(`2:1 ${LABEL2[c.port]} port`);
    }
    for (const near of portsNear(ctx, c.at, 2)) {
      if (near.dist === 0) continue;
      if (near.dist === 1 && near.kind === "any") value += 2.6;
      else if (near.dist === 1 && near.kind !== "any" && (pipsHere[near.kind] >= 4 || own[near.kind] >= 4)) value += 2.8;
      const worth = near.dist === 1 ? 0 : portWorth(near.kind, own, pipsHere, near.dist);
      if (near.dist > 1 && worth < 0.25) continue;
      value += worth;
      const closePort = near.dist === 1 && (near.kind === "any" || pipsHere[near.kind] >= 4 || own[near.kind] >= 4);
      if (closePort || worth >= 0.45) {
        const name = near.kind === "any" ? "3:1 port" : `2:1 ${LABEL2[near.kind]} port`;
        tags.push(`${name} ${near.dist} road${near.dist > 1 ? "s" : ""} away`);
      }
    }
    return { at: c.at, value, pips: c.pips, tags };
  }
  function legalCorners(ctx, taken) {
    return ctx.corners.filter((c) => isLegal(ctx, c.at, taken));
  }
  function rankFor(ctx, profile, taken) {
    return legalCorners(ctx, taken).map((c) => {
      const s = scoreSpot(ctx, c, profile, taken);
      return { at: c.at, value: s.value, s };
    }).sort((a, b) => b.value - a.value);
  }
  var DENIAL_WEIGHTS = [1, 0.5, 0.25];
  function denial(ctx, theirs, at) {
    const gone = /* @__PURE__ */ new Set([at, ...ctx.nbrs.get(at) ?? []]);
    const top = (list2) => list2.slice(0, 3).map((r) => r.value);
    const before = top(theirs);
    const after = top(theirs.filter((r) => !gone.has(r.at)));
    return DENIAL_WEIGHTS.reduce((s, w, i) => s + w * ((before[i] ?? 0) - (after[i] ?? 0)), 0);
  }
  var NOTES = {
    first: "You place first. Scores look ahead: he takes two spots before your second, so a spot that leaves a strong second one for you ranks higher.",
    pair: "You place two in a row. Each pick is scored together with your best second spot (marked +).",
    second: "Your second settlement. Scores favour what you still lack and the spots he still wants.",
    last: "Your last placement and he cannot react any more, so this is pure value.",
    waiting: "Waiting for him. These are the spots he is most likely to take next."
  };
  function spotLead(c) {
    const ore = c.resources.includes("ore");
    const wheat = c.resources.includes("grain");
    if (ore && wheat) return "Ore and wheat. ";
    if (wheat) return "Wheat, still short of ore. ";
    if (ore) return "Ore, still short of wheat. ";
    return "No wheat or ore. ";
  }
  function describe(ctx, at, tags, label = LABEL2) {
    const c = ctx.byAt.get(at);
    if (!c) return at;
    const parts = c.numbers.map((n, i) => `${n} ${label[c.resources[i]] ?? ""}`.trim());
    return `${c.pips} pips (${parts.join(", ")})${tags.length ? `, ${tags.join(", ")}` : ""}`;
  }
  function planOpening(board, placements, me2, limit = 3, myTurn = void 0) {
    const ctx = contextFor(board);
    const built = occupiedMap(placements);
    const taken = new Set(built.keys());
    const mineN = [...built.values()].filter((o) => o === me2).length;
    const oppN = built.size - mineN;
    const own = profileOf(ctx, placements, (o) => o === me2);
    const his = profileOf(ctx, placements, (o) => o !== me2);
    let mode;
    if (mineN === 0 && oppN === 0) mode = "first";
    else if (mineN === 0) mode = "pair";
    else if (mineN >= 2 || mineN === 1 && oppN === 0) mode = "waiting";
    else if (mineN === 1 && oppN >= 2) mode = "last";
    else mode = "second";
    if (myTurn === false) mode = "waiting";
    else if (myTurn === true && mode === "waiting") mode = "second";
    const theirs = rankFor(ctx, his, taken);
    const oppWants = theirs.slice(0, 3).map((r) => ({ at: r.at, reason: describe(ctx, r.at, r.s.tags.slice(0, 3)) }));
    if (mode === "waiting") return { mode, picks: [], oppWants, note: NOTES[mode] };
    const followWeight = mode === "first" ? 0.6 : mode === "pair" ? 0.9 : 0;
    const denialWeight = mode === "last" ? 0 : 0.5;
    const mine = rankFor(ctx, own, taken);
    const scored = mine.map((cand) => {
      const dn = denialWeight ? denial(ctx, theirs, cand.at) : 0;
      let follow = 0;
      let followAt;
      const hisProjected = [];
      if (followWeight) {
        const t1 = new Set(taken);
        t1.add(cand.at);
        const own1 = withCorner(ctx, own, cand.at);
        let t2 = t1;
        if (mode === "first") {
          t2 = new Set(t1);
          let his2 = his;
          for (let i = 0; i < 2; i++) {
            const pick = rankFor(ctx, his2, t2)[0];
            if (!pick) break;
            t2.add(pick.at);
            hisProjected.push(pick.at);
            his2 = withCorner(ctx, his2, pick.at);
          }
        }
        const hisAfter = mode === "pair" ? rankFor(ctx, his, t1) : [];
        const best = rankFor(ctx, own1, t2).map((r) => ({ r, v: r.value + (mode === "pair" ? 0.4 * denial(ctx, hisAfter, r.at) : 0) })).sort((a, b) => b.v - a.v)[0];
        if (best) {
          follow = best.v;
          followAt = best.r.at;
        }
      }
      const myAts = [...placements.settlements].filter(([, o]) => o === me2).map(([at]) => at);
      if (!myAts.includes(cand.at)) myAts.push(cand.at);
      if (followAt && !myAts.includes(followAt)) myAts.push(followAt);
      const hisAts = [...placements.settlements].filter(([, o]) => o !== me2).map(([at]) => at);
      for (const at of hisProjected) if (!hisAts.includes(at)) hisAts.push(at);
      if (hisAts.length < 2) {
        const blocked = /* @__PURE__ */ new Set([...taken, ...myAts, ...hisAts]);
        while (hisAts.length < 2) {
          const next = rankFor(ctx, his, blocked)[0];
          if (!next) break;
          hisAts.push(next.at);
          blocked.add(next.at);
        }
      }
      const gap = myAts.reduce((s, at) => s + (ctx.byAt.get(at)?.pips ?? 0), 0) - hisAts.reduce((s, at) => s + (ctx.byAt.get(at)?.pips ?? 0), 0);
      return { cand, dn, follow, followAt, gap, total: cand.value + followWeight * follow + denialWeight * dn + 0.12 * gap };
    });
    scored.sort((a, b) => b.total - a.total);
    const picks = [];
    for (const item of scored) {
      if (picks.some((p) => (ctx.nbrs.get(p.at) ?? []).includes(item.cand.at))) continue;
      const c = ctx.byAt.get(item.cand.at);
      const tags = [...item.cand.s.tags];
      const topHis = theirs[0];
      const rankInHis = theirs.slice(0, 3).findIndex((r) => r.at === item.cand.at);
      if (denialWeight && rankInHis >= 0) tags.unshift(rankInHis === 0 ? "takes his best spot" : `takes his #${rankInHis + 1} spot`);
      else if (denialWeight && topHis && (ctx.nbrs.get(item.cand.at) ?? []).includes(topHis.at)) tags.unshift("blocks his best spot");
      else if (denialWeight && item.dn >= 2) tags.unshift("hurts his options");
      picks.push({
        at: item.cand.at,
        score: item.total,
        pips: c.pips,
        resources: c.resources,
        numbers: c.numbers,
        port: c.port,
        tags,
        followUp: item.followAt ? { at: item.followAt, reason: describe(ctx, item.followAt, []) } : void 0,
        reason: `${spotLead(c)}${describe(ctx, item.cand.at, tags.slice(0, 4))}. ${item.gap > 0 ? `+${item.gap} pips on him` : item.gap < 0 ? `He keeps the better opening (${item.gap} pips)` : "Even opening pips"}.`
      });
      if (picks.length >= limit) break;
    }
    return { mode, picks, oppWants, note: NOTES[mode] };
  }
  var edgeKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  function edgeOwners(ctx, p) {
    const owners = /* @__PURE__ */ new Map();
    const ends = /* @__PURE__ */ new Map();
    for (const [at, owner] of p.roads) {
      const pts = edgePoints(at);
      const a = pts && ctx.keyToAt.get(pointKey(pts[0]));
      const b = pts && ctx.keyToAt.get(pointKey(pts[1]));
      if (!a || !b) continue;
      owners.set(edgeKey(a, b), owner);
      ends.set(at, [a, b]);
    }
    return { owners, ends };
  }
  function roadDistance(ctx, p, owner) {
    const built = occupiedMap(p);
    const { owners, ends } = edgeOwners(ctx, p);
    const dist = /* @__PURE__ */ new Map();
    for (const [at, o] of built) if (owner(o)) dist.set(at, 0);
    for (const [at, o] of p.roads) {
      if (!owner(o)) continue;
      for (const end of ends.get(at) ?? []) dist.set(end, 0);
    }
    const done = /* @__PURE__ */ new Set();
    for (; ; ) {
      let u;
      for (const [at, d] of dist) if (!done.has(at) && (u === void 0 || d < dist.get(u))) u = at;
      if (u === void 0) break;
      done.add(u);
      const occupier = built.get(u);
      if (occupier && !owner(occupier)) continue;
      const du = dist.get(u);
      for (const v of ctx.nbrs.get(u) ?? []) {
        const o = owners.get(edgeKey(u, v));
        if (o && !owner(o)) continue;
        const nd = du + (o ? 0 : 1);
        if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd);
      }
    }
    return dist;
  }
  var roadsText = (d) => d === 0 ? "reachable by your road" : `${d} road${d > 1 ? "s" : ""} away`;
  function planMidgame(board, placements, me2) {
    const ctx = contextFor(board);
    const built = occupiedMap(placements);
    const taken = new Set(built.keys());
    const isMe = (o) => o === me2;
    const isHim = (o) => o !== me2;
    const own = profileOf(ctx, placements, isMe);
    const his = profileOf(ctx, placements, isHim);
    const myDist = roadDistance(ctx, placements, isMe);
    const hisDist = roadDistance(ctx, placements, isHim);
    const ports = portAccess(ctx, myDist, own, hisDist);
    const spread = (spots, limit) => {
      const picked = [];
      for (const s of spots.sort((a, b) => b.score - a.score)) {
        if (picked.some((p) => (ctx.nbrs.get(p.at) ?? []).includes(s.at))) continue;
        picked.push(s);
        if (picked.length >= limit) break;
      }
      return picked;
    };
    const expansion = [];
    const oppWants = [];
    for (const c of legalCorners(ctx, taken)) {
      const d = myDist.get(c.at) ?? Infinity;
      const hd = hisDist.get(c.at) ?? Infinity;
      const mineScore = scoreSpot(ctx, c, own, taken);
      const hisScore = scoreSpot(ctx, c, his, taken);
      if (d <= 2) {
        const tags = [roadsText(d), ...mineScore.tags.slice(0, 3)];
        if (hd <= 2) tags.push(`he can reach it too (${hd === 0 ? "now" : `${hd} road${hd > 1 ? "s" : ""}`})`);
        const portBonus = c.port ? ports.find((p) => p.at === c.at)?.value ?? 0 : 0;
        if (portBonus >= 0.4 && c.port) tags.push(c.port === "any" ? "takes the 3:1" : `takes the 2:1 ${LABEL2[c.port]}`);
        expansion.push({ at: c.at, dist: d, score: mineScore.value - 1.4 * d + (hd <= 2 ? 0.3 * hisScore.value : 0) + portBonus, reason: describe(ctx, c.at, tags) });
      }
      if (hd <= 2) {
        const tags = [roadsText(hd).replace("your", "his")];
        tags.push(d <= 3 ? d <= hd ? `you can get there first (${d} road${d === 1 ? "" : "s"})` : `you are ${d} road${d === 1 ? "" : "s"} away` : "out of your reach");
        tags.push(...hisScore.tags.slice(0, 2));
        oppWants.push({ at: c.at, dist: hd, score: hisScore.value - 1.4 * hd, reason: describe(ctx, c.at, tags) });
      }
    }
    let upgrade;
    const settlements = [...placements.settlements].filter(([, o]) => isMe(o)).map(([at]) => ctx.byAt.get(at)).filter((c) => Boolean(c));
    if (settlements.length) {
      const cityWorth = (c) => {
        let ore2 = 0;
        let wheat2 = 0;
        let other = 0;
        c.resources.forEach((r, i) => {
          const n = pips(c.numbers[i] ?? null);
          if (r === "ore") ore2 += n;
          else if (r === "grain") wheat2 += n;
          else other += n;
        });
        return ore2 * 2.4 + wheat2 * 2.2 + other * 0.35 + (ore2 > 0 && wheat2 > 0 ? 6 : 0);
      };
      const best = settlements.slice().sort((a, b) => cityWorth(b) - cityWorth(a))[0];
      const ore = best.resources.includes("ore");
      const wheat = best.resources.includes("grain");
      const why = ore && wheat ? "It has ore and wheat, which a higher pip count without them does not." : wheat ? "It has the wheat. A higher pip count with no wheat is the worse city." : ore ? "It has the ore. A higher pip count with no ore is the worse city." : "None of your settlements has wheat or ore, so this is the least bad city.";
      upgrade = `City on ${best.numbers.join("/")} (${best.pips} pips). ${why}`;
    }
    const weaknesses = [];
    if (ports[0] && ports[0].value >= 0.55) weaknesses.push(`Port: ${ports[0].text}. A spot that reaches it is worth more than the same pips inland.`);
    const missing = (p) => RESOURCES.filter((r) => p[r] === 0);
    const mineMissing = missing(own);
    if (mineMissing.length) weaknesses.push(`You produce no ${mineMissing.map((r) => LABEL2[r]).join(" or ")}; expansion spots that add it rank higher.`);
    const hisMissing = missing(his);
    if (hisMissing.length && built.size > 0) weaknesses.push(`He produces no ${hisMissing.map((r) => LABEL2[r]).join(" or ")}: a spot that gives it denies him, and he will have to trade or use a port.`);
    const scarce = RESOURCES.filter((r) => ctx.resWeight[r] >= 1.25).sort((a, b) => ctx.resPips[a] - ctx.resPips[b])[0];
    if (scarce) weaknesses.push(`${LABEL2[scarce][0].toUpperCase()}${LABEL2[scarce].slice(1)} is scarce on this board (${ctx.resPips[scarce]} pips in total), so whoever controls it has leverage.`);
    for (const [who, owner] of [["Your", isMe], ["His", isHim]]) {
      const lean = incomeLean(ctx, placements, owner);
      if (lean) weaknesses.push(`${who} income leans on the ${lean.number} ${LABEL2[lean.resource]} hex (${Math.round(lean.share * 100)}% of the pips); a robber there hurts ${who === "Your" ? "you" : "him"} most.`);
    }
    return { expansion: spread(expansion, 2), oppWants: spread(oppWants, 2), upgrade, weaknesses };
  }
  function incomeLean(ctx, p, owner) {
    const perHex = /* @__PURE__ */ new Map();
    let total2 = 0;
    const add = (at, w) => {
      for (const id2 of ctx.byAt.get(at)?.hexIds ?? []) {
        const h3 = ctx.hexById.get(id2);
        if (!h3?.resource) continue;
        const v2 = pips(h3.number) * w;
        perHex.set(id2, (perHex.get(id2) ?? 0) + v2);
        total2 += v2;
      }
    };
    for (const [at, o] of p.settlements) if (owner(o)) add(at, 1);
    for (const [at, o] of p.cities) if (owner(o)) add(at, 2);
    if (total2 < 6) return void 0;
    const [id, v] = [...perHex].sort((a, b) => b[1] - a[1])[0] ?? [];
    const h2 = id ? ctx.hexById.get(id) : void 0;
    return h2?.resource && h2.number && v / total2 >= 0.4 ? { number: h2.number, resource: h2.resource, share: v / total2 } : void 0;
  }
  function hexDependence(ctx, p, owner) {
    const perHex = /* @__PURE__ */ new Map();
    const perRes = emptyProfile();
    const add = (at, w) => {
      for (const id of ctx.byAt.get(at)?.hexIds ?? []) {
        const h2 = ctx.hexById.get(id);
        if (!h2?.resource) continue;
        const v = pips(h2.number) * w;
        perHex.set(id, (perHex.get(id) ?? 0) + v);
        perRes[h2.resource] += v;
      }
    };
    for (const [at, o] of p.settlements) if (owner(o)) add(at, 1);
    for (const [at, o] of p.cities) if (owner(o)) add(at, 2);
    return new Map(
      [...perHex].map(([id, v]) => {
        const r = ctx.hexById.get(id)?.resource;
        return [id, { pips: v, share: r && perRes[r] ? v / perRes[r] : 0 }];
      })
    );
  }

  // src/analyzer/engine/dice.ts
  var BAG = [];
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) BAG.push(a + b);
  function createDice(rng, balanced = true) {
    let bag = [];
    const refill = () => {
      bag = BAG.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const swap = bag[i];
        bag[i] = bag[j];
        bag[j] = swap;
      }
    };
    return () => {
      if (!balanced) return 1 + Math.floor(rng() * 6) + 1 + Math.floor(rng() * 6);
      if (!bag.length) refill();
      return bag.pop();
    };
  }

  // src/analyzer/engine/rng.ts
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // src/analyzer/engine/sim.ts
  var empty = () => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
  var CITY = { grain: 2, ore: 3 };
  var SETTLEMENT = { lumber: 1, brick: 1, wool: 1, grain: 1 };
  var ROAD = { lumber: 1, brick: 1 };
  var DEV = { wool: 1, grain: 1, ore: 1 };
  function newPlayer(partial = {}) {
    return {
      buildings: [],
      expansions: [],
      progress: 0,
      hand: empty(),
      ratios: { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 },
      vp: 2,
      knights: 0,
      devs: 0,
      roads: 2,
      hasRoad: false,
      hasArmy: false,
      blocked: null,
      ...partial
    };
  }
  function clonePlayer(p) {
    return {
      ...p,
      hand: { ...p.hand },
      ratios: { ...p.ratios },
      buildings: p.buildings.map((b) => ({ ...b, prods: b.prods.map((x) => ({ ...x })) })),
      expansions: p.expansions.map((e) => ({ ...e, prods: e.prods.map((x) => ({ ...x })) }))
    };
  }
  function applyPort(p, port) {
    if (!port) return;
    if (port === "any") {
      for (const r of RESOURCES) p.ratios[r] = Math.min(p.ratios[r], 3);
    } else p.ratios[port] = Math.min(p.ratios[port], 2);
  }
  var count = (h2) => RESOURCES.reduce((s, r) => s + h2[r], 0);
  function canPay2(h2, cost) {
    return RESOURCES.every((r) => h2[r] >= (cost[r] ?? 0));
  }
  function pay(h2, cost) {
    for (const r of RESOURCES) h2[r] -= cost[r] ?? 0;
  }
  function acquire(p, cost, limit = 5) {
    for (let n = 0; n < limit && !canPay2(p.hand, cost); n++) {
      let want;
      let worst = 0;
      for (const r of RESOURCES) {
        const short = (cost[r] ?? 0) - p.hand[r];
        if (short > worst) {
          worst = short;
          want = r;
        }
      }
      if (!want) break;
      let give;
      let best = 0;
      for (const r of RESOURCES) {
        if (r === want || p.hand[r] < p.ratios[r]) continue;
        if (p.hand[r] - p.ratios[r] < (cost[r] ?? 0)) continue;
        const spare = p.hand[r] / p.ratios[r];
        if (spare > best) {
          best = spare;
          give = r;
        }
      }
      if (!give) return false;
      p.hand[give] -= p.ratios[give];
      p.hand[want]++;
    }
    if (!canPay2(p.hand, cost)) return false;
    pay(p.hand, cost);
    return true;
  }
  function produce(p, roll) {
    if (roll === 7) return;
    for (const b of p.buildings) {
      for (const prod of b.prods) {
        if (prod.number === roll && prod.number !== p.blocked) p.hand[prod.resource] += prod.weight;
      }
    }
  }
  function discard(p, limit) {
    let extra = count(p.hand) - limit;
    if (extra <= 0) return;
    const drop = Math.floor(count(p.hand) / 2);
    let left = drop;
    while (left > 0) {
      let r = "lumber";
      for (const x of RESOURCES) if (p.hand[x] > p.hand[r]) r = x;
      if (p.hand[r] <= 0) break;
      p.hand[r]--;
      left--;
    }
    void extra;
  }
  function steal(from, to, rng) {
    const n = count(from.hand);
    if (!n || from.vp <= 2) return;
    let pick = Math.floor(rng() * n);
    for (const r of RESOURCES) {
      if (pick < from.hand[r]) {
        from.hand[r]--;
        to.hand[r]++;
        return;
      }
      pick -= from.hand[r];
    }
  }
  function bestNumber(p) {
    const by = /* @__PURE__ */ new Map();
    for (const b of p.buildings) for (const prod of b.prods) by.set(prod.number, (by.get(prod.number) ?? 0) + pips(prod.number) * prod.weight);
    let best = 0;
    let num2 = null;
    for (const [n, v] of by) if (v > best) {
      best = v;
      num2 = n;
    }
    return num2;
  }
  function payValue(prods, roads = 0, port) {
    let ore = 0;
    let wheat = 0;
    let other = 0;
    for (const prod of prods) {
      const n = pips(prod.number) * prod.weight;
      if (prod.resource === "ore") ore += n;
      else if (prod.resource === "grain") wheat += n;
      else other += n;
    }
    return ore * 2.1 + wheat * 2 + other * 0.7 + (ore > 0 && wheat > 0 ? 5 : 0) + (port === "any" ? 2 : port ? 2.4 : 0) - roads * 1.3;
  }
  function city(p) {
    const open = p.buildings.filter((b2) => !b2.city);
    if (!open.length || p.buildings.filter((b2) => b2.city).length >= 4) return false;
    open.sort((a, b2) => payValue(b2.prods) - payValue(a.prods));
    const b = open[0];
    b.city = true;
    for (const prod of b.prods) prod.weight *= 2;
    b.pip *= 2;
    p.vp++;
    return true;
  }
  function settle(p) {
    const exp = p.expansions[0];
    if (!exp || p.progress < exp.roads || p.buildings.length >= 5) return false;
    p.expansions.shift();
    p.progress = 0;
    p.buildings.push({ prods: exp.prods.map((x) => ({ ...x })), pip: exp.pip, city: false });
    p.vp++;
    applyPort(p, exp.port);
    return true;
  }
  function road(p, opponent) {
    const exp = p.expansions[0];
    if (!exp || p.progress >= exp.roads) return false;
    p.progress++;
    p.roads++;
    if (p.roads >= 5 && !p.hasRoad && !opponent.hasRoad) {
      p.hasRoad = true;
      p.vp += 2;
    }
    return true;
  }
  function dev(p, rng) {
    p.devs++;
    const roll = rng();
    if (roll < 14 / 25) {
      p.knights++;
      if (p.knights >= 3 && !p.hasArmy) {
        p.hasArmy = true;
        p.vp += 2;
      }
    } else if (roll < 19 / 25) p.vp++;
    else if (roll < 21 / 25) p.progress += 2;
    else {
      const r = RESOURCES[Math.floor(rng() * RESOURCES.length)];
      p.hand[r] += 2;
    }
  }
  var pipTotal = (p, pred) => p.buildings.reduce((s, b) => s + b.prods.reduce((t, prod) => t + (pred(prod.resource) ? pips(prod.number) * prod.weight : 0), 0), 0);
  function act(p, opponent, rng, depth = 0) {
    if (depth >= 4 || p.vp >= 15) return;
    const exp = p.expansions[0];
    const oreWheat = pipTotal(p, (r) => r === "ore" || r === "grain");
    const canCity = p.buildings.some((b) => !b.city);
    if (canCity && (oreWheat >= 7 || !exp) && acquire(p, CITY)) {
      city(p);
      act(p, opponent, rng, depth + 1);
      return;
    }
    if (exp && p.progress >= exp.roads && (exp.pip >= 6 || exp.port) && acquire(p, SETTLEMENT, 4)) {
      settle(p);
      act(p, opponent, rng, depth + 1);
      return;
    }
    if (exp && p.progress < exp.roads && (exp.port || exp.pip >= 7 || exp.roads - p.progress <= 1) && acquire(p, ROAD, 3)) {
      road(p, opponent);
      act(p, opponent, rng, depth + 1);
      return;
    }
    if (p.devs < 7 && p.knights < 4 && acquire(p, DEV, 3)) {
      dev(p, rng);
      act(p, opponent, rng, depth + 1);
      return;
    }
    if (count(p.hand) > 9 && canCity && acquire(p, CITY, 2)) {
      city(p);
      return;
    }
  }
  function race(a0, b0, options = {}) {
    const trials = options.trials ?? 8;
    const maxTurns = options.maxTurns ?? 48;
    const goal = options.goal ?? 15;
    const limit = options.discardLimit ?? 9;
    const seed = options.seed ?? 1;
    const aTurns = [];
    const bTurns = [];
    let aWin = 0;
    for (let i = 0; i < trials; i++) {
      const rng = mulberry32(seed + i * 997);
      const dice = createDice(rng, options.balanced !== false);
      const a = clonePlayer(a0);
      const b = clonePlayer(b0);
      let at = maxTurns;
      let bt = maxTurns;
      const first = i % 2 === 0 ? a : b;
      const second = first === a ? b : a;
      for (let t = 1; t <= maxTurns && (at === maxTurns || bt === maxTurns); t++) {
        const roll = dice();
        const roller = t % 2 === 1 ? first : second;
        const other = roller === a ? b : a;
        if (roll === 7) {
          discard(a, limit);
          discard(b, limit);
          if (other.vp > 2) steal(other, roller, rng);
          other.blocked = bestNumber(other);
          roller.blocked = null;
        } else {
          produce(a, roll);
          produce(b, roll);
        }
        act(roller, other, rng);
        if (a.vp >= goal && at === maxTurns) at = t;
        if (b.vp >= goal && bt === maxTurns) bt = t;
      }
      aTurns.push(at);
      bTurns.push(bt);
      if (at < bt || at === bt && a.vp > b.vp) aWin++;
      else if (at === bt && a.vp === b.vp) aWin += 0.5;
    }
    const median = (xs) => xs.slice().sort((x, y) => x - y)[Math.floor((xs.length - 1) / 2)];
    return { a: { win: aWin / trials, turns: median(aTurns) }, b: { win: 1 - aWin / trials, turns: median(bTurns) } };
  }
  function pipOf(prods) {
    return prods.reduce((s, p) => s + pips(p.number) * p.weight, 0);
  }

  // src/analyzer/engine/opening.ts
  function coachedOpening(board, placements, me2, limit = 3, myTurn = void 0) {
    const wide = planOpening(board, placements, me2, Math.max(limit, 8), myTurn);
    if (wide.mode === "waiting" || wide.picks.length < 2) return { ...wide, picks: wide.picks.slice(0, limit) };
    const ctx = contextFor(board);
    const rated = wide.picks.slice(0, 8).map((pick) => ({ pick, sim: ratePick(ctx, board, placements, me2, pick.at, pick.followUp?.at, wide.oppWants.map((w) => w.at), wide.mode) }));
    rated.sort((a, b) => b.pick.score - a.pick.score || b.sim.win - a.sim.win || a.sim.turns - b.sim.turns);
    const picks = rated.slice(0, limit).map((r) => r.pick);
    return { ...wide, picks };
  }
  var cache = /* @__PURE__ */ new Map();
  function ratePick(ctx, board, placements, me2, at, follow, oppWants, mode) {
    const built = occupiedMap(placements);
    const mine = [...built].filter(([, o]) => o === me2).map(([id]) => id);
    const his = [...built].filter(([, o]) => o !== me2).map(([id]) => id);
    const mySpots = [...mine, at];
    if (mySpots.length < 2 && follow && follow !== at) mySpots.push(follow);
    const blocked = /* @__PURE__ */ new Set([...built.keys(), ...mySpots]);
    const oppSpots = [...his];
    for (const id of oppWants) {
      if (oppSpots.length >= 2) break;
      if (blocked.has(id) || oppSpots.includes(id)) continue;
      if (oppSpots.some((s) => (ctx.nbrs.get(s) ?? []).includes(id)) || mySpots.some((s) => (ctx.nbrs.get(s) ?? []).includes(id) || s === id)) continue;
      oppSpots.push(id);
      blocked.add(id);
    }
    if (oppSpots.length < 2 && mode !== "last") {
      for (const c of ctx.corners) {
        if (oppSpots.length >= 2) break;
        if (!isLegal(ctx, c.at, blocked)) continue;
        oppSpots.push(c.at);
        blocked.add(c.at);
      }
    }
    const key = `${mySpots.join(";")}|${oppSpots.join(";")}|${board.hexes.length}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const mePlayer = fromSpots(ctx, mySpots, blocked, new Set(oppSpots));
    const oppPlayer = fromSpots(ctx, oppSpots, blocked, new Set(mySpots));
    const result = oppSpots.length ? race(mePlayer, oppPlayer, { seed: 11, trials: 6, maxTurns: 42 }) : { a: { win: 1, turns: 40 }, b: { win: 0, turns: 42 } };
    const rate = { win: result.a.win, turns: result.a.turns };
    cache.set(key, rate);
    if (cache.size > 400) cache.clear();
    return rate;
  }
  function prodsOf(ctx, at) {
    const corner = ctx.byAt.get(at);
    if (!corner) return [];
    const out = [];
    for (const id of corner.hexIds) {
      const hex = ctx.hexById.get(id);
      if (hex?.resource && hex.number) out.push({ resource: hex.resource, number: hex.number, weight: 1 });
    }
    return out;
  }
  function fromSpots(ctx, spots, taken, enemy) {
    const p = newPlayer({ vp: Math.max(1, spots.length), roads: Math.max(1, spots.length) });
    p.buildings = spots.map((at) => {
      const prods = prodsOf(ctx, at);
      return { prods, pip: pipOf(prods), city: false };
    });
    const second = spots[spots.length - 1];
    for (const prod of prodsOf(ctx, second)) p.hand[prod.resource]++;
    for (const at of spots) applyPort(p, ctx.byAt.get(at)?.port);
    const dist = roadsFrom(ctx, spots, enemy);
    const expansions = [];
    for (const c of ctx.corners) {
      if (!isLegal(ctx, c.at, taken)) continue;
      const roads = dist.get(c.at);
      if (!roads || roads > 4) continue;
      const prods = prodsOf(ctx, c.at);
      expansions.push({ prods, pip: pipOf(prods) + portBias(c.port, prods), roads, port: c.port });
    }
    expansions.sort((a, b) => payValue(b.prods, b.roads, b.port) - payValue(a.prods, a.roads, a.port));
    p.expansions = expansions.slice(0, 3);
    return p;
  }
  function portBias(port, prods) {
    if (!port) return 0;
    if (port === "any") return 3;
    const made = prods.filter((p) => p.resource === port).reduce((s, p) => s + pips(p.number), 0);
    return made >= 3 ? 3 : 1;
  }
  function roadsFrom(ctx, roots, blocked) {
    const dist = /* @__PURE__ */ new Map();
    const queue = [...roots];
    for (const r of roots) dist.set(r, 0);
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i];
      const d = dist.get(at) ?? 0;
      for (const n of ctx.nbrs.get(at) ?? []) {
        if (dist.has(n) || blocked.has(n)) continue;
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
    return dist;
  }

  // src/analyzer/advisor.ts
  function placementsFrom(events) {
    const out = { settlements: /* @__PURE__ */ new Map(), cities: /* @__PURE__ */ new Map(), roads: /* @__PURE__ */ new Map() };
    for (const e of events) {
      if (e.type !== "build" || !e.at) continue;
      if (e.piece === "settlement") out.settlements.set(e.at, e.player);
      else if (e.piece === "city") {
        out.settlements.delete(e.at);
        out.cities.set(e.at, e.player);
      } else out.roads.set(e.at, e.player);
    }
    return out;
  }
  var RES_LABEL = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  function occupied(p) {
    return new Map([...p.settlements, ...p.cities]);
  }
  function publicVp(placements, player) {
    let vp = 0;
    for (const o of placements.settlements.values()) if (o === player) vp += 1;
    for (const o of placements.cities.values()) if (o === player) vp += 2;
    return vp;
  }
  function robberTargets(board, placements, me2, currentHex, friendlyBelow = 3, limit = 2, needs = []) {
    const corners = boardCorners(board);
    const ctx = contextFor(board);
    const dependence = hexDependence(ctx, placements, (o) => o !== me2);
    const vpOf2 = /* @__PURE__ */ new Map();
    const vp = (p) => {
      if (!vpOf2.has(p)) vpOf2.set(p, publicVp(placements, p));
      return vpOf2.get(p);
    };
    const pip = (n) => n === null ? 0 : 6 - Math.abs(7 - n);
    const out = [];
    for (const hex of board.hexes) {
      if (hex.id === currentHex || !hex.number) continue;
      const here = corners.filter((c) => c.hexIds.includes(hex.id));
      let legal = true;
      let blocksOpponent = 0;
      let blocksSelf = 0;
      const targets = /* @__PURE__ */ new Set();
      for (const c of here) {
        const owner = placements.settlements.get(c.at) ?? placements.cities.get(c.at);
        if (!owner) continue;
        const weight2 = placements.cities.has(c.at) ? 2 : 1;
        if (owner === me2) blocksSelf += weight2;
        else {
          if (vp(owner) < friendlyBelow) legal = false;
          blocksOpponent += weight2;
          targets.add(owner);
        }
      }
      if (!legal || blocksOpponent === 0) continue;
      const r = hex.resource;
      const weight = r ? ctx.resWeight[r] : 1;
      const share = dependence.get(hex.id)?.share ?? 0;
      const needed = r !== null && needs.includes(r);
      const hisPorts = /* @__PURE__ */ new Set();
      for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
        if (owner === me2) continue;
        const port = ctx.byAt.get(at)?.port;
        if (port && port !== "any") hisPorts.add(port);
      }
      const soleWheat = r === "grain" && share >= 0.9;
      const soleOre = r === "ore" && share >= 0.9;
      const portFeed = Boolean(r && hisPorts.has(r) && share >= 0.5);
      let score = pip(hex.number) * weight * (blocksOpponent * (1 + share) + (needed ? 0.6 * blocksOpponent : 0)) - blocksSelf * pip(hex.number) * weight;
      if (soleWheat) score += 14;
      else if (soleOre) score += 9;
      else if (portFeed) score += 6;
      const notes = [];
      if (r && share >= 0.99) notes.push(`his only ${RES_LABEL[r]} source`);
      else if (r && share >= 0.5) notes.push(`most of his ${RES_LABEL[r]}`);
      if (soleWheat) notes.push("block the wheat");
      else if (soleOre) notes.push("block the ore");
      else if (portFeed && r) notes.push(`feeds his 2:1 ${RES_LABEL[r]}`);
      if (needed && r) notes.push(`he needs ${RES_LABEL[r]}`);
      if (r && weight >= 1.15) notes.push(`${RES_LABEL[r]} is scarce`);
      if (blocksSelf) notes.push(`also blocks ${blocksSelf === 1 ? "one of yours" : "two of yours"}`);
      out.push({ hexId: hex.id, number: hex.number, resource: r, blocksOpponent, blocksSelf, targets: [...targets], note: notes.join(", ") || void 0, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function buildHints(view) {
    const lines = [];
    for (const key of ["city", "settlement", "dev", "road"]) {
      const cost = COSTS[key];
      const missing = RESOURCES.flatMap((r) => {
        const need = (cost[r] ?? 0) - view.hand[r];
        return need > 0 ? [`${need} ${RES_LABEL[r]}`] : [];
      });
      const label = { city: "City", settlement: "Settlement", dev: "Dev card", road: "Road" }[key];
      if (!missing.length) lines.push(`${label}: you can pay now`);
      else if (missing.length <= 2) lines.push(`${label}: need ${missing.join(" + ")}`);
    }
    return lines.slice(0, 3);
  }
  var FILL = { lumber: "#3f7d3a", brick: "#c0583a", wool: "#a6d06a", grain: "#e8c545", ore: "#8a96a3", desert: "#dccf9f" };
  var LETTER = { lumber: "W", brick: "B", wool: "S", grain: "G", ore: "O" };
  var MINE = "#2563eb";
  var THEIRS = "#e11d48";
  function miniMapSvg(board, placements, candidates, me2, view = DEFAULT_VIEW, robberHex, marks = []) {
    const size = 16;
    const b = boardBounds(board, size, 2.7, view);
    const f = (n) => n.toFixed(1);
    const T = (p) => viewPoint(p, view);
    const pt = (p) => `${f(T(p).x)},${f(T(p).y)}`;
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(b.minX)} ${f(b.minY)} ${f(b.width)} ${f(b.height)}" style="display:block;width:100%;height:auto;max-height:230px" font-family="system-ui,sans-serif" role="img" aria-label="Board map">`
    ];
    for (const h2 of board.hexes) {
      const c = hexCenter(h2.x, h2.y, size);
      const poly = hexVertices(c, size).map(pt).join(" ");
      parts.push(`<polygon points="${poly}" fill="${FILL[h2.resource ?? "desert"]}" stroke="#1b2128" stroke-width="1"/>`);
      const tc = T(c);
      if (h2.resource) parts.push(`<text x="${f(tc.x)}" y="${f(tc.y - 6.5)}" text-anchor="middle" font-size="6" font-weight="700" fill="#10151a" opacity=".75">${LETTER[h2.resource]}</text>`);
      if (h2.number) {
        const hot = h2.number === 6 || h2.number === 8;
        parts.push(`<circle cx="${f(tc.x)}" cy="${f(tc.y + 2)}" r="6.4" fill="#f6efd8" stroke="#10151a" stroke-width=".5"/><text x="${f(tc.x)}" y="${f(tc.y + 5)}" text-anchor="middle" font-size="${h2.number > 9 ? 8 : 9}" font-weight="700" fill="${hot ? "#c2102f" : "#10151a"}">${h2.number}</text>`);
      }
    }
    const robber = board.hexes.find((h2) => h2.id === robberHex);
    if (robber) {
      const rc = T(hexCenter(robber.x, robber.y, size));
      parts.push(`<ellipse cx="${f(rc.x)}" cy="${f(rc.y + 11)}" rx="3.6" ry="2" fill="#10151a" opacity=".85"/><circle cx="${f(rc.x)}" cy="${f(rc.y + 8)}" r="3.4" fill="#10151a" stroke="#fff" stroke-width=".8"/>`);
    }
    for (const port of board.ports ?? []) {
      const a = portAnchor(board, port, size);
      if (!a) continue;
      const m = T(a.mid);
      const o = T({ x: a.mid.x + a.out.x * size * 0.8, y: a.mid.y + a.out.y * size * 0.8 });
      const text = port.kind === "any" ? "3:1" : `2:1 ${LETTER[port.kind]}`;
      parts.push(`<line x1="${f(m.x)}" y1="${f(m.y)}" x2="${f(o.x)}" y2="${f(o.y)}" stroke="#7aa7d6" stroke-width="1.4"/><text x="${f(o.x)}" y="${f(o.y + 2)}" text-anchor="middle" font-size="6" font-weight="700" fill="#7aa7d6">${text}</text>`);
    }
    for (const [at, owner] of placements.roads) {
      const pts = edgePoints(at, size);
      if (pts) parts.push(`<line x1="${f(T(pts[0]).x)}" y1="${f(T(pts[0]).y)}" x2="${f(T(pts[1]).x)}" y2="${f(T(pts[1]).y)}" stroke="#fff" stroke-width="5" stroke-linecap="round"/><line x1="${f(T(pts[0]).x)}" y1="${f(T(pts[0]).y)}" x2="${f(T(pts[1]).x)}" y2="${f(T(pts[1]).y)}" stroke="${owner === me2 ? MINE : THEIRS}" stroke-width="3" stroke-linecap="round"/>`);
    }
    for (const [at, owner] of occupied(placements)) {
      const p = cornerPoint(at, size);
      if (!p) continue;
      const q = T(p);
      const city2 = placements.cities.has(at);
      const color = owner === me2 ? MINE : THEIRS;
      parts.push(city2 ? `<rect x="${f(q.x - 4.5)}" y="${f(q.y - 4.5)}" width="9" height="9" rx="1.5" fill="${color}" stroke="#fff" stroke-width="1.2"/>` : `<circle cx="${f(q.x)}" cy="${f(q.y)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.2"/>`);
    }
    candidates.forEach((c, i) => {
      const p = cornerPoint(c.at, size);
      if (!p) return;
      const q = T(p);
      parts.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="5.5" fill="#ffd54a" stroke="#10151a" stroke-width="1"/><text x="${f(q.x)}" y="${f(q.y + 2.6)}" text-anchor="middle" font-size="7.5" font-weight="800" fill="#10151a">${i + 1}</text>`);
    });
    for (const m of marks) {
      if (m.kind === "road") {
        const pts = edgePoints(m.at, size);
        if (!pts) continue;
        const a = T(pts[0]);
        const b2 = T(pts[1]);
        const mid = T({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
        const later = m.later === true;
        const dash = later ? ' stroke-dasharray="4 2.5"' : "";
        parts.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b2.x)}" y2="${f(b2.y)}" stroke="#ffd54a" stroke-width="${later ? "3.5" : "6"}" stroke-linecap="round"${dash}/>`);
        if (m.label) parts.push(`<text x="${f(mid.x)}" y="${f(mid.y - 3)}" text-anchor="middle" font-size="7" font-weight="800" fill="#ffd54a">${m.label}</text>`);
        continue;
      }
      const p = cornerPoint(m.at, size);
      if (!p) continue;
      const q = T(p);
      const color = m.kind === "his" ? THEIRS : "#ffd54a";
      parts.push(`<circle cx="${f(q.x)}" cy="${f(q.y)}" r="5.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="2 1.4"/><text x="${f(q.x)}" y="${f(q.y + 2.4)}" text-anchor="middle" font-size="7" font-weight="800" fill="${color}">${m.label}</text>`);
    }
    parts.push("</svg>");
    return parts.join("");
  }

  // src/analyzer/engine/actions.ts
  function coachFromOpening(plan, portLine, roads) {
    const top = plan.picks[0];
    const follow = top?.followUp;
    const here = top ? `${top.numbers.join("/")} (${top.pips} pips)` : "the spot";
    const tips = [];
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
      why = follow ? `Place this one now. It is still your turn. The road below leaves this settlement, not the one you just placed. The other spot was ${follow.reason.replace(/\.$/, "")}.` : "Place this one now. It is still your turn. The road below leaves this settlement.";
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

  // src/analyzer/engine/value.ts
  var FACE = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
  var DECK = 36;
  var WINDOW = 24;
  function asRolls(rolls) {
    return rolls.map((r) => typeof r === "number" ? { total: r } : r);
  }
  function freshPairs() {
    const pairs = /* @__PURE__ */ new Map();
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) pairs.set(`${a},${b}`, 1);
    return pairs;
  }
  function takePair(pairs, roll) {
    if (roll.d1 && roll.d2) {
      const key = `${roll.d1},${roll.d2}`;
      const n = pairs.get(key) ?? 0;
      if (n > 0) {
        pairs.set(key, n - 1);
        return;
      }
    }
    for (const [key, n] of pairs) {
      if (n <= 0) continue;
      const [a, b] = key.split(",").map(Number);
      if (a + b === roll.total) {
        pairs.set(key, n - 1);
        return;
      }
    }
  }
  function deckOf(rolls, aligned) {
    const copies = new Array(13).fill(0);
    const weight = new Array(13).fill(0);
    const pairs = freshPairs();
    let restarted = false;
    if (aligned && rolls.length > 0) {
      const into = rolls.length % WINDOW;
      restarted = into === 0;
      const window2 = restarted ? [] : rolls.slice(-into);
      for (const roll of window2) takePair(pairs, roll);
    }
    const last = aligned && rolls.length ? rolls[rolls.length - 1].total : void 0;
    for (const [key, n] of pairs) {
      if (n <= 0) continue;
      const [a, b] = key.split(",").map(Number);
      copies[a + b] += n;
    }
    let bagLeft = 0;
    for (let n = 2; n <= 12; n++) {
      weight[n] = last === n ? copies[n] * 0.7 : copies[n];
      bagLeft += copies[n];
    }
    return { copies, weight, bagLeft, restarted };
  }
  function bagState(rolls, aligned) {
    const deck = deckOf(asRolls(rolls), aligned);
    return {
      left: deck.copies,
      weight: deck.weight,
      bagLeft: deck.bagLeft,
      aligned,
      sevensLeft: deck.copies[7] ?? 0,
      restarted: deck.restarted
    };
  }
  function mostLikelyRolls(rolls, aligned) {
    const bag = bagState(rolls, aligned);
    let best = -1;
    const nums = [];
    for (let n = 2; n <= 12; n++) {
      const w = bag.weight[n] ?? 0;
      if (w > best) {
        best = w;
        nums.length = 0;
        nums.push(n);
      } else if (w === best && w > 0) nums.push(n);
    }
    return nums;
  }
  function payFaces(numbers, left) {
    const seen = /* @__PURE__ */ new Set();
    let faces = 0;
    for (const n of numbers) {
      if (seen.has(n) || n < 2 || n > 12) continue;
      seen.add(n);
      faces += left[n] ?? 0;
    }
    return faces;
  }
  function fairFaces(numbers) {
    return payFaces(numbers, FACE);
  }
  function repeatedPips(numbers) {
    const seen = /* @__PURE__ */ new Set();
    let extra = 0;
    for (const n of numbers) {
      if (n < 2 || n > 12) continue;
      if (seen.has(n)) extra += FACE[n] ?? 0;
      else seen.add(n);
    }
    return extra;
  }
  function bagSwing(numbers, rolls, aligned) {
    const bag = bagState(rolls, aligned);
    const faces = payFaces(numbers, bag.left);
    const fair = fairFaces(numbers) / 36;
    const rate = bag.bagLeft > 0 ? faces / bag.bagLeft : 0;
    return (rate - fair) * 40 - repeatedPips(numbers) * 0.9;
  }
  function nextRollText(rolls, aligned) {
    const bag = bagState(rolls, aligned);
    if (!aligned) return "The rolls since this tab connected are not the whole bag. On a fair bag the next roll is most likely 7 (6 of 36).";
    const nums = mostLikelyRolls(rolls, aligned);
    const restart = bag.restarted ? "The deck restarted with 12 cards left. " : "";
    if (!nums.length) return `${restart}The deck is empty and restarts. The next roll is most likely 7 (6 of ${DECK}).`;
    const shown = bag.left[nums[0]] ?? 0;
    if (nums.length === 1) return `${restart}Next roll is most likely ${nums[0]} (${shown} left in ${bag.bagLeft}).`;
    return `${restart}Next roll is most likely ${nums.join(" or ")}, ${shown} left each in ${bag.bagLeft}.`;
  }
  function sevensText(rolls, aligned, me2) {
    const bag = bagState(rolls, aligned);
    const base = !aligned ? "A fair bag still holds 6 sevens in 36." : `${bag.sevensLeft} seven${bag.sevensLeft === 1 ? "" : "s"} left in ${bag.bagLeft}.`;
    const seen = asRolls(rolls);
    if (!me2) return base;
    let mine = 0;
    let his = 0;
    for (const roll of seen) {
      if (roll.total !== 7 || !roll.player) continue;
      if (roll.player === me2) mine++;
      else his++;
    }
    const gap = mine - his;
    if (Math.abs(gap) < 2) return base;
    if (gap > 0) return `${base} You have rolled ${gap} more sevens than he has, so the next 7 is less likely to be yours.`;
    return `${base} He has rolled ${-gap} more sevens than you have, so the next 7 is less likely to be his.`;
  }
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    k = Math.min(k, n - k);
    let r = 1;
    for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
  }
  function hyperAtLeast(need, draws, hits, total2) {
    if (need <= 0) return 1;
    if (draws <= 0 || total2 <= 0 || hits <= 0) return 0;
    const n = Math.min(draws, total2);
    const denom = comb(total2, n);
    if (denom <= 0) return 0;
    let ways = 0;
    for (let k = need; k <= Math.min(n, hits); k++) ways += comb(hits, k) * comb(total2 - hits, n - k);
    return Math.max(0, Math.min(1, ways / denom));
  }
  function withRoad(placements, edge, owner) {
    const roads = new Map(placements.roads);
    roads.set(edge, owner);
    return { settlements: placements.settlements, cities: placements.cities, roads };
  }
  function productionFaces(ctx, placements, me2, resource, left) {
    let faces = 0;
    const add = (at, weight) => {
      const corner = ctx.byAt.get(at);
      if (!corner) return;
      for (const id of corner.hexIds) {
        const hex = ctx.hexById.get(id);
        if (hex?.resource !== resource || hex.number === null) continue;
        faces += (left[hex.number] ?? 0) * weight;
      }
    };
    for (const [at, owner] of placements.settlements) if (owner === me2) add(at, 1);
    for (const [at, owner] of placements.cities) if (owner === me2) add(at, 2);
    return faces;
  }
  function rankEdges(board, placements, me2, opts = {}) {
    const maxDist = opts.maxDist ?? 2;
    const edges = listOpenEdges(board, placements, me2, opts.from, opts.onlyFrom);
    if (!edges.length) return [];
    const ctx = contextFor(board);
    const bag = bagState(opts.rolls ?? [], opts.aligned === true);
    const built = occupiedMap(placements);
    const taken = new Set(built.keys());
    if (opts.from) taken.add(opts.from);
    const own = profileOf(ctx, placements, (o) => o === me2);
    const hisDist = roadDistance(ctx, placements, (o) => o !== me2);
    const hand = opts.hand ?? {};
    const needWheat = Math.max(0, 2 - (hand.grain ?? 0));
    const needOre = Math.max(0, 3 - (hand.ore ?? 0));
    const wheatNow = productionFaces(ctx, placements, me2, "grain", bag.left);
    const oreNow = productionFaces(ctx, placements, me2, "ore", bag.left);
    const clockNow = hyperAtLeast(needWheat, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, wheatNow), bag.bagLeft) * hyperAtLeast(needOre, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, oreNow), bag.bagLeft);
    const ranked = edges.map((edge) => {
      const spots = [];
      for (const corner of ctx.corners) {
        if (!isLegal(ctx, corner.at, taken)) continue;
        const step = roadToward(board, placements, me2, corner.at, opts.onlyFrom ? opts.from : void 0);
        if (!step || step.edge !== edge.edge || step.dist < 1 || step.dist > maxDist) continue;
        const scored = scoreSpot(ctx, corner, own, taken);
        const faces = payFaces(corner.numbers, bag.left);
        const fair = fairFaces(corner.numbers) / 36;
        const rate = bag.bagLeft > 0 ? faces / bag.bagLeft : 0;
        const hd = hisDist.get(corner.at);
        const contest = hd !== void 0 && hd <= 2 ? step.dist <= hd ? 2.4 : -3 : 0;
        const ore = corner.resources.filter((r) => r === "ore").length;
        const wheat = corner.resources.filter((r) => r === "grain").length;
        const clock = hyperAtLeast(needWheat, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, wheatNow + wheat * faces), bag.bagLeft) * hyperAtLeast(needOre, Math.min(8, bag.bagLeft), Math.min(bag.bagLeft, oreNow + ore * faces), bag.bagLeft);
        const sheep = corner.pips > 0 && corner.resources.filter((r) => r === "wool").length * 5 >= corner.pips * 0.6 && ore + wheat === 0;
        const score2 = scored.value + (rate - fair) * 40 - repeatedPips(corner.numbers) * 0.9 + contest - step.dist * 1.4 + (clock - clockNow) * 8;
        spots.push({
          at: corner.at,
          dist: step.dist,
          score: score2,
          numbers: corner.numbers,
          pips: corner.pips,
          sheep,
          label: `${corner.numbers.join("/")} (${corner.pips} pips)`,
          pay: `pays on ${faces} of the remaining ${bag.bagLeft}`
        });
      }
      spots.sort((a, b) => b.score - a.score);
      const best = spots[0];
      const second = spots[1];
      const dead = !best;
      const score = dead ? -50 : best.score + (second ? second.score * 0.25 : 0);
      let follow;
      if (best && best.dist >= 2) follow = roadToward(board, withRoad(placements, edge.edge, me2), me2, best.at)?.edge;
      return { edge: edge.edge, toward: best?.at, follow, score, dead, best, second };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked.map((row, i) => {
      const other = ranked.find((_, j) => j !== i);
      let reason;
      if (row.dead) reason = "This road dies. Nothing legal to settle is within two roads.";
      else {
        reason = `This road leaves toward ${row.best.label}, ${row.best.pay}.`;
        if (other?.dead) reason += " The other road dies.";
        else if (other?.best?.sheep && !row.best.sheep) reason += " The other road only adds sheep.";
        else if (other?.best && other.best.at !== row.best.at) reason += ` The other road toward ${other.best.label} is the worse spot.`;
      }
      return { edge: row.edge, toward: row.toward, follow: row.follow, score: row.score, dead: row.dead, reason };
    });
  }
  function bestEdge(board, placements, me2, opts = {}) {
    return rankEdges(board, placements, me2, opts)[0];
  }
  var winCache;
  function prodsOf2(ctx, at, weight) {
    const corner = ctx.byAt.get(at);
    if (!corner) return [];
    const out = [];
    for (const id of corner.hexIds) {
      const hex = ctx.hexById.get(id);
      if (hex?.resource && hex.number) out.push({ resource: hex.resource, number: hex.number, weight });
    }
    return out;
  }
  function simSide(ctx, placements, me2, vp, hand, ratios) {
    const mine = (owner) => owner === me2;
    const spots = [];
    for (const [at, owner] of placements.settlements) if (mine(owner)) spots.push({ at, city: false });
    for (const [at, owner] of placements.cities) if (mine(owner)) spots.push({ at, city: true });
    const p = newPlayer({ vp: Math.max(vp, spots.length || 2) });
    if (hand) for (const r of RESOURCES) p.hand[r] = hand[r] ?? 0;
    if (ratios) {
      for (const r of RESOURCES) if (ratios[r]) p.ratios[r] = ratios[r];
    }
    p.buildings = spots.map((s) => {
      const prods = prodsOf2(ctx, s.at, s.city ? 2 : 1);
      return { prods, pip: pipOf(prods), city: s.city };
    });
    p.vp = Math.max(vp, p.buildings.reduce((s, b) => s + (b.city ? 2 : 1), 0));
    for (const s of spots) applyPort(p, ctx.byAt.get(s.at)?.port);
    const roots = spots.map((s) => s.at);
    const dist = roadDistance(ctx, placements, mine);
    const taken = /* @__PURE__ */ new Set([...placements.settlements.keys(), ...placements.cities.keys()]);
    const expansions = [];
    for (const c of ctx.corners) {
      if (!isLegal(ctx, c.at, taken)) continue;
      const roads = roots.length ? dist.get(c.at) ?? 9 : 4;
      if (roads < 1 || roads > 4) continue;
      const prods = prodsOf2(ctx, c.at, 1);
      const port = c.port;
      expansions.push({ prods, pip: pipOf(prods) + (port === "any" ? 3 : port ? 2 : 0), roads, port, at: c.at });
    }
    expansions.sort((a, b) => payValue(b.prods, b.roads, b.port) - payValue(a.prods, a.roads, a.port));
    p.expansions = expansions.slice(0, 3);
    if (!p.buildings.length) p.vp = vp;
    return p;
  }
  function positionWin(board, placements, me2, opts) {
    const key = JSON.stringify([
      [...placements.settlements],
      [...placements.cities],
      [...placements.roads],
      me2,
      opts.hand,
      opts.myVp,
      opts.hisVp,
      opts.ratios
    ]);
    if (winCache && winCache.key === key && opts.rollCount >= winCache.rolls && opts.rollCount - winCache.rolls < 2) return winCache.pct;
    const ctx = contextFor(board);
    const mine = simSide(ctx, placements, me2, opts.myVp, opts.hand, opts.ratios);
    const oppId = [...placements.settlements.values(), ...placements.cities.values()].find((owner) => owner !== me2) ?? "opp";
    const opp = simSide(ctx, placements, oppId, opts.hisVp);
    const pct = Math.round(race(mine, opp, { seed: 11, trials: 8, maxTurns: 36 }).a.win * 100);
    winCache = { key, rolls: opts.rollCount, pct };
    return pct;
  }

  // src/analyzer/engine/roads.ts
  var pair = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  var edgeCache = /* @__PURE__ */ new WeakMap();
  function edgesOf(ctx) {
    const hit = edgeCache.get(ctx.board);
    if (hit) return hit;
    const land = new Set(ctx.board.hexes.map((h2) => `${h2.x},${h2.y}`));
    const coords2 = [...land];
    for (const key of land) {
      const [x, y] = key.split(",").map(Number);
      for (const [dx, dy] of [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (!land.has(k)) coords2.push(k);
      }
    }
    const out = /* @__PURE__ */ new Map();
    for (const key of coords2) {
      const [x, y] = key.split(",").map(Number);
      for (const z of [0, 1, 2]) {
        const at = `${x},${y},${z}`;
        const pts = edgePoints(at);
        if (!pts) continue;
        const a = ctx.keyToAt.get(pointKey(pts[0]));
        const b = ctx.keyToAt.get(pointKey(pts[1]));
        if (!a || !b || a === b) continue;
        const id = pair(a, b);
        const prev = out.get(id);
        if (!prev || land.has(key) && !land.has(prev.at.split(",").slice(0, 2).join(","))) out.set(id, { at, a, b });
      }
    }
    edgeCache.set(ctx.board, out);
    return out;
  }
  function endsOf(ctx, at) {
    const pts = edgePoints(at);
    if (!pts) return void 0;
    const a = ctx.keyToAt.get(pointKey(pts[0]));
    const b = ctx.keyToAt.get(pointKey(pts[1]));
    return a && b ? [a, b] : void 0;
  }
  function roadToward(board, placements, me2, target, from) {
    return buildNet(board, placements, me2, from)?.firstStep(target);
  }
  function buildNet(board, placements, me2, from, onlyFrom = false) {
    const ctx = contextFor(board);
    const edges = edgesOf(ctx);
    const built = occupiedMap(placements);
    const occupied2 = /* @__PURE__ */ new Set();
    for (const [at] of placements.roads) {
      const ends = endsOf(ctx, at);
      if (ends) occupied2.add(pair(ends[0], ends[1]));
    }
    const mine = /* @__PURE__ */ new Set();
    for (const [at, owner] of built) if (owner === me2) mine.add(at);
    if (from) mine.add(from);
    const graph = /* @__PURE__ */ new Map();
    for (const [at, owner] of placements.roads) {
      if (owner !== me2) continue;
      const ends = endsOf(ctx, at);
      if (!ends) continue;
      mine.add(ends[0]);
      mine.add(ends[1]);
      for (const [a, b] of [[ends[0], ends[1]], [ends[1], ends[0]]]) {
        const next = graph.get(a) ?? /* @__PURE__ */ new Set();
        next.add(b);
        graph.set(a, next);
      }
    }
    if (!mine.size) return void 0;
    const blocked = new Set([...built].filter(([, owner]) => owner !== me2).map(([at]) => at));
    const adj = /* @__PURE__ */ new Map();
    for (const edge of edges.values()) {
      if (occupied2.has(pair(edge.a, edge.b))) continue;
      for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        const list2 = adj.get(a) ?? [];
        list2.push({ to: b, edge: edge.at });
        adj.set(a, list2);
      }
    }
    const firstStep = (target) => {
      if (mine.has(target) || blocked.has(target)) return void 0;
      const roots = onlyFrom && from ? [from] : [...mine];
      const seen = new Set(roots);
      const queue = roots.filter((n) => !blocked.has(n)).map((n) => ({ n, dist: 0, edge: "" }));
      for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        for (const next of adj.get(cur.n) ?? []) {
          if (seen.has(next.to) || blocked.has(next.to)) continue;
          seen.add(next.to);
          const edge = cur.edge || next.edge;
          if (next.to === target) return { edge, dist: cur.dist + 1 };
          queue.push({ n: next.to, dist: cur.dist + 1, edge });
        }
      }
      return void 0;
    };
    return { firstStep, mine, graph, length: longestRoad(graph).len, blocked, adj };
  }
  function listOpenEdges(board, placements, me2, from, onlyFrom = false) {
    const net = buildNet(board, placements, me2, from, onlyFrom);
    if (!net) return [];
    const roots = onlyFrom && from ? [from] : [...net.mine];
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const root of roots) {
      for (const next of net.adj.get(root) ?? []) {
        if (net.blocked.has(next.to) || net.graph.get(root)?.has(next.to) || seen.has(next.edge)) continue;
        seen.add(next.edge);
        out.push({ edge: next.edge, from: root, to: next.to });
      }
    }
    return out;
  }
  function networkLength(board, placements, me2) {
    return buildNet(board, placements, me2)?.length ?? 0;
  }
  function longestExtensions(board, placements, me2) {
    const net = buildNet(board, placements, me2);
    if (!net) return [];
    const chain = longestRoad(net.graph);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const end of chain.ends) {
      if (!net.mine.has(end)) continue;
      for (const next of net.adj.get(end) ?? []) {
        if (net.blocked.has(next.to) || net.graph.get(end)?.has(next.to) || seen.has(next.edge)) continue;
        seen.add(next.edge);
        out.push({ edge: next.edge, to: next.to });
      }
    }
    return out;
  }
  function adviseRoad(board, placements, me2, opts = {}) {
    const ctx = contextFor(board);
    const built = occupiedMap(placements);
    const net = buildNet(board, placements, me2, opts.from, opts.onlyFrom);
    if (!net) return void 0;
    const { firstStep, mine, graph, blocked, adj } = net;
    const forced = opts.toward ? firstStep(opts.toward) : void 0;
    const forcedOk = Boolean(forced && (opts.maxDist === void 0 || forced.dist <= opts.maxDist));
    if (!forcedOk) {
      const pick = bestEdge(board, placements, me2, { from: opts.from, onlyFrom: opts.onlyFrom, maxDist: opts.maxDist ?? 2 });
      if (pick) {
        const setup = Boolean(opts.onlyFrom || opts.from);
        return { edge: pick.edge, toward: pick.toward, reason: setup ? `Point this road toward your second spot. ${pick.reason}` : pick.reason };
      }
    }
    const spotText = (at) => {
      const c = ctx.byAt.get(at);
      if (!c) return "the spot";
      const nums = c.numbers.join("/");
      return `${c.pips} pips${nums ? ` (${nums})` : ""}`;
    };
    const left = (d) => d === 1 ? "This road reaches it." : `It is the first of ${d} roads.`;
    let best;
    const consider = (toward, scoreOf, reason) => {
      const step = firstStep(toward);
      if (!step || opts.maxDist !== void 0 && step.dist > opts.maxDist) return;
      const score = scoreOf(step);
      if (!best || score > best.score) best = { step, score, reason: reason(step), toward };
    };
    if (opts.toward) {
      const target = opts.toward;
      consider(target, () => 40, (step) => `Point this road toward your second spot, ${spotText(target)}. ${left(step.dist)}`);
    }
    const taken = new Set(built.keys());
    if (opts.from) taken.add(opts.from);
    const own = profileOf(ctx, placements, (o) => o === me2);
    for (const corner of ctx.corners) {
      if (!isLegal(ctx, corner.at, taken)) continue;
      const spot = scoreSpot(ctx, corner, own, taken);
      const portNote = corner.port ? corner.port === "any" ? " on a 3:1 port" : ` on the 2:1 ${corner.port} port` : "";
      consider(corner.at, (step) => spot.value - step.dist * 1.2, (step) => `Build the highlighted road toward ${spotText(corner.at)}${portNote}. ${left(step.dist)}`);
    }
    const dist = /* @__PURE__ */ new Map();
    for (const at of mine) dist.set(at, 0);
    const seen = new Set(mine);
    const queue = [...mine].filter((n) => !blocked.has(n));
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i];
      for (const next of adj.get(at) ?? []) {
        if (seen.has(next.to) || blocked.has(next.to)) continue;
        seen.add(next.to);
        dist.set(next.to, (dist.get(at) ?? 0) + 1);
        queue.push(next.to);
      }
    }
    const ports = portAccess(ctx, dist, own);
    if (ports[0] && ports[0].roads > 0) {
      const port = ports[0];
      consider(port.at, (step) => port.value * 5 - step.dist * 0.4, (step) => `Build the highlighted road toward the ${port.text}. ${left(step.dist)}`);
    }
    const chain = longestRoad(graph);
    const mineLen = Math.max(opts.myRoadLength ?? 0, chain.len);
    const oppLen = opts.oppRoadLength ?? 0;
    const takesTrophy = !opts.iHold && mineLen + 1 >= 5 && mineLen + 1 > oppLen;
    if (takesTrophy) {
      for (const end of chain.ends) {
        for (const next of adj.get(end) ?? []) {
          if (blocked.has(next.to) || graph.get(end)?.has(next.to)) continue;
          if (!mine.has(end)) continue;
          const score = 11;
          if (!best || score > best.score) {
            best = {
              step: { edge: next.edge, dist: 1 },
              score,
              toward: next.to,
              reason: `Build the highlighted road. It makes your longest road ${mineLen + 1}${oppLen ? `, ahead of his ${oppLen}` : ""}, which is 2 VP.`
            };
          }
        }
      }
    }
    if (!best) return void 0;
    const touch = endsOf(ctx, best.step.edge);
    if (!touch || !mine.has(touch[0]) && !mine.has(touch[1])) return void 0;
    return { edge: best.step.edge, toward: best.toward, reason: best.reason };
  }
  function longestRoad(graph) {
    const nodes = [...graph.keys()];
    if (!nodes.length) return { len: 0, ends: [] };
    const far = (start) => {
      let best = { node: start, len: 0 };
      const seen = /* @__PURE__ */ new Set([start]);
      const walk = (n, d) => {
        if (d > best.len) best = { node: n, len: d };
        for (const next of graph.get(n) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          walk(next, d + 1);
          seen.delete(next);
        }
      };
      walk(start, 0);
      return best;
    };
    const a = far(nodes[0]);
    const b = far(a.node);
    return { len: b.len, ends: a.node === b.node ? [a.node] : [a.node, b.node] };
  }

  // src/analyzer/engine/read.ts
  var LABEL3 = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  var FACE2 = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
  var SPEND = {
    road: { lumber: 1, brick: 1 },
    settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
    city: { grain: 2, ore: 3 },
    dev: { wool: 1, grain: 1, ore: 1 }
  };
  var emptyRes = () => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
  function bagAligned(completedTurns, rollCount) {
    if (rollCount < 1) return completedTurns === void 0 || completedTurns <= 0;
    if (completedTurns === void 0) return false;
    return Math.abs(completedTurns - rollCount) <= 2;
  }
  function dieRead(rolls, aligned) {
    const weight = {};
    for (let n = 2; n <= 12; n++) weight[n] = 1;
    const into = rolls.length % 24;
    const cycle = !aligned || rolls.length === 0 || into === 0 ? [] : rolls.slice(-into);
    const seen = new Array(13).fill(0);
    for (const n of cycle) if (n >= 2 && n <= 12) seen[n]++;
    const bagLeft = 36 - cycle.length;
    const confidence = aligned ? Math.min(1, cycle.length / 16) : 0;
    const due = [];
    const cold = [];
    for (let n = 2; n <= 12; n++) {
      if (n === 7) continue;
      const fair = FACE2[n] / 36;
      const left = Math.max(0, FACE2[n] - seen[n]);
      const hat = bagLeft > 0 ? left / bagLeft : fair;
      const raw = 1 + confidence * (hat / fair - 1);
      weight[n] = Math.min(1.65, Math.max(0.55, raw));
      if (confidence >= 0.45 && weight[n] >= 1.28) due.push(n);
      if (confidence >= 0.45 && weight[n] <= 0.78) cold.push(n);
    }
    const note = [
      cold.length ? `${cold.join(" and ")} ${cold.length === 1 ? "has" : "have"} already rolled ${cold.length === 1 ? "its" : "their"} share, so ${cold.length === 1 ? "it is" : "they are"} worth less until the bag restarts` : "",
      due.length ? `${due.join(" and ")} ${due.length === 1 ? "is" : "are"} still due` : ""
    ].filter(Boolean).join(". ");
    return { weight, rolls: rolls.length, aligned, bagLeft, note: note ? `${note}.` : "" };
  }
  function readTable(board, events, me2, opts = {}) {
    const rolls = events.filter((e) => e.type === "roll").map((e) => e.total);
    const aligned = bagAligned(opts.completedTurns, rolls.length);
    const dice = dieRead(rolls, aligned);
    const produced = /* @__PURE__ */ new Map();
    const spent = /* @__PURE__ */ new Map();
    const bought = /* @__PURE__ */ new Map();
    const played = /* @__PURE__ */ new Map();
    const did = /* @__PURE__ */ new Map();
    const handSize = new Map(Object.entries(opts.handSize ?? {}));
    const buildings = /* @__PURE__ */ new Map();
    const hexPaid = /* @__PURE__ */ new Map();
    let robber = board.robberStart;
    const ensure = (id) => {
      if (!produced.has(id)) produced.set(id, emptyRes());
      if (!spent.has(id)) spent.set(id, emptyRes());
      return id;
    };
    const pay2 = (id, cost) => {
      const bag = spent.get(ensure(id));
      for (const r of RESOURCES) bag[r] += cost[r] ?? 0;
    };
    const note = (id, text) => {
      const list2 = did.get(id) ?? [];
      const roads = /^built (\d+) roads$/.exec(list2[list2.length - 1] ?? "");
      if (text === "built a road" && roads) list2[list2.length - 1] = `built ${Number(roads[1]) + 1} roads`;
      else if (text === "built a road" && list2[list2.length - 1] === "built a road") list2[list2.length - 1] = "built 2 roads";
      else list2.push(text);
      did.set(id, list2.slice(-4));
    };
    const spotText = (at) => {
      if (!at) return "";
      const hexes = hexesAtCorner(board, at).filter((h2) => h2.number);
      return hexes.map((h2) => h2.number).join("/");
    };
    for (const e of events) {
      if (e.type === "build" && e.at && e.piece !== "road") {
        buildings.set(e.at, { player: e.player, piece: e.piece === "city" ? "city" : "settlement" });
        if (!e.setup && !e.free) pay2(e.player, SPEND[e.piece]);
        if (!e.setup) note(e.player, e.piece === "city" ? `citied ${spotText(e.at) || "a spot"}` : `settled ${spotText(e.at) || "a spot"}`);
      } else if (e.type === "build" && e.piece === "road") {
        if (!e.setup && !e.free) pay2(e.player, SPEND.road);
        if (!e.setup) note(e.player, "built a road");
      } else if (e.type === "devBuy") {
        pay2(e.player, SPEND.dev);
        bought.set(e.player, (bought.get(e.player) ?? 0) + 1);
        note(e.player, "bought a dev card");
      } else if (e.type === "devPlay") {
        const list2 = played.get(e.player) ?? [];
        list2.push(e.card);
        played.set(e.player, list2);
        note(e.player, e.card === "unknown" ? "played a dev card" : `played ${e.card === "victoryPoint" ? "a victory point" : e.card === "yearOfPlenty" ? "Year of Plenty" : e.card === "roadBuilding" ? "Road Building" : e.card === "monopoly" ? "Monopoly" : "a knight"}`);
      } else if (e.type === "hand") {
        handSize.set(e.player, e.size);
      } else if (e.type === "robberMove" && e.hex) {
        robber = e.hex;
        const hex = board.hexes.find((h2) => h2.id === e.hex);
        if (hex?.number && hex.resource) note(e.player, `robbed the ${hex.number} ${LABEL3[hex.resource]}`);
      } else if (e.type === "roll" && e.total !== 7) {
        for (const [at, b] of buildings) {
          for (const hex of hexesAtCorner(board, at)) {
            if (!hex.resource || hex.number !== e.total || hex.id === robber) continue;
            const n = b.piece === "city" ? 2 : 1;
            produced.get(ensure(b.player))[hex.resource] += n;
            const paid = hexPaid.get(hex.id) ?? { resource: hex.resource, number: hex.number, by: {} };
            paid.by[b.player] = (paid.by[b.player] ?? 0) + n;
            hexPaid.set(hex.id, paid);
          }
        }
      }
    }
    const ids = /* @__PURE__ */ new Set([...produced.keys(), ...spent.keys(), ...Object.keys(opts.handSize ?? {}), me2]);
    const player = (id) => {
      const got = produced.get(id) ?? emptyRes();
      const used = spent.get(id) ?? emptyRes();
      const ledger = emptyRes();
      let unseen = 0;
      for (const r of RESOURCES) {
        const net = got[r] - used[r];
        if (net >= 0) ledger[r] = net;
        else unseen += -net;
      }
      const size = handSize.get(id);
      const sum = RESOURCES.reduce((s, r) => s + ledger[r], 0);
      const likely = emptyRes();
      let unknown = 0;
      if (unseen > sum) {
        unknown = size ?? unseen;
      } else if (size === void 0) {
        for (const r of RESOURCES) likely[r] = ledger[r];
        unknown = unseen;
      } else if (sum > size) {
        const scale = size / sum;
        for (const r of RESOURCES) likely[r] = Math.round(ledger[r] * scale);
      } else {
        for (const r of RESOURCES) likely[r] = ledger[r];
        unknown = size - sum;
      }
      const plays = played.get(id) ?? [];
      const hidden = Math.max(0, opts.devsInHand?.[id] ?? Math.max(0, (bought.get(id) ?? 0) - plays.length));
      return {
        id,
        produced: got,
        spent: used,
        likely,
        unknownCards: Math.max(0, unknown),
        handSize: size ?? sum,
        devsBought: bought.get(id) ?? 0,
        devsPlayed: plays,
        devsHidden: hidden,
        knights: Math.max(opts.knights?.[id] ?? 0, plays.filter((c) => c === "knight").length),
        did: did.get(id) ?? []
      };
    };
    const oppId = [...ids].filter((id) => id !== me2).sort((a, b) => (handSize.get(b) ?? 0) - (handSize.get(a) ?? 0))[0];
    const named = events.filter((e) => e.type === "roll" && e.total === 7 && Boolean(e.player));
    const mySevens = named.filter((e) => e.player === me2).length;
    const hisSevens = named.length - mySevens;
    const sevens = named.length >= 2 && Math.abs(mySevens - hisSevens) >= 2 ? hisSevens > mySevens ? `He has rolled ${hisSevens} sevens and you have rolled ${mySevens}.` : `You have rolled ${mySevens} sevens and he has rolled ${hisSevens}.` : void 0;
    return {
      dice,
      me: ids.has(me2) ? player(me2) : void 0,
      opp: oppId ? player(oppId) : void 0,
      hexPaid,
      partial: !aligned && rolls.length > 0,
      sevens
    };
  }
  var COST = {
    settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
    city: { grain: 2, ore: 3 }
  };
  function canBuild(hand, kind) {
    const cost = COST[kind];
    return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0));
  }
  function situationBrief(read, knownHand) {
    const o = read.opp;
    if (!o && !knownHand) return read.dice.note;
    const parts = [];
    if (read.sevens) parts.push(read.sevens);
    if (o && read.partial && !knownHand && (o.did.length || RESOURCES.some((r) => o.produced[r] > 0))) parts.push("Since this tab connected:");
    if (o && o.knights >= 2) parts.push(`He has played ${o.knights} knights${o.devsHidden ? ` and holds ${o.devsHidden} hidden dev card${o.devsHidden === 1 ? "" : "s"}` : ""}. One more knight takes the largest army.`);
    else if (o && o.devsHidden >= 2) parts.push(`He holds ${o.devsHidden} dev cards. About one in five is a hidden point, so he is closer than the buildings show.`);
    if (knownHand) {
      const named = RESOURCES.filter((r) => knownHand.hand[r] > 0).map((r) => `${knownHand.hand[r]} ${LABEL3[r]}`);
      const builds = ["city", "settlement"].filter((k) => knownHand.unknown === 0 && canBuild(knownHand.hand, k));
      const hold = named.length ? named.join(", ") : "nothing we can name";
      const extra = knownHand.unknown > 0 ? ` ${knownHand.unknown} more ${knownHand.unknown === 1 ? "card is" : "cards are"} still unknown.` : "";
      const able = builds.length ? ` He can pay for ${builds.map((k) => k === "city" ? "a city" : "a settlement").join(" and ")} right now.` : knownHand.unknown === 0 ? " He cannot city or settle with that." : "";
      parts.push(`He holds ${hold}.${extra}${able}`);
    } else if (o) {
      const known = RESOURCES.reduce((s, r) => s + o.likely[r], 0);
      const rich = RESOURCES.filter((r) => o.likely[r] >= 2).sort((a, b) => o.likely[b] - o.likely[a]);
      if (o.handSize >= 3 && rich.length && known >= o.unknownCards) {
        const named = rich.slice(0, 2).map((r) => `${Math.round(o.likely[r])} ${LABEL3[r]}`).join(" and ");
        parts.push(`His hand of ${o.handSize} is likely heavy in ${named}, from what his buildings were paid minus what he spent.${o.unknownCards ? ` ${o.unknownCards} card${o.unknownCards === 1 ? "" : "s"} came from trades or steals and ${o.unknownCards === 1 ? "is" : "are"} unknown.` : ""}`);
      }
    }
    const hot = o ? [...read.hexPaid.entries()].map(([id, h2]) => ({ id, ...h2, cards: h2.by[o.id] ?? 0 })).filter((h2) => h2.cards >= 3 && (read.dice.weight[h2.number] ?? 1) >= 0.85).sort((a, b) => b.cards - a.cards)[0] : void 0;
    if (hot) parts.push(`The ${hot.number} ${LABEL3[hot.resource]} has paid him ${hot.cards} cards${(read.dice.weight[hot.number] ?? 1) >= 1.15 ? " and that number is still due" : ""}. That is the robber hex when you can move it.`);
    if (o && o.did.length) parts.push(`His recent plays: ${o.did.slice(-3).join(", ")}.`);
    if (read.dice.note) parts.push(read.dice.note);
    const body = parts.filter((p) => p !== "Since this tab connected:");
    if (!body.length) return "";
    const text = body.slice(0, 3).join(" ");
    if (!parts.includes("Since this tab connected:")) return text;
    return `Since this tab connected, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }
  function holdingResource(read) {
    const o = read.opp;
    if (!o || o.handSize < 3) return void 0;
    const known = RESOURCES.reduce((s, r) => s + o.likely[r], 0);
    if (known < o.unknownCards) return void 0;
    return RESOURCES.filter((r) => o.likely[r] >= 2).sort((a, b) => o.likely[b] - o.likely[a])[0];
  }
  function cityPick(ctx, board, placements, me2, weight) {
    let best;
    for (const [at, owner] of placements.settlements) {
      if (owner !== me2) continue;
      const corner = ctx.byAt.get(at);
      if (!corner) continue;
      let gain = 0;
      let ore = false;
      let wheat = false;
      for (const hex of hexesAtCorner(board, at)) {
        if (!hex.resource || hex.number === null) continue;
        const pip = pips(hex.number) * (weight[hex.number] ?? 1);
        if (hex.resource === "ore") {
          ore = true;
          gain += pip * 2.4;
        } else if (hex.resource === "grain") {
          wheat = true;
          gain += pip * 2.2;
        } else gain += pip * 0.35;
      }
      if (ore && wheat) gain += 6;
      const name = `${corner.numbers.join("/")} (${corner.pips} pips${ore && wheat ? ", ore and wheat" : ""})`;
      if (!best || gain > best.gain) best = { at, name, gain };
    }
    return best;
  }
  function rankLiveSpots(board, placements, me2, events = [], opts = {}) {
    const read = readTable(board, events, me2, opts);
    const ctx = contextFor(board);
    const built = occupiedMap(placements);
    const taken = new Set(built.keys());
    const own = profileOf(ctx, placements, (o) => o === me2);
    const his = profileOf(ctx, placements, (o) => o !== me2);
    const mine = roadDistance(ctx, placements, (o) => o === me2);
    const hisReach = roadDistance(ctx, placements, (o) => o !== me2);
    const hisBest = new Set(
      ctx.corners.filter((c) => isLegal(ctx, c.at, taken)).map((c) => ({ at: c.at, value: scoreSpot(ctx, c, his, taken).value, dist: hisReach.get(c.at) ?? 99 })).filter((s) => s.dist <= 2).sort((a, b) => b.value - a.value).slice(0, 2).map((s) => s.at)
    );
    const seenRolls = events.filter((e) => e.type === "roll").map((e) => e.total);
    const spots = [];
    for (const c of ctx.corners) {
      if (!isLegal(ctx, c.at, taken)) continue;
      const step = roadToward(board, placements, me2, c.at);
      const dist = step ? step.dist : mine.get(c.at) === 0 ? 0 : 99;
      if (dist >= 99) continue;
      const scored = scoreSpot(ctx, c, own, taken);
      const pipsBy = emptyRes();
      for (const id of c.hexIds) {
        const hex = ctx.hexById.get(id);
        if (hex?.resource && hex.number !== null) pipsBy[hex.resource] += pips(hex.number);
      }
      const tags = [...scored.tags];
      let value = scored.value;
      let diceNote = "";
      for (const id of c.hexIds) {
        const hex = ctx.hexById.get(id);
        if (!hex?.resource || hex.number === null) continue;
        const mult = read.dice.weight[hex.number] ?? 1;
        value += pips(hex.number) * (mult - 1) * ctx.resWeight[hex.resource];
        if (read.dice.aligned && mult >= 1.28) diceNote = `${hex.number} is due`;
        else if (read.dice.aligned && mult <= 0.78 && !diceNote) diceNote = `${hex.number} is cold`;
      }
      if (diceNote) tags.push(diceNote);
      const distinct = new Set(c.numbers);
      if (distinct.size === 1 && c.pips >= 8) value -= (read.dice.weight[c.numbers[0]] ?? 1) > 1.1 ? 0.25 : 0.7;
      else if (distinct.size >= 2 && c.pips >= 7) value += 0.35;
      const hd = hisReach.get(c.at);
      const hisScore = scoreSpot(ctx, c, his, taken).value;
      if (hd !== void 0 && hd <= 2 && hisScore >= 9) {
        if (dist <= hd) {
          value += Math.min(3.2, 0.22 * hisScore);
          tags.push("takes a spot he wants");
        } else value -= hd + 1 < dist ? 5 : 1.6;
      }
      if (hisBest.has(c.at) && dist <= (hd ?? 99)) tags.push("his next spot");
      for (const r of c.resources) {
        if (his[r] === 0 && own[r] < 6 && c.resources.includes(r)) {
          const onSpot = c.hexIds.some((id) => ctx.hexById.get(id)?.resource === r && pips(ctx.hexById.get(id)?.number ?? null) >= 3);
          if (onSpot) {
            value += 1.15;
            tags.push(`denies him ${LABEL3[r]}`);
            break;
          }
        }
      }
      for (const id of c.hexIds) {
        const paid = read.hexPaid.get(id);
        const cards = paid && read.opp ? paid.by[read.opp.id] ?? 0 : 0;
        if (paid && cards >= 3) {
          value += Math.min(1.6, 0.25 * cards);
          tags.push(`sits on the ${paid.number} ${LABEL3[paid.resource]} that paid him ${cards}`);
          break;
        }
      }
      value += bagSwing(c.numbers, read.dice.aligned ? seenRolls : [], read.dice.aligned);
      const useful = tags.filter((t) => /denies|his next|paid him|due|cold|port|ore \+ wheat|adds |no wheat/.test(t)).slice(0, 2);
      const away = dist === 0 ? "your road already reaches it" : dist === 1 ? "one road away" : `${dist} roads away`;
      const lead = c.resources.includes("ore") && c.resources.includes("grain") ? "Ore and wheat" : c.resources.includes("grain") ? "Wheat, short of ore" : c.resources.includes("ore") ? "Ore, short of wheat" : "No wheat or ore";
      spots.push({
        at: c.at,
        dist,
        step,
        pips: c.pips,
        numbers: c.numbers,
        port: c.port,
        pipsBy,
        value,
        tags,
        reason: [lead, `${c.pips} pips on ${c.numbers.join("/")}`, ...useful, away].join(", ") + "."
      });
    }
    spots.sort((a, b) => b.value - a.value);
    for (const spot of spots.slice(0, 8)) {
      if (spot.dist > 2) continue;
      const leave = bestEdge(board, placements, me2, { from: spot.at, onlyFrom: true, maxDist: 2, rolls: seenRolls, aligned: read.dice.aligned });
      if (!leave || leave.dead) spot.value -= 4;
      else spot.value += Math.min(2, Math.max(0, leave.score) * 0.04);
    }
    spots.sort((a, b) => b.value - a.value);
    return { spots, read };
  }
  function chooseSettlement(spots, roadRich) {
    const tempo = roadRich ? 1.05 : 2.05;
    const maxDist = roadRich ? 5 : 3;
    const open = spots.filter((s) => s.dist >= 1 && s.dist <= maxDist).sort((a, b) => b.value - tempo * b.dist - (a.value - tempo * a.dist));
    const toward = open[0];
    const alt = open[1];
    const here = spots.filter((s) => s.dist === 0).sort((a, b) => b.value - a.value)[0];
    const good = (s) => s.pips >= 7 || s.value >= 14 || s.port !== void 0 && s.port !== "any" && s.pips >= 4;
    if (here && good(here)) {
      const hereScore = here.value + 1;
      const towardScore = toward ? toward.value - tempo * toward.dist : -Infinity;
      if (hereScore >= towardScore) return { now: here, toward, alt, skipped: void 0 };
    }
    return { toward, alt, skipped: here && toward && here.at !== toward.at ? here : void 0 };
  }
  function worthTheRoad(spot, own) {
    const precious = own.lumber < 3 && own.brick < 3;
    const freshLumber = own.lumber < 3 ? spot.pipsBy.lumber : 0;
    const freshBrick = own.brick < 3 ? spot.pipsBy.brick : 0;
    const portMatch = spot.port !== void 0 && spot.port !== "any" && own[spot.port] >= 4;
    if (!precious) return spot.pips >= 7 || portMatch || spot.value >= 12;
    if (spot.dist > 2) return false;
    if (portMatch) return true;
    return freshLumber >= 4 || freshBrick >= 4 || freshLumber + freshBrick >= 6;
  }

  // src/analyzer/engine/decide.ts
  var LABEL4 = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  function planTurn(input) {
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
    const known = input.handKnown !== false && input.hand !== void 0;
    const cards = meSnap?.devCards ?? [];
    const rolled = input.snapshot?.dice?.thrown === true;
    const roadsLeft = meSnap?.roadsLeft !== 0;
    const settlesLeft = meSnap?.settlementsLeft !== 0;
    const citiesLeft = meSnap?.citiesLeft !== 0;
    const ownSettlement = [...input.placements.settlements.values()].some((o) => o === input.me);
    const handSizes = {};
    const devsInHand = {};
    const knightCount = {};
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
      const nearer = ranked.spots.filter((s) => s.dist >= 1 && s.dist <= 2 && s.value >= spot.value - 4).sort((a, b) => b.value - a.value)[0];
      if (nearer) spot = nearer;
    }
    const touching = choice.now;
    const myLen = Math.max(meSnap?.roadLength ?? 0, networkLength(input.board, input.placements, input.me));
    const oppLen = Math.max(oppSnap?.roadLength ?? 0, oppId ? networkLength(input.board, input.placements, oppId) : 0);
    const battle = roadBattle(myLen, oppLen, meSnap?.hasLongestRoad === true, oppSnap?.hasLongestRoad === true);
    const needVp = goal - myVp;
    const canCity = known && citiesLeft && ownSettlement && canPay3(hand, COSTS.city);
    const cityClose = known && citiesLeft && ownSettlement && !canCity && tradesToPay(hand, ratios, COSTS.city) === 1;
    const yopCards = cards.includes("yearOfPlenty") ? finishWith(hand, COSTS.city, 2) : void 0;
    const yopCity = Boolean(yopCards && citiesLeft && ownSettlement && yopCards.length > 0);
    const canPlaceNow = Boolean(known && settlesLeft && touching && canPay3(hand, COSTS.settlement));
    const settleClose = Boolean(known && settlesLeft && touching && !canPlaceNow && tradesToPay(hand, ratios, COSTS.settlement) === 1);
    const goodSpot = Boolean(spot && spot.dist >= 1 && spot.dist <= (roadRich ? 5 : 3) && spot.value > 8);
    const oneAway = Boolean(spot && spot.dist === 1 && spot.value > 8);
    const canPayRoad = known && canPay3(hand, COSTS.road);
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
    const city2 = cityPick(ctx, input.board, input.placements, input.me, ranked.read.dice.weight);
    const cityWorth = (city2?.gain ?? 0) >= 4;
    const producingCity = own.ore > 0 && own.grain > 0;
    const cityThisTurn = (cityWorth || producingCity) && (canCity || cityClose || yopCity);
    const robberOnMe = robberHits(ctx, input.placements, input.me, input.snapshot?.robberHex);
    const burst = Boolean(known && settlesLeft && citiesLeft && ownSettlement && touching && cityWorth && canPay3(hand, { lumber: 1, brick: 1, wool: 1, grain: 3, ore: 3 }));
    const myCities = [...input.placements.cities.values()].filter((o) => o === input.me).length;
    const myBuildings = myCities + [...input.placements.settlements.values()].filter((o) => o === input.me).length;
    const haveCity = myCities >= 1;
    const thirdClose = Boolean(haveCity && spot && spot.dist >= 1 && spot.dist <= 2);
    const nearPort = portAccess(ctx, roadDistance(ctx, input.placements, (o) => o === input.me), own).find((p) => p.roads >= 1 && p.roads <= 2);
    const portStep = nearPort ? roadToward(input.board, input.placements, input.me, nearPort.at) : void 0;
    const portName = nearPort ? nearPort.kind === "any" ? "3:1 port" : `2:1 ${LABEL4[nearPort.kind]} port` : "port";
    const onFour = RESOURCES.every((r) => ratios[r] >= 4);
    const endgame = needVp <= 4;
    const portWithinTwo = Boolean(nearPort && portStep);
    let action = "hold";
    const roadBuildReach = cards.includes("roadBuilding") && roadsLeft && (canTrophyNow || canTrophy2 || goodSpot && spot.dist <= 2 || portWithinTwo);
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
    else if (haveCity && oppSnap?.hasLongestRoad && known && canPay3(hand, COSTS.dev) && !thirdClose && !canPlaceNow) action = "buyDev";
    else if (goodSpot && canRoad) action = "road";
    else if (cards.includes("knight") && robberOnMe) action = "knight";
    else if (known && canPay3(hand, COSTS.dev) && !oneAway && !(goodSpot && canRoad)) action = "buyDev";
    const scarce = own.lumber < 3 && own.brick < 3;
    const oppCanCity = Boolean(input.oppHand && (input.oppUnknown ?? 0) === 0 && canBuild(input.oppHand, "city"));
    let heldBrick = false;
    let refused;
    if (action === "road" && scarce && spot && !worthTheRoad(spot, own)) {
      refused = spot;
      const better = ranked.spots.filter((s) => s.dist >= 1 && s.dist <= 2 && worthTheRoad(s, own)).sort((a, b) => b.value - 2.05 * b.dist - (a.value - 2.05 * a.dist))[0];
      if (better) spot = better;
      else {
        heldBrick = true;
        action = cards.includes("knight") && robberOnMe ? "knight" : known && canPay3(hand, COSTS.dev) ? "buyDev" : "hold";
      }
    }
    if (!scarce && myCities === 0 && action === "road" && spot && spot.pipsBy.ore < 3 && spot.pipsBy.grain < 3 && own.ore < 4) {
      const cityRoad = ranked.spots.filter((s) => s.dist >= 1 && s.dist <= 2 && (s.pipsBy.ore >= 3 || s.pipsBy.grain >= 3) && s.pips >= 6).sort((a, b) => b.pipsBy.ore + b.pipsBy.grain - (a.pipsBy.ore + a.pipsBy.grain))[0];
      if (cityRoad) spot = cityRoad;
    }
    const settleReady = known && (canPay3(hand, COSTS.settlement) || tradesToPay(hand, ratios, COSTS.settlement) === 1);
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
    if (endgame && known && canPay3(hand, COSTS.dev) && !canTrophyNow && !canPlaceNow && (action === "road" || action === "hold" || action === "trophy2")) action = "buyDev";
    const third = myCities >= 1 && myBuildings >= 2 && myBuildings < 3;
    const knightNote = robberOnMe ? "" : keyBlock(ctx, input.placements, input.me, input.snapshot?.robberHex);
    const seen = (input.events ?? []).filter((e) => e.type === "roll");
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
      const cityOk = Boolean((canCity || cityClose) && ownSettlement && citiesLeft && city2 && (cityWorth || producingCity));
      const settleOk = Boolean(canPlaceNow && touching);
      const roadSettles = Boolean(spot && spot.dist === 1 && (settleReady || canPlaceNow));
      let roadOk = Boolean(canRoad && edgePick && !heldBrick);
      if (cityOk && producingCity && !trophy1 && !roadSettles) roadOk = false;
      if (awardPressure && !cityOk && !trophy1) roadOk = false;
      const devOk = canPay3(hand, COSTS.dev);
      const ids = ["hold"];
      if (cityOk) ids.push("city");
      if (settleOk) ids.push("settle");
      if (roadOk) ids.push("road");
      if (devOk) ids.push("dev");
      const rank = { city: 0, dev: 1, settle: 2, road: 3, hold: 4 };
      let bestId = ids[0];
      let bestPct = -1;
      let bestCards = total(hand);
      for (const id of ids) {
        const placed = {
          settlements: new Map(input.placements.settlements),
          cities: new Map(input.placements.cities),
          roads: new Map(input.placements.roads)
        };
        const next = { ...hand };
        let vp = myVp;
        const pay2 = (cost) => {
          for (const r of RESOURCES) next[r] = Math.max(0, next[r] - (cost[r] ?? 0));
        };
        if (id === "city" && city2) {
          placed.settlements.delete(city2.at);
          placed.cities.set(city2.at, input.me);
          pay2(COSTS.city);
          vp += 1;
        } else if (id === "settle" && touching) {
          placed.settlements.set(touching.at, input.me);
          pay2(COSTS.settlement);
          vp += 1;
        } else if (id === "road" && edgePick) {
          placed.roads.set(edgePick.edge, input.me);
          pay2(COSTS.road);
        } else if (id === "dev") pay2(COSTS.dev);
        const pct2 = positionWin(input.board, placed, input.me, { hand: next, myVp: vp, hisVp, ratios, rollCount: seenRolls.length + 20 + rank[id] });
        const cards2 = total(next);
        if (pct2 > bestPct || pct2 === bestPct && (rank[id] < rank[bestId] || rank[id] === rank[bestId] && cards2 < bestCards)) {
          bestId = id;
          bestPct = pct2;
          bestCards = cards2;
        }
      }
      const building = action === "settle" || action === "settleTrade" || action === "city" || action === "cityTrade";
      const sitting = action === "hold";
      const adopt = bestId === "city" || bestId === "settle" && !building || bestId === "dev" && !building || sitting || bestId === "road" && (sitting || action === "buyDev");
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
    const trophyRoad = action === "trophy" || action === "trophy2" || action === "roadBuild" && (trophy1 || trophy2);
    const aimedStep = edgePick && (action === "road" || action === "roadBuild" && !trophy1 && !trophy2) ? { edge: edgePick.edge, toward: edgePick.toward ?? spot?.at } : void 0;
    const firstStep = action === "port" && portStep && nearPort ? { edge: portStep.edge, toward: nearPort.at } : trophyRoad && extension ? { edge: extension.edge, toward: extension.to } : aimedStep ? aimedStep : edgePick ? { edge: edgePick.edge, toward: edgePick.toward ?? spot?.at } : spot?.step ? { edge: spot.step.edge, toward: spot.at } : void 0;
    const secondPick = action === "roadBuild" && firstStep && !trophy1 && !trophy2 ? bestEdge(input.board, withRoad2(input.placements, firstStep.edge, input.me), input.me, { rolls: seenRolls, aligned: alignedBag, hand, maxDist: 2 }) : void 0;
    const secondStep = action === "roadBuild" && firstStep ? trophy1 || trophy2 ? secondFreeRoad(input.board, input.placements, input.me, firstStep.edge, spot, ranked.spots, nearPort, true, false) : secondPick ? { edge: secondPick.edge, toward: secondPick.toward, reason: secondPick.toward ? `Second road toward ${ranked.spots.find((s) => s.at === secondPick.toward)?.numbers.join("/") ?? "the next spot"}. ${secondPick.reason}` : `Second road. ${secondPick.reason}` } : void 0 : void 0;
    const cityName = city2?.name;
    const spotName = spot ? `${spot.numbers.join("/")} (${spot.pips} pips)` : "the settlement";
    const portNote = spot?.port ? spot.port === "any" ? " It takes a 3:1 port." : ` It takes the 2:1 ${LABEL4[spot.port]} port.` : "";
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
      headline = `Play Year of Plenty for ${yopCards.map((r) => LABEL4[r]).join(" and ")}, then city.`;
      why = cityName ? `Those two cards finish the city on ${cityName}. A free city beats spending the turn on a road.` : "Those two cards finish a city. Play the card, then city.";
    } else if (action === "army") {
      headline = "Play the knight and take the largest army.";
      why = `That knight is your number ${nextKnights}, which is the largest army: 2 VP. Play it before you spend the turn on a road${winningTwo ? ". It wins the game" : ""}.`;
    } else if (action === "roadBuild") {
      const firstLabel2 = trophy1 || trophy2 ? "the longest road" : spotName;
      const secondLabel = secondStep?.reason ?? "Second road continues from that edge.";
      headline = `Play Road Building. First road toward ${firstLabel2}. ${secondLabel}`;
      why = trophy1 || trophy2 ? `${battle.text} Lay the first road, then the second, in that order.` : `Lay the first road, then the second, in that order.${portNote} Do not spend brick and wood on a road while this card does it.`;
    } else if (action === "trophy" || action === "trophy2") {
      headline = action === "trophy" ? "Build one road and take the longest road." : "Start the longest-road fight. Two roads take it.";
      why = battle.text;
    } else if (action === "port" && nearPort) {
      headline = portHold ? `Do not 4:1. Road to the ${portName}.` : `Road to the ${portName}.`;
      why = portHold ? `${nearPort.text} A 4:1 is only worth it when it finishes the city.` : `${nearPort.text} You are still trading 4:1, so this is the road to build. The third settlement comes after the port.`;
    } else if (heldBrick && action === "hold" && refused) {
      headline = "Hold the wood and brick.";
      why = brickWhy(refused, settleMissing, oppCanCity);
    } else if (action === "road" && spot) {
      const left = spot.dist === 1 && settleReady ? "The settlement is legal after this road." : spot.dist === 1 ? known ? `You still need ${settleMissing.join(" and ")} before you can settle there.` : "Do not treat the settlement as this turn until the hand shows you can pay for it." : `${spot.dist} roads in total.${known && !settleReady && settleMissing.length ? ` You still need ${settleMissing.join(" and ")} before you can settle.` : ""}`;
      const thirdName = third && spot.dist <= 2;
      headline = roadTrade ? `Trade, then road toward ${spotName}.` : thirdName && spot.dist === 1 && settleReady ? `Road, then the third settlement ${spotName}.` : thirdName ? `Road toward the third settlement, ${spotName}.` : spot.dist === 1 && settleReady ? `Road, then settle ${spotName}.` : spot.dist === 1 ? `Road toward ${spotName}.` : `Build toward ${spotName}, ${spot.dist} roads away.`;
      why = `That is the strongest settlement your roads can reach.${portNote} ${left}${choice.skipped ? ` The corner you already reach is ${choice.skipped.pips} pips on ${choice.skipped.numbers.join("/")}. It is the worse spot. Leave it.` : ""}`;
    } else if (action === "knight") {
      headline = rolled ? "Play the knight before you end the turn." : "Play the knight before you roll.";
      why = rolled ? "The roll already happened, so this steals a card and moves the robber off you for the next round. You may play one dev card, and never the turn you bought it." : "The robber is on you. Move it before the roll, or this production is lost. You may play one dev card, and never the turn you bought it.";
    } else if (action === "buyDev") {
      headline = "Buy a development card.";
      why = endgame ? "This is the end of the game. A dev card is a knight toward the largest army, or a hidden point about one time in five. You cannot play it on the turn you buy it." : "No city and no settlement is close. A dev card is a knight toward the largest army, or a hidden point about one time in five. You cannot play it on the turn you buy it.";
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
    const safeRoll = rolled && dice?.d1 !== void 0 && dice.d2 !== void 0 && dice.d1 + dice.d2 !== 7;
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
    } else if (!rolled && sevenMode && known && total(hand) >= 8 && total(hand) <= discardLimit && !/city/i.test(headline) && action !== "settle" && action !== "settleTrade" && action !== "army" && action !== "knight" && action !== "yop" && action !== "roadBuild") {
      const spendAction = action === "hold" ? canPay3(hand, COSTS.road) ? "road" : canPay3(hand, COSTS.dev) ? "buyDev" : action : action;
      const spent = spendDown(hand, ratios, own, spendAction, discardLimit, spotName);
      if (spent) {
        headline = spent;
        why = `${spent} ${sevensText(seenFaces, alignedBag, input.me)} ${why}`;
      }
    } else if (known && total(hand) >= discardLimit - 2 && total(hand) <= discardLimit) {
      why += ` ${sevensText(seenFaces, alignedBag, input.me)} Do not take cards that cross ${discardLimit} unless this turn spends them. A production roll on his turn can still push a legal hand over ${discardLimit}.`;
    }
    const mono = cards.includes("monopoly") ? monopolyCall(input.oppHand, input.oppUnknown, his, input.oppNeeds ?? [], input.oppHand ? richest(input.oppHand) : holdingResource(ranked.read)) : void 0;
    const oppSize = input.oppHand && (input.oppUnknown ?? 0) === 0 && total(input.oppHand) > 0 ? total(input.oppHand) : oppSnap?.handSize ?? 0;
    const playMono = Boolean(mono && (oppSize >= 6 || oppCanCity));
    const spendsDev = action === "yop" || action === "roadBuild" || action === "army" || action === "knight";
    if (mono && playMono && !spendsDev) {
      const call = `Play Monopoly on ${LABEL4[mono.resource]}.`;
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
    const rbLine = action === "roadBuild" ? `Play Road Building. First road toward ${firstLabel}. ${secondStep?.reason ?? "Second road continues from that edge."}` : void 0;
    const buildNow = !heldBrick && (action === "trophy" || action === "trophy2" || action === "roadBuild" || action === "port" || action === "road" && (spot?.dist ?? 9) <= 2);
    const step = firstStep;
    const toward = firstStep?.toward;
    const edgeNote = edgePick && step && step.edge === edgePick.edge ? ` ${edgePick.reason}` : "";
    const afterRoad = spot && spot.dist === 1 && settleReady ? " The settlement is legal after this road." : spot && spot.dist === 1 && known && settleMissing.length ? ` You still need ${settleMissing.join(" and ")} before that settlement.` : spot && spot.dist > 1 ? ` ${spot.dist} roads in total.` : "";
    let road2 = step ? {
      edge: step.edge,
      toward,
      buildNow,
      reason: buildNow ? trophyRoad ? `${battle.text} The highlighted road is the one that lengthens it.` : action === "port" ? `This is the road to the ${portName}. ${nearPort?.text ?? ""}` : action === "roadBuild" ? `First road toward ${firstLabel}.` : `This is the road toward ${spotName}.${afterRoad}${edgeNote}${roadTrade ? " Make the trade below first." : ""}` : action === "road" && spot && spot.dist > 2 ? `${spotName} is ${spot.dist} roads away.${edgeNote} The settlement is not this turn.` : `Not this turn. ${headline} When you do spend a road, this is the one, toward ${spot ? spotName : "the next settlement"}.${edgeNote}`
    } : void 0;
    if (action === "port" && portStep && nearPort) {
      road2 = { edge: portStep.edge, toward: nearPort.at, buildNow: true, reason: `This is the road to the ${portName}. ${nearPort.text}` };
    }
    const road22 = action === "roadBuild" && secondStep ? { edge: secondStep.edge, toward: secondStep.toward, reason: secondStep.reason } : void 0;
    const roadLater = edgePick?.follow && step && step.edge === edgePick.edge && !road22 ? { edge: edgePick.follow, reason: "Then this road. It is the next one toward the settlement." } : void 0;
    const brief = situationBrief(ranked.read, input.oppHand ? { hand: input.oppHand, unknown: input.oppUnknown ?? 0 } : void 0);
    const tips = [
      ...brief ? [{ title: "What he did", why: brief }] : [],
      { title: "Road battle", why: battle.text },
      { title: "Trade", why: tradeLine(hand, known, ratios, own, input.oppNeeds ?? [], action, canCity, nearPort) },
      {
        title: "Dev cards",
        why: devLine(cards, known, hand, robberOnMe, rolled, cityThisTurn, canPlaceNow, settleClose, battle, his, oppSize, input.oppNeeds ?? [], spot, input.oppHand ? richest(input.oppHand) : holdingResource(ranked.read), knightNote, rbLine, mono ? monopolySentence(mono, playMono, spendsDev) : void 0)
      }
    ];
    if (known && total(hand) > discardLimit) {
      tips.unshift({
        title: "A 7 discards from this hand",
        why: rolled ? `You hold ${total(hand)} cards after the roll. ${headline}` : `You hold ${total(hand)} cards. Drop ${Math.floor(total(hand) / 2)} if a 7 comes before you have rolled. ${headline}`
      });
    }
    const shown = heldBrick || action === "port" ? void 0 : action === "settle" || action === "settleTrade" || action === "burst" ? touching : spot;
    const mark = !heldBrick && action !== "port" && (action === "settle" || action === "settleTrade" || action === "burst" || action === "road" || action === "roadBuild" && !trophy1 && !trophy2);
    const heLeadsArmy = Boolean(oppSnap?.hasLargestArmy || (oppSnap?.army ?? 0) >= 3 && meSnap?.hasLargestArmy !== true);
    const raceLead = heLeadsArmy ? " He leads the army, so the road is the other two points." : oppSnap?.hasLongestRoad ? " He holds the longest road, so dev cards are the other way after the city." : "";
    const phase = phaseLine(myCities, myBuildings, onFour, Boolean(nearPort), endgame, own);
    const pct = positionWin(input.board, input.placements, input.me, { hand: known ? hand : void 0, myVp, hisVp, ratios, rollCount: seenRolls.length });
    const nextRoll = nextRollText(seenFaces, alignedBag);
    const sevenLine = headline.startsWith("Drop ") || headline.startsWith("Spend ") || headline.startsWith("Give ") ? `${headline} ${sevensText(seenFaces, alignedBag, input.me)}` : `${sevensText(seenFaces, alignedBag, input.me)}${known ? ` You hold ${total(hand)}.` : ""}`;
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
      settle: shown ? {
        at: shown.at,
        dist: shown.dist,
        mark: Boolean(mark),
        reason: shown.reason
      } : void 0,
      alt: choice.alt && choice.alt.at !== shown?.at ? { at: choice.alt.at, reason: choice.alt.reason } : void 0,
      road: road2,
      road2: road22,
      roadLater
    };
  }
  function vpOf(snap, placements, id) {
    const built = id ? publicVp(placements, id) : 0;
    if (snap && snap.vp > 0) return Math.max(snap.vp, built);
    return built;
  }
  function ratiosOf(snap) {
    const out = { lumber: 4, brick: 4, wool: 4, grain: 4, ore: 4 };
    if (!snap) return out;
    for (const r of RESOURCES) if (snap.ratios[r]) out[r] = snap.ratios[r];
    return out;
  }
  function bankFour(hand, ratios, cost) {
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
  function keyBlock(ctx, placements, me2, robberHex) {
    const dep = hexDependence(ctx, placements, (o) => o !== me2);
    const ports = /* @__PURE__ */ new Set();
    for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
      if (owner === me2) continue;
      const port = ctx.byAt.get(at)?.port;
      if (port && port !== "any") ports.add(port);
    }
    const hex = robberHex ? ctx.hexById.get(robberHex) : void 0;
    const share = robberHex ? dep.get(robberHex)?.share ?? 0 : 0;
    const onKey = Boolean(hex?.resource && (hex.resource === "grain" && share >= 0.9 || hex.resource === "ore" && share >= 0.9 || ports.has(hex.resource) && share >= 0.5));
    if (onKey && hex?.resource) return `Hold the knight. The robber is already on his ${LABEL4[hex.resource]}. When he clears it, put it back.`;
    for (const [id, info] of dep) {
      const h2 = ctx.hexById.get(id);
      if (h2?.resource === "grain" && info.share >= 0.9 && id !== robberHex) return "Put the robber back on his wheat when you play the knight.";
    }
    return "";
  }
  function missingNames(hand, cost) {
    const names = [];
    for (const r of RESOURCES) {
      const miss = (cost[r] ?? 0) - hand[r];
      if (miss > 0) names.push(LABEL4[r]);
    }
    return names;
  }
  function richest(hand) {
    return RESOURCES.filter((r) => hand[r] > 0).sort((a, b) => hand[b] - hand[a])[0];
  }
  function brickWhy(spot, missing, oppCanCity) {
    const name = `${spot.numbers.join("/")} (${spot.pips} pips)`;
    const miss = missing.length ? ` You cannot settle there: you are missing ${missing.join(" and ")}.` : "";
    const city2 = oppCanCity ? " He can pay for a city right now." : "";
    return `${name} is not worth the brick. You barely produce wood or brick, so this is the last road for a while.${miss} Do not trade the wood away.${city2}`;
  }
  function phaseLine(cities, buildings, onFour, portNear, endgame, own) {
    if (endgame) return " Endgame: the army, the longest road, or a dev point. Monopoly takes the cards that finish it.";
    if (cities === 0) return own.ore > 0 && own.grain > 0 ? " Early: city before you spread." : " Early: road to the ore and wheat, or the wood and brick you do not make.";
    if (onFour && portNear) return " After the city: the better settlement, a port only when that spot beats the inland one.";
    if (buildings < 3) return " Midgame: the third settlement is the next build.";
    return " Late: the remaining points are the army, the road, or a dev card.";
  }
  function monopolyCall(oppHand, oppUnknown, his, oppNeeds, holding) {
    const counted = Boolean(oppHand && (oppUnknown ?? 0) === 0 && total(oppHand) > 0);
    if (counted && oppHand) {
      if (canBuild(oppHand, "city") && (oppHand.grain > 0 || oppHand.ore > 0)) {
        const resource3 = oppHand.grain > 0 && oppHand.grain >= oppHand.ore ? "grain" : "ore";
        return { resource: resource3, why: `He holds ${oppHand.grain} wheat and ${oppHand.ore} ore, and he can pay for a city. Calling ${LABEL4[resource3]} takes that city off the table.` };
      }
      const resource2 = richest(oppHand) ?? "ore";
      return { resource: resource2, why: `He holds ${oppHand[resource2]} ${LABEL4[resource2]}, which is the largest pile in his hand.` };
    }
    const resource = holding ?? oppNeeds[0] ?? RESOURCES.slice().sort((a, b) => his[b] - his[a])[0];
    return { resource, why: `His hand is not fully counted, so call ${LABEL4[resource]}, the resource showing up most.` };
  }
  function monopolySentence(call, play, spendsDev) {
    if (spendsDev) return `One dev card this turn, so save Monopoly. Call ${LABEL4[call.resource]} next turn. ${call.why}`;
    if (play) return `Play Monopoly on ${LABEL4[call.resource]}. ${call.why}`;
    return `Hold Monopoly. Call ${LABEL4[call.resource]} when his hand is large. ${call.why}`;
  }
  function withRoad2(placements, edge, owner) {
    const roads = new Map(placements.roads);
    roads.set(edge, owner);
    return { settlements: placements.settlements, cities: placements.cities, roads };
  }
  function secondFreeRoad(board, placements, me2, firstEdge, spot, spots, port, trophy, preferPort) {
    const after = withRoad2(placements, firstEdge, me2);
    let best;
    const aim = (at, reason, score) => {
      const step = roadToward(board, after, me2, at);
      if (!step || step.edge === firstEdge) return;
      if (!best || score > best.score) best = { edge: step.edge, toward: at, reason, score };
    };
    if (trophy) {
      const ext2 = longestExtensions(board, after, me2).find((e) => e.edge !== firstEdge);
      if (ext2) return { edge: ext2.edge, toward: ext2.to, reason: "Second road takes the longest road." };
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
    const ext = longestExtensions(board, after, me2).find((e) => e.edge !== firstEdge);
    if (ext) return { edge: ext.edge, toward: ext.to, reason: "Second road continues that line." };
    return void 0;
  }
  function total(h2) {
    return RESOURCES.reduce((s, r) => s + h2[r], 0);
  }
  function listCards(counts) {
    const parts = RESOURCES.filter((r) => (counts[r] ?? 0) > 0).map((r) => `${counts[r]} ${LABEL4[r]}`);
    if (parts.length <= 1) return parts[0] ?? "";
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  }
  function keepFor(hand, own, action) {
    const keep = {};
    const cityish = action === "city" || action === "cityTrade" || action === "yop" || action === "burst" || own.ore > 0 && own.grain > 0;
    if (cityish) {
      keep.grain = Math.min(hand.grain, 2);
      keep.ore = Math.min(hand.ore, 3);
    }
    keep.lumber = Math.min(hand.lumber, 1);
    keep.brick = Math.min(hand.brick, 1);
    return keep;
  }
  function cardsToDrop(hand, own, keep, n) {
    const left = { ...hand };
    const dropped = {};
    let need = n;
    const take = (r, k) => {
      const m = Math.min(k, left[r], need);
      if (m <= 0) return;
      left[r] -= m;
      dropped[r] = (dropped[r] ?? 0) + m;
      need -= m;
    };
    const byProd = (a, b) => own[b] - own[a] || left[b] - left[a];
    for (const r of RESOURCES.slice().sort(byProd)) take(r, left[r] - (keep[r] ?? 0));
    for (const r of RESOURCES.slice().sort(byProd)) take(r, left[r]);
    return dropped;
  }
  function dropSentence(dropped, hand, keep) {
    const kept = RESOURCES.filter((r) => (keep[r] ?? 0) > 0 && hand[r] - (dropped[r] ?? 0) > 0).map((r) => LABEL4[r]);
    const hold = kept.length ? ` Keep the ${kept.join(" and the ")}.` : "";
    return `Drop ${listCards(dropped)}.${hold}`;
  }
  function spendDown(hand, ratios, own, action, limit, spotName) {
    const goal = action === "city" || action === "cityTrade" || action === "yop" ? { cost: COSTS.city, name: "the city" } : action === "settle" || action === "settleTrade" || action === "burst" ? { cost: action === "burst" ? { lumber: 1, brick: 1, wool: 1, grain: 3, ore: 3 } : COSTS.settlement, name: action === "burst" ? "the settlement and the city" : "the settlement" } : action === "road" || action === "trophy" || action === "trophy2" || action === "port" ? { cost: COSTS.road, name: action === "port" ? "the road to the port" : `the road toward ${spotName}` } : action === "buyDev" ? { cost: COSTS.dev, name: "the development card" } : void 0;
    if (!goal) return void 0;
    const next = { ...hand };
    const gave = {};
    if (!canPay3(next, goal.cost)) {
      if (action !== "city" && action !== "cityTrade" && action !== "yop") return void 0;
      for (let n = 0; n < 4 && !canPay3(next, goal.cost); n++) {
        const want = RESOURCES.find((r) => next[r] < (goal.cost[r] ?? 0));
        if (!want) break;
        const give = RESOURCES.filter((r) => r !== want && next[r] >= ratios[r] && next[r] - ratios[r] >= (goal.cost[r] ?? 0)).sort((a, b) => next[b] - next[a])[0];
        if (!give || ratios[give] >= 4 && action !== "city" && action !== "cityTrade") return void 0;
        gave[give] = (gave[give] ?? 0) + ratios[give];
        next[give] -= ratios[give];
        next[want]++;
      }
      if (!canPay3(next, goal.cost)) return void 0;
    }
    const paid = {};
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
    if (left > limit) return void 0;
    const trade = RESOURCES.some((r) => (gave[r] ?? 0) > 0) ? `Give ${listCards(gave)} ` : "";
    const verb = trade ? `and spend ${listCards(paid)} on ${goal.name}.` : `Spend ${listCards(paid)} on ${goal.name}.`;
    return `${trade}${verb}${extra} That leaves ${left} cards.`;
  }
  function canPay3(h2, cost) {
    return RESOURCES.every((r) => h2[r] >= (cost[r] ?? 0));
  }
  function finishWith(hand, cost, limit) {
    const need = [];
    for (const r of RESOURCES) for (let i = hand[r]; i < (cost[r] ?? 0); i++) need.push(r);
    return need.length > 0 && need.length <= limit ? need : void 0;
  }
  function tradesToPay(hand, ratios, cost) {
    const have = { ...hand };
    let trades = 0;
    for (let n = 0; n < 6 && !canPay3(have, cost); n++) {
      const want = RESOURCES.find((r) => have[r] < (cost[r] ?? 0));
      if (!want) break;
      const give = RESOURCES.filter((r) => r !== want && have[r] >= ratios[r] && have[r] - ratios[r] >= (cost[r] ?? 0)).sort((a, b) => have[b] / ratios[b] - have[a] / ratios[a])[0];
      if (!give) return 99;
      have[give] -= ratios[give];
      have[want]++;
      trades++;
    }
    return canPay3(have, cost) ? trades : 99;
  }
  function tradeLine(hand, known, ratios, own, oppNeeds, action, canCity, nearPort) {
    if (!known) return "Your hand is not readable yet, so do not follow a card-for-card trade until the counter shows your cards.";
    if (action === "port") return nearPort ? `Do not 4:1. Road to the port. ${nearPort.text}` : "Do not 4:1. Road to the port.";
    const goal = action === "city" || action === "cityTrade" || action === "yop" ? COSTS.city : action === "settle" || action === "settleTrade" ? COSTS.settlement : action === "road" || action === "trophy" || action === "trophy2" ? COSTS.road : action === "buyDev" ? COSTS.dev : void 0;
    const name = goal === COSTS.city ? "city" : goal === COSTS.settlement ? "settlement" : goal === COSTS.dev ? "dev card" : "road";
    if (!goal || canPay3(hand, goal) || action === "yop" || action === "roadBuild" || action === "army" || action === "knight") {
      if (canCity || goal && canPay3(hand, goal)) return `You can pay for the ${canCity ? "city" : name} without trading. Do not give cards away.`;
      return "Do not trade. You are not one trade from a city, a settlement or a dev card, and a trade now only feeds him or sets up a discard.";
    }
    const parts = [];
    const scratch = { ...hand };
    const missing = RESOURCES.filter((r) => scratch[r] < (goal[r] ?? 0));
    for (const want of missing) {
      while (scratch[want] < (goal[want] ?? 0)) {
        const give = RESOURCES.filter((r) => r !== want && scratch[r] >= ratios[r] && scratch[r] - ratios[r] >= (goal[r] ?? 0)).sort((a, b) => scratch[b] - scratch[a] || own[b] - own[a])[0];
        if (!give) break;
        const rate = ratios[give];
        const where = rate === 2 ? `your 2:1 ${LABEL4[give]}` : rate === 3 ? "your 3:1 port" : "the bank at 4:1";
        const warn = oppNeeds.includes(want) ? ` Do not buy the ${LABEL4[want]} from him; he needs it himself. Use ${where}.` : "";
        parts.push(`Give ${rate} ${LABEL4[give]} for 1 ${LABEL4[want]} at ${where}.${warn}`);
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
  function roadBattle(myLen, oppLen, iHold, heHolds) {
    const target = heHolds ? oppLen + 1 : Math.max(5, oppLen + 1);
    const roadsNeeded = iHold ? 0 : Math.max(0, target - myLen);
    if (iHold && oppLen <= myLen - 2) {
      return { worth: false, roadsNeeded: 0, text: `You hold the longest road at ${myLen}. He is on ${oppLen}, so he needs more than one road to take it. Do not build a road only to lengthen it.` };
    }
    if (iHold && oppLen === myLen - 1) {
      return { worth: false, roadsNeeded: 1, text: `You hold it at ${myLen} and he is on ${oppLen}. He takes it if he builds two roads and you build none. Extend only when that same road also moves toward a settlement or a port.` };
    }
    if (heHolds && roadsNeeded >= 2) {
      return { worth: false, roadsNeeded, text: `Skip the road battle. You have ${myLen}, he has ${oppLen} and he holds it. Catching him takes ${roadsNeeded} roads and he can match you. Spend roads on a settlement or a port instead.` };
    }
    if (!iHold && roadsNeeded === 1 && myLen + 1 >= 5) {
      return { worth: true, roadsNeeded: 1, text: `One road makes yours ${myLen + 1}, longer than his ${oppLen}. That is the longest road, worth 2 VP. Take it when you cannot city this turn; a city is permanent income, and he can steal the road back.` };
    }
    if (!iHold && roadsNeeded === 2 && myLen + 2 >= 5) {
      return { worth: true, roadsNeeded: 2, text: `Two roads take the longest road (you ${myLen}, him ${oppLen}, 2 VP). Do it only if you are not already one road from a good settlement.` };
    }
    if (roadsNeeded >= 3) {
      return { worth: false, roadsNeeded, text: `Skip the road battle. You have ${myLen} and he has ${oppLen}. Catching him takes ${roadsNeeded} roads. Spend roads on a settlement or a port instead.` };
    }
    return { worth: false, roadsNeeded, text: `No road battle yet. You have ${myLen} and he has ${oppLen}. Longest road starts at 5 and only pays when you can take it in one or two roads.` };
  }
  function devLine(cards, known, hand, robberOnMe, rolled, citySoon, canPlace, spotClose, battle, his, oppHand, oppNeeds, spot, holding, knightNote = "", roadBuildText, monopolyText) {
    const lines = [];
    if (cards.includes("knight")) {
      lines.push(
        knightNote ? knightNote : robberOnMe ? rolled ? "You already rolled, so play the knight before you pass: it still steals a card and moves the robber off you." : "Play the knight before you roll. The robber is on you, and playing it after the roll wastes the production." : "Hold the knight until the robber lands on you or until you can move it onto the hex he depends on. You may play one dev card on your turn, and never the turn you bought it."
      );
    }
    if (cards.includes("victoryPoint")) lines.push("Keep the victory point hidden. It already counts, and showing it tells him how close you are.");
    if (cards.includes("roadBuilding")) {
      const toward = spot && spot.dist <= 2 && spot.dist > 0 ? ` toward ${spot.numbers.join("/")} (${spot.pips} pips)` : "";
      lines.push(
        roadBuildText ? roadBuildText : battle.worth && battle.roadsNeeded <= 2 ? "Play Road Building and lay both roads into the longest-road fight." : toward ? `Play Road Building${toward}. Both free roads should end on that settlement or on the road that takes the longest road.` : "Hold Road Building until both free roads reach a settlement or take the longest road. Playing it into an empty coast wastes the card."
      );
    }
    if (cards.includes("yearOfPlenty")) {
      const cityNeed = finishWith(hand, COSTS.city, 2);
      const settleNeed = finishWith(hand, COSTS.settlement, 2);
      const need = cityNeed ?? settleNeed;
      lines.push(
        need ? `Play Year of Plenty for ${need.map((r) => LABEL4[r]).join(" and ")}. That finishes the ${cityNeed ? "city" : "settlement"}.` : "Hold Year of Plenty until two cards finish a city or a settlement."
      );
    }
    if (cards.includes("monopoly")) {
      const rich = RESOURCES.slice().sort((a, b) => his[b] - his[a])[0];
      const named = holding ?? oppNeeds[0] ?? rich;
      lines.push(
        monopolyText ? monopolyText : oppHand >= 6 ? `Play Monopoly on ${LABEL4[named]} while his hand is large (${oppHand} cards).` : `Hold Monopoly. Call ${LABEL4[named]} when his hand is large.`
      );
    }
    if (!lines.length) {
      if (!known) return "Buy a dev card only when a city is not close and your hand is showing. You cannot play a card on the turn you buy it.";
      if (citySoon) return "Do not buy a dev card. Finish the city. A dev card cannot be played on the turn you buy it, so it does nothing for you right now.";
      if (canPlace || spotClose) return "Settle before you buy a dev card. The settlement produces every roll; the card sits for a turn.";
      if (canPay3(hand, COSTS.dev)) return "You can pay for a dev card and nothing better is ready. Buy it, then wait a turn to play it. Three knights are the largest army (2 VP), and one card in five is a hidden point.";
      return "No dev card to play. Buy one when you can pay and a city or settlement is not closer.";
    }
    return lines.join(" ");
  }
  function robberHits(ctx, placements, me2, robberHex) {
    if (!robberHex) return false;
    for (const [at, owner] of [...placements.settlements, ...placements.cities]) {
      if (owner !== me2) continue;
      if (ctx.byAt.get(at)?.hexIds.includes(robberHex)) return true;
    }
    return false;
  }

  // node_modules/@msgpack/msgpack/dist.esm/utils/utf8.mjs
  var sharedTextEncoder = new TextEncoder();
  var CHUNK_SIZE = 4096;
  function utf8DecodeJs(bytes, inputOffset, byteLength) {
    let offset = inputOffset;
    const end = offset + byteLength;
    const units = [];
    let result = "";
    while (offset < end) {
      const byte1 = bytes[offset++];
      if ((byte1 & 128) === 0) {
        units.push(byte1);
      } else if ((byte1 & 224) === 192) {
        const byte2 = bytes[offset++] & 63;
        units.push((byte1 & 31) << 6 | byte2);
      } else if ((byte1 & 240) === 224) {
        const byte2 = bytes[offset++] & 63;
        const byte3 = bytes[offset++] & 63;
        units.push((byte1 & 31) << 12 | byte2 << 6 | byte3);
      } else if ((byte1 & 248) === 240) {
        const byte2 = bytes[offset++] & 63;
        const byte3 = bytes[offset++] & 63;
        const byte4 = bytes[offset++] & 63;
        let unit = (byte1 & 7) << 18 | byte2 << 12 | byte3 << 6 | byte4;
        if (unit > 65535) {
          unit -= 65536;
          units.push(unit >>> 10 & 1023 | 55296);
          unit = 56320 | unit & 1023;
        }
        units.push(unit);
      } else {
        units.push(byte1);
      }
      if (units.length >= CHUNK_SIZE) {
        result += String.fromCharCode(...units);
        units.length = 0;
      }
    }
    if (units.length > 0) {
      result += String.fromCharCode(...units);
    }
    return result;
  }
  var sharedTextDecoder = new TextDecoder();
  var TEXT_DECODER_THRESHOLD = 200;
  function utf8DecodeTD(bytes, inputOffset, byteLength) {
    const stringBytes = bytes.subarray(inputOffset, inputOffset + byteLength);
    return sharedTextDecoder.decode(stringBytes);
  }
  function utf8Decode(bytes, inputOffset, byteLength) {
    if (byteLength > TEXT_DECODER_THRESHOLD) {
      return utf8DecodeTD(bytes, inputOffset, byteLength);
    } else {
      return utf8DecodeJs(bytes, inputOffset, byteLength);
    }
  }

  // node_modules/@msgpack/msgpack/dist.esm/ExtData.mjs
  var ExtData = class {
    type;
    data;
    constructor(type, data) {
      this.type = type;
      this.data = data;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/DecodeError.mjs
  var DecodeError = class _DecodeError extends Error {
    constructor(message) {
      super(message);
      const proto = Object.create(_DecodeError.prototype);
      Object.setPrototypeOf(this, proto);
      Object.defineProperty(this, "name", {
        configurable: true,
        enumerable: false,
        value: _DecodeError.name
      });
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/utils/int.mjs
  var UINT32_MAX = 4294967295;
  function setInt64(view, offset, value) {
    const high = Math.floor(value / 4294967296);
    const low = value;
    view.setUint32(offset, high);
    view.setUint32(offset + 4, low);
  }
  function getInt64(view, offset) {
    const high = view.getInt32(offset);
    const low = view.getUint32(offset + 4);
    return high * 4294967296 + low;
  }
  function getUint64(view, offset) {
    const high = view.getUint32(offset);
    const low = view.getUint32(offset + 4);
    return high * 4294967296 + low;
  }

  // node_modules/@msgpack/msgpack/dist.esm/timestamp.mjs
  var EXT_TIMESTAMP = -1;
  var TIMESTAMP32_MAX_SEC = 4294967296 - 1;
  var TIMESTAMP64_MAX_SEC = 17179869184 - 1;
  function encodeTimeSpecToTimestamp({ sec, nsec }) {
    if (sec >= 0 && nsec >= 0 && sec <= TIMESTAMP64_MAX_SEC) {
      if (nsec === 0 && sec <= TIMESTAMP32_MAX_SEC) {
        const rv = new Uint8Array(4);
        const view = new DataView(rv.buffer);
        view.setUint32(0, sec);
        return rv;
      } else {
        const secHigh = sec / 4294967296;
        const secLow = sec & 4294967295;
        const rv = new Uint8Array(8);
        const view = new DataView(rv.buffer);
        view.setUint32(0, nsec << 2 | secHigh & 3);
        view.setUint32(4, secLow);
        return rv;
      }
    } else {
      const rv = new Uint8Array(12);
      const view = new DataView(rv.buffer);
      view.setUint32(0, nsec);
      setInt64(view, 4, sec);
      return rv;
    }
  }
  function encodeDateToTimeSpec(date) {
    const msec = date.getTime();
    const sec = Math.floor(msec / 1e3);
    const nsec = (msec - sec * 1e3) * 1e6;
    const nsecInSec = Math.floor(nsec / 1e9);
    return {
      sec: sec + nsecInSec,
      nsec: nsec - nsecInSec * 1e9
    };
  }
  function encodeTimestampExtension(object) {
    if (object instanceof Date) {
      const timeSpec = encodeDateToTimeSpec(object);
      return encodeTimeSpecToTimestamp(timeSpec);
    } else {
      return null;
    }
  }
  function decodeTimestampToTimeSpec(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (data.byteLength) {
      case 4: {
        const sec = view.getUint32(0);
        const nsec = 0;
        return { sec, nsec };
      }
      case 8: {
        const nsec30AndSecHigh2 = view.getUint32(0);
        const secLow32 = view.getUint32(4);
        const sec = (nsec30AndSecHigh2 & 3) * 4294967296 + secLow32;
        const nsec = nsec30AndSecHigh2 >>> 2;
        return { sec, nsec };
      }
      case 12: {
        const sec = getInt64(view, 4);
        const nsec = view.getUint32(0);
        return { sec, nsec };
      }
      default:
        throw new DecodeError(`Unrecognized data size for timestamp (expected 4, 8, or 12): ${data.length}`);
    }
  }
  function decodeTimestampExtension(data) {
    const timeSpec = decodeTimestampToTimeSpec(data);
    return new Date(timeSpec.sec * 1e3 + timeSpec.nsec / 1e6);
  }
  var timestampExtension = {
    type: EXT_TIMESTAMP,
    encode: encodeTimestampExtension,
    decode: decodeTimestampExtension
  };

  // node_modules/@msgpack/msgpack/dist.esm/ExtensionCodec.mjs
  var ExtensionCodec = class _ExtensionCodec {
    static defaultCodec = new _ExtensionCodec();
    // ensures ExtensionCodecType<X> matches ExtensionCodec<X>
    // this will make type errors a lot more clear
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __brand;
    // built-in extensions
    builtInEncoders = [];
    builtInDecoders = [];
    // custom extensions
    encoders = [];
    decoders = [];
    constructor() {
      this.register(timestampExtension);
    }
    register({ type, encode, decode: decode2 }) {
      if (type >= 0) {
        this.encoders[type] = encode;
        this.decoders[type] = decode2;
      } else {
        const index = -1 - type;
        this.builtInEncoders[index] = encode;
        this.builtInDecoders[index] = decode2;
      }
    }
    tryToEncode(object, context) {
      for (let i = 0; i < this.builtInEncoders.length; i++) {
        const encodeExt = this.builtInEncoders[i];
        if (encodeExt != null) {
          const data = encodeExt(object, context);
          if (data != null) {
            const type = -1 - i;
            return new ExtData(type, data);
          }
        }
      }
      for (let i = 0; i < this.encoders.length; i++) {
        const encodeExt = this.encoders[i];
        if (encodeExt != null) {
          const data = encodeExt(object, context);
          if (data != null) {
            const type = i;
            return new ExtData(type, data);
          }
        }
      }
      if (object instanceof ExtData) {
        return object;
      }
      return null;
    }
    decode(data, type, context) {
      const decodeExt = type < 0 ? this.builtInDecoders[-1 - type] : this.decoders[type];
      if (decodeExt) {
        return decodeExt(data, type, context);
      } else {
        return new ExtData(type, data);
      }
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/utils/typedArrays.mjs
  function isArrayBufferLike(buffer) {
    return buffer instanceof ArrayBuffer || typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
  }
  function ensureUint8Array(buffer) {
    if (buffer instanceof Uint8Array) {
      return buffer;
    } else if (ArrayBuffer.isView(buffer)) {
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (isArrayBufferLike(buffer)) {
      return new Uint8Array(buffer);
    } else {
      return Uint8Array.from(buffer);
    }
  }

  // node_modules/@msgpack/msgpack/dist.esm/utils/prettyByte.mjs
  function prettyByte(byte) {
    return `${byte < 0 ? "-" : ""}0x${Math.abs(byte).toString(16).padStart(2, "0")}`;
  }

  // node_modules/@msgpack/msgpack/dist.esm/CachedKeyDecoder.mjs
  var DEFAULT_MAX_KEY_LENGTH = 16;
  var DEFAULT_MAX_LENGTH_PER_KEY = 16;
  var CachedKeyDecoder = class {
    hit = 0;
    miss = 0;
    caches;
    maxKeyLength;
    maxLengthPerKey;
    constructor(maxKeyLength = DEFAULT_MAX_KEY_LENGTH, maxLengthPerKey = DEFAULT_MAX_LENGTH_PER_KEY) {
      this.maxKeyLength = maxKeyLength;
      this.maxLengthPerKey = maxLengthPerKey;
      this.caches = [];
      for (let i = 0; i < this.maxKeyLength; i++) {
        this.caches.push([]);
      }
    }
    canBeCached(byteLength) {
      return byteLength > 0 && byteLength <= this.maxKeyLength;
    }
    find(bytes, inputOffset, byteLength) {
      const records = this.caches[byteLength - 1];
      FIND_CHUNK: for (const record of records) {
        const recordBytes = record.bytes;
        for (let j = 0; j < byteLength; j++) {
          if (recordBytes[j] !== bytes[inputOffset + j]) {
            continue FIND_CHUNK;
          }
        }
        return record.str;
      }
      return null;
    }
    store(bytes, value) {
      const records = this.caches[bytes.length - 1];
      const record = { bytes, str: value };
      if (records.length >= this.maxLengthPerKey) {
        records[Math.random() * records.length | 0] = record;
      } else {
        records.push(record);
      }
    }
    decode(bytes, inputOffset, byteLength) {
      const cachedValue = this.find(bytes, inputOffset, byteLength);
      if (cachedValue != null) {
        this.hit++;
        return cachedValue;
      }
      this.miss++;
      const str = utf8DecodeJs(bytes, inputOffset, byteLength);
      const slicedCopyOfBytes = Uint8Array.prototype.slice.call(bytes, inputOffset, inputOffset + byteLength);
      this.store(slicedCopyOfBytes, str);
      return str;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/Decoder.mjs
  var STATE_ARRAY = "array";
  var STATE_MAP_KEY = "map_key";
  var STATE_MAP_VALUE = "map_value";
  var mapKeyConverter = (key) => {
    if (typeof key === "string" || typeof key === "number") {
      return key;
    }
    throw new DecodeError("The type of key must be string or number but " + typeof key);
  };
  var StackPool = class {
    stack = [];
    stackHeadPosition = -1;
    get length() {
      return this.stackHeadPosition + 1;
    }
    top() {
      return this.stack[this.stackHeadPosition];
    }
    pushArrayState(size) {
      const state = this.getUninitializedStateFromPool();
      state.type = STATE_ARRAY;
      state.position = 0;
      state.size = size;
      state.array = new Array(size);
    }
    pushMapState(size) {
      const state = this.getUninitializedStateFromPool();
      state.type = STATE_MAP_KEY;
      state.readCount = 0;
      state.size = size;
      state.map = {};
    }
    getUninitializedStateFromPool() {
      this.stackHeadPosition++;
      if (this.stackHeadPosition === this.stack.length) {
        const partialState = {
          type: void 0,
          size: 0,
          array: void 0,
          position: 0,
          readCount: 0,
          map: void 0,
          key: null
        };
        this.stack.push(partialState);
      }
      return this.stack[this.stackHeadPosition];
    }
    release(state) {
      const topStackState = this.stack[this.stackHeadPosition];
      if (topStackState !== state) {
        throw new Error("Invalid stack state. Released state is not on top of the stack.");
      }
      if (state.type === STATE_ARRAY) {
        const partialState = state;
        partialState.size = 0;
        partialState.array = void 0;
        partialState.position = 0;
        partialState.type = void 0;
      }
      if (state.type === STATE_MAP_KEY || state.type === STATE_MAP_VALUE) {
        const partialState = state;
        partialState.size = 0;
        partialState.map = void 0;
        partialState.readCount = 0;
        partialState.type = void 0;
      }
      this.stackHeadPosition--;
    }
    reset() {
      this.stack.length = 0;
      this.stackHeadPosition = -1;
    }
  };
  var HEAD_BYTE_REQUIRED = -1;
  var EMPTY_VIEW = new DataView(new ArrayBuffer(0));
  var EMPTY_BYTES = new Uint8Array(EMPTY_VIEW.buffer);
  try {
    EMPTY_VIEW.getInt8(0);
  } catch (e) {
    if (!(e instanceof RangeError)) {
      throw new Error("This module is not supported in the current JavaScript engine because DataView does not throw RangeError on out-of-bounds access");
    }
  }
  var MORE_DATA = new RangeError("Insufficient data");
  var sharedCachedKeyDecoder = new CachedKeyDecoder();
  var Decoder = class _Decoder {
    extensionCodec;
    context;
    useBigInt64;
    rawStrings;
    maxStrLength;
    maxBinLength;
    maxArrayLength;
    maxMapLength;
    maxExtLength;
    keyDecoder;
    mapKeyConverter;
    totalPos = 0;
    pos = 0;
    view = EMPTY_VIEW;
    bytes = EMPTY_BYTES;
    headByte = HEAD_BYTE_REQUIRED;
    stack = new StackPool();
    entered = false;
    constructor(options) {
      this.extensionCodec = options?.extensionCodec ?? ExtensionCodec.defaultCodec;
      this.context = options?.context;
      this.useBigInt64 = options?.useBigInt64 ?? false;
      this.rawStrings = options?.rawStrings ?? false;
      this.maxStrLength = options?.maxStrLength ?? UINT32_MAX;
      this.maxBinLength = options?.maxBinLength ?? UINT32_MAX;
      this.maxArrayLength = options?.maxArrayLength ?? UINT32_MAX;
      this.maxMapLength = options?.maxMapLength ?? UINT32_MAX;
      this.maxExtLength = options?.maxExtLength ?? UINT32_MAX;
      this.keyDecoder = options?.keyDecoder !== void 0 ? options.keyDecoder : sharedCachedKeyDecoder;
      this.mapKeyConverter = options?.mapKeyConverter ?? mapKeyConverter;
    }
    clone() {
      return new _Decoder({
        extensionCodec: this.extensionCodec,
        context: this.context,
        useBigInt64: this.useBigInt64,
        rawStrings: this.rawStrings,
        maxStrLength: this.maxStrLength,
        maxBinLength: this.maxBinLength,
        maxArrayLength: this.maxArrayLength,
        maxMapLength: this.maxMapLength,
        maxExtLength: this.maxExtLength,
        keyDecoder: this.keyDecoder
      });
    }
    reinitializeState() {
      this.totalPos = 0;
      this.headByte = HEAD_BYTE_REQUIRED;
      this.stack.reset();
    }
    setBuffer(buffer) {
      const bytes = ensureUint8Array(buffer);
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
    }
    appendBuffer(buffer) {
      if (this.headByte === HEAD_BYTE_REQUIRED && !this.hasRemaining(1)) {
        this.setBuffer(buffer);
      } else {
        const remainingData = this.bytes.subarray(this.pos);
        const newData = ensureUint8Array(buffer);
        const newBuffer = new Uint8Array(remainingData.length + newData.length);
        newBuffer.set(remainingData);
        newBuffer.set(newData, remainingData.length);
        this.setBuffer(newBuffer);
      }
    }
    hasRemaining(size) {
      return this.view.byteLength - this.pos >= size;
    }
    createExtraByteError(posToShow) {
      const { view, pos } = this;
      return new RangeError(`Extra ${view.byteLength - pos} of ${view.byteLength} byte(s) found at buffer[${posToShow}]`);
    }
    /**
     * @throws {@link DecodeError}
     * @throws {@link RangeError}
     */
    decode(buffer) {
      if (this.entered) {
        const instance = this.clone();
        return instance.decode(buffer);
      }
      try {
        this.entered = true;
        this.reinitializeState();
        this.setBuffer(buffer);
        const object = this.doDecodeSync();
        if (this.hasRemaining(1)) {
          throw this.createExtraByteError(this.pos);
        }
        return object;
      } finally {
        this.entered = false;
      }
    }
    *decodeMulti(buffer) {
      if (this.entered) {
        const instance = this.clone();
        yield* instance.decodeMulti(buffer);
        return;
      }
      try {
        this.entered = true;
        this.reinitializeState();
        this.setBuffer(buffer);
        while (this.hasRemaining(1)) {
          yield this.doDecodeSync();
        }
      } finally {
        this.entered = false;
      }
    }
    async decodeAsync(stream) {
      if (this.entered) {
        const instance = this.clone();
        return instance.decodeAsync(stream);
      }
      try {
        this.entered = true;
        let decoded = false;
        let object;
        for await (const buffer of stream) {
          if (decoded) {
            this.entered = false;
            throw this.createExtraByteError(this.totalPos);
          }
          this.appendBuffer(buffer);
          try {
            object = this.doDecodeSync();
            decoded = true;
          } catch (e) {
            if (!(e instanceof RangeError)) {
              throw e;
            }
          }
          this.totalPos += this.pos;
        }
        if (decoded) {
          if (this.hasRemaining(1)) {
            throw this.createExtraByteError(this.totalPos);
          }
          return object;
        }
        const { headByte, pos, totalPos } = this;
        throw new RangeError(`Insufficient data in parsing ${prettyByte(headByte)} at ${totalPos} (${pos} in the current buffer)`);
      } finally {
        this.entered = false;
      }
    }
    decodeArrayStream(stream) {
      return this.decodeMultiAsync(stream, true);
    }
    decodeStream(stream) {
      return this.decodeMultiAsync(stream, false);
    }
    async *decodeMultiAsync(stream, isArray) {
      if (this.entered) {
        const instance = this.clone();
        yield* instance.decodeMultiAsync(stream, isArray);
        return;
      }
      try {
        this.entered = true;
        let isArrayHeaderRequired = isArray;
        let arrayItemsLeft = -1;
        for await (const buffer of stream) {
          if (isArray && arrayItemsLeft === 0) {
            throw this.createExtraByteError(this.totalPos);
          }
          this.appendBuffer(buffer);
          if (isArrayHeaderRequired) {
            arrayItemsLeft = this.readArraySize();
            isArrayHeaderRequired = false;
            this.complete();
          }
          try {
            while (true) {
              yield this.doDecodeSync();
              if (--arrayItemsLeft === 0) {
                break;
              }
            }
          } catch (e) {
            if (!(e instanceof RangeError)) {
              throw e;
            }
          }
          this.totalPos += this.pos;
        }
      } finally {
        this.entered = false;
      }
    }
    doDecodeSync() {
      DECODE: while (true) {
        const headByte = this.readHeadByte();
        let object;
        if (headByte >= 224) {
          object = headByte - 256;
        } else if (headByte < 192) {
          if (headByte < 128) {
            object = headByte;
          } else if (headByte < 144) {
            const size = headByte - 128;
            if (size !== 0) {
              this.pushMapState(size);
              this.complete();
              continue DECODE;
            } else {
              object = {};
            }
          } else if (headByte < 160) {
            const size = headByte - 144;
            if (size !== 0) {
              this.pushArrayState(size);
              this.complete();
              continue DECODE;
            } else {
              object = [];
            }
          } else {
            const byteLength = headByte - 160;
            object = this.decodeString(byteLength, 0);
          }
        } else if (headByte === 192) {
          object = null;
        } else if (headByte === 194) {
          object = false;
        } else if (headByte === 195) {
          object = true;
        } else if (headByte === 202) {
          object = this.readF32();
        } else if (headByte === 203) {
          object = this.readF64();
        } else if (headByte === 204) {
          object = this.readU8();
        } else if (headByte === 205) {
          object = this.readU16();
        } else if (headByte === 206) {
          object = this.readU32();
        } else if (headByte === 207) {
          if (this.useBigInt64) {
            object = this.readU64AsBigInt();
          } else {
            object = this.readU64();
          }
        } else if (headByte === 208) {
          object = this.readI8();
        } else if (headByte === 209) {
          object = this.readI16();
        } else if (headByte === 210) {
          object = this.readI32();
        } else if (headByte === 211) {
          if (this.useBigInt64) {
            object = this.readI64AsBigInt();
          } else {
            object = this.readI64();
          }
        } else if (headByte === 217) {
          const byteLength = this.lookU8();
          object = this.decodeString(byteLength, 1);
        } else if (headByte === 218) {
          const byteLength = this.lookU16();
          object = this.decodeString(byteLength, 2);
        } else if (headByte === 219) {
          const byteLength = this.lookU32();
          object = this.decodeString(byteLength, 4);
        } else if (headByte === 220) {
          const size = this.readU16();
          if (size !== 0) {
            this.pushArrayState(size);
            this.complete();
            continue DECODE;
          } else {
            object = [];
          }
        } else if (headByte === 221) {
          const size = this.readU32();
          if (size !== 0) {
            this.pushArrayState(size);
            this.complete();
            continue DECODE;
          } else {
            object = [];
          }
        } else if (headByte === 222) {
          const size = this.readU16();
          if (size !== 0) {
            this.pushMapState(size);
            this.complete();
            continue DECODE;
          } else {
            object = {};
          }
        } else if (headByte === 223) {
          const size = this.readU32();
          if (size !== 0) {
            this.pushMapState(size);
            this.complete();
            continue DECODE;
          } else {
            object = {};
          }
        } else if (headByte === 196) {
          const size = this.lookU8();
          object = this.decodeBinary(size, 1);
        } else if (headByte === 197) {
          const size = this.lookU16();
          object = this.decodeBinary(size, 2);
        } else if (headByte === 198) {
          const size = this.lookU32();
          object = this.decodeBinary(size, 4);
        } else if (headByte === 212) {
          object = this.decodeExtension(1, 0);
        } else if (headByte === 213) {
          object = this.decodeExtension(2, 0);
        } else if (headByte === 214) {
          object = this.decodeExtension(4, 0);
        } else if (headByte === 215) {
          object = this.decodeExtension(8, 0);
        } else if (headByte === 216) {
          object = this.decodeExtension(16, 0);
        } else if (headByte === 199) {
          const size = this.lookU8();
          object = this.decodeExtension(size, 1);
        } else if (headByte === 200) {
          const size = this.lookU16();
          object = this.decodeExtension(size, 2);
        } else if (headByte === 201) {
          const size = this.lookU32();
          object = this.decodeExtension(size, 4);
        } else {
          throw new DecodeError(`Unrecognized type byte: ${prettyByte(headByte)}`);
        }
        this.complete();
        const stack = this.stack;
        while (stack.length > 0) {
          const state = stack.top();
          if (state.type === STATE_ARRAY) {
            state.array[state.position] = object;
            state.position++;
            if (state.position === state.size) {
              object = state.array;
              stack.release(state);
            } else {
              continue DECODE;
            }
          } else if (state.type === STATE_MAP_KEY) {
            if (object === "__proto__") {
              throw new DecodeError("The key __proto__ is not allowed");
            }
            state.key = this.mapKeyConverter(object);
            state.type = STATE_MAP_VALUE;
            continue DECODE;
          } else {
            state.map[state.key] = object;
            state.readCount++;
            if (state.readCount === state.size) {
              object = state.map;
              stack.release(state);
            } else {
              state.key = null;
              state.type = STATE_MAP_KEY;
              continue DECODE;
            }
          }
        }
        return object;
      }
    }
    readHeadByte() {
      if (this.headByte === HEAD_BYTE_REQUIRED) {
        this.headByte = this.readU8();
      }
      return this.headByte;
    }
    complete() {
      this.headByte = HEAD_BYTE_REQUIRED;
    }
    readArraySize() {
      const headByte = this.readHeadByte();
      switch (headByte) {
        case 220:
          return this.readU16();
        case 221:
          return this.readU32();
        default: {
          if (headByte < 160) {
            return headByte - 144;
          } else {
            throw new DecodeError(`Unrecognized array type byte: ${prettyByte(headByte)}`);
          }
        }
      }
    }
    pushMapState(size) {
      if (size > this.maxMapLength) {
        throw new DecodeError(`Max length exceeded: map length (${size}) > maxMapLengthLength (${this.maxMapLength})`);
      }
      this.stack.pushMapState(size);
    }
    pushArrayState(size) {
      if (size > this.maxArrayLength) {
        throw new DecodeError(`Max length exceeded: array length (${size}) > maxArrayLength (${this.maxArrayLength})`);
      }
      this.stack.pushArrayState(size);
    }
    decodeString(byteLength, headerOffset) {
      if (!this.rawStrings || this.stateIsMapKey()) {
        return this.decodeUtf8String(byteLength, headerOffset);
      }
      return this.decodeBinary(byteLength, headerOffset);
    }
    /**
     * @throws {@link RangeError}
     */
    decodeUtf8String(byteLength, headerOffset) {
      if (byteLength > this.maxStrLength) {
        throw new DecodeError(`Max length exceeded: UTF-8 byte length (${byteLength}) > maxStrLength (${this.maxStrLength})`);
      }
      if (this.bytes.byteLength < this.pos + headerOffset + byteLength) {
        throw MORE_DATA;
      }
      const offset = this.pos + headerOffset;
      let object;
      if (this.stateIsMapKey() && this.keyDecoder?.canBeCached(byteLength)) {
        object = this.keyDecoder.decode(this.bytes, offset, byteLength);
      } else {
        object = utf8Decode(this.bytes, offset, byteLength);
      }
      this.pos += headerOffset + byteLength;
      return object;
    }
    stateIsMapKey() {
      if (this.stack.length > 0) {
        const state = this.stack.top();
        return state.type === STATE_MAP_KEY;
      }
      return false;
    }
    /**
     * @throws {@link RangeError}
     */
    decodeBinary(byteLength, headOffset) {
      if (byteLength > this.maxBinLength) {
        throw new DecodeError(`Max length exceeded: bin length (${byteLength}) > maxBinLength (${this.maxBinLength})`);
      }
      if (!this.hasRemaining(byteLength + headOffset)) {
        throw MORE_DATA;
      }
      const offset = this.pos + headOffset;
      const object = this.bytes.subarray(offset, offset + byteLength);
      this.pos += headOffset + byteLength;
      return object;
    }
    decodeExtension(size, headOffset) {
      if (size > this.maxExtLength) {
        throw new DecodeError(`Max length exceeded: ext length (${size}) > maxExtLength (${this.maxExtLength})`);
      }
      const extType = this.view.getInt8(this.pos + headOffset);
      const data = this.decodeBinary(
        size,
        headOffset + 1
        /* extType */
      );
      return this.extensionCodec.decode(data, extType, this.context);
    }
    lookU8() {
      return this.view.getUint8(this.pos);
    }
    lookU16() {
      return this.view.getUint16(this.pos);
    }
    lookU32() {
      return this.view.getUint32(this.pos);
    }
    readU8() {
      const value = this.view.getUint8(this.pos);
      this.pos++;
      return value;
    }
    readI8() {
      const value = this.view.getInt8(this.pos);
      this.pos++;
      return value;
    }
    readU16() {
      const value = this.view.getUint16(this.pos);
      this.pos += 2;
      return value;
    }
    readI16() {
      const value = this.view.getInt16(this.pos);
      this.pos += 2;
      return value;
    }
    readU32() {
      const value = this.view.getUint32(this.pos);
      this.pos += 4;
      return value;
    }
    readI32() {
      const value = this.view.getInt32(this.pos);
      this.pos += 4;
      return value;
    }
    readU64() {
      const value = getUint64(this.view, this.pos);
      this.pos += 8;
      return value;
    }
    readI64() {
      const value = getInt64(this.view, this.pos);
      this.pos += 8;
      return value;
    }
    readU64AsBigInt() {
      const value = this.view.getBigUint64(this.pos);
      this.pos += 8;
      return value;
    }
    readI64AsBigInt() {
      const value = this.view.getBigInt64(this.pos);
      this.pos += 8;
      return value;
    }
    readF32() {
      const value = this.view.getFloat32(this.pos);
      this.pos += 4;
      return value;
    }
    readF64() {
      const value = this.view.getFloat64(this.pos);
      this.pos += 8;
      return value;
    }
  };

  // node_modules/@msgpack/msgpack/dist.esm/decode.mjs
  function decode(buffer, options) {
    const decoder = new Decoder(options);
    return decoder.decode(buffer);
  }
  function decodeMulti(buffer, options) {
    const decoder = new Decoder(options);
    return decoder.decodeMulti(buffer);
  }

  // src/analyzer/decode.ts
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function tryJson(text) {
    const trimmed = text.trim();
    const first = trimmed[0];
    if (first === "{" || first === "[") return JSON.parse(trimmed);
    const m = /^\d{1,3}(\[.*|\{.*)$/s.exec(trimmed);
    if (m) return JSON.parse(m[1]);
    throw new Error("not json");
  }
  function tryMsgpack(bytes) {
    try {
      return decode(bytes);
    } catch {
      const all = [...decodeMulti(bytes)];
      if (all.length === 0) throw new Error("empty");
      return all.length === 1 ? all[0] : all;
    }
  }
  function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function messageLabel(value) {
    if (!isObject(value)) return Array.isArray(value) ? "array" : typeof value;
    const data = isObject(value.data) ? value.data : void 0;
    const parts = [];
    if (value.id !== void 0) parts.push(String(value.id));
    if (data?.type !== void 0) parts.push(String(data.type));
    else if (value.type !== void 0) parts.push(String(value.type));
    return parts.length ? parts.join("/") : `object{${Object.keys(value).slice(0, 3).join(",")}}`;
  }
  function decodeFrame(frame, index) {
    try {
      if (frame.kind === "text") {
        const value2 = tryJson(frame.data);
        return { frame, index, kind: "json", value: value2, label: messageLabel(value2) };
      }
      const bytes = base64ToBytes(frame.data);
      const first = bytes[0];
      if (first === 123 || first === 91) {
        try {
          const value2 = JSON.parse(new TextDecoder().decode(bytes));
          return { frame, index, kind: "json", value: value2, label: messageLabel(value2) };
        } catch {
        }
      }
      const value = tryMsgpack(bytes);
      return { frame, index, kind: "msgpack", value, label: messageLabel(value) };
    } catch {
      return { frame, index, kind: "unknown", label: "undecodable" };
    }
  }
  function decodeFrames(frames) {
    const stats = { totalFrames: frames.length, jsonFrames: 0, msgpackFrames: 0, unknownFrames: 0, typeCounts: {} };
    const decoded = frames.map((f, i) => {
      const d = decodeFrame(f, i);
      if (d.kind === "json") stats.jsonFrames++;
      else if (d.kind === "msgpack") stats.msgpackFrames++;
      else stats.unknownFrames++;
      stats.typeCounts[d.label] = (stats.typeCounts[d.label] ?? 0) + 1;
      return d;
    });
    return { decoded, stats };
  }

  // src/analyzer/snapshot.ts
  var RESOURCE_BY_ID = {
    1: "lumber",
    2: "brick",
    3: "wool",
    4: "grain",
    5: "ore"
  };

  // src/analyzer/adapters/types.ts
  function isObject2(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function num(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return void 0;
  }

  // src/analyzer/adapters/stateDiff.ts
  var HEX_RESOURCE = {
    0: null,
    1: "lumber",
    2: "brick",
    3: "wool",
    4: "grain",
    5: "ore"
  };
  var DEV_CARD = {
    11: "knight",
    12: "victoryPoint",
    13: "monopoly",
    14: "roadBuilding",
    15: "yearOfPlenty"
  };
  function cloneWithoutNulls(v) {
    if (Array.isArray(v)) return v.map(cloneWithoutNulls);
    if (isObject2(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = cloneWithoutNulls(x);
      return out;
    }
    return v;
  }
  function deepMerge(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === void 0) {
        delete target[key];
      } else if (isObject2(value)) {
        const existing = target[key];
        if (isObject2(existing) || Array.isArray(existing)) deepMerge(existing, value);
        else target[key] = cloneWithoutNulls(value);
      } else {
        target[key] = value;
      }
    }
  }
  var STATE_KEYS = ["mapState", "playerStates", "diceState", "currentState", "mechanicRobberState"];
  function findStatePatch(value, depth = 0) {
    if (depth > 6) return void 0;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findStatePatch(item, depth + 1);
        if (found) return found;
      }
      return void 0;
    }
    if (!isObject2(value)) return void 0;
    if (isObject2(value.diff)) return value.diff;
    if (isObject2(value.gameState)) return value.gameState;
    if (isObject2(value.initialState)) return value.initialState;
    if (STATE_KEYS.some((k) => isObject2(value[k]))) return value;
    for (const v of Object.values(value)) {
      if (isObject2(v) || Array.isArray(v)) {
        const found = findStatePatch(v, depth + 1);
        if (found) return found;
      }
    }
    return void 0;
  }
  function holdersOf(value) {
    if (!isObject2(value)) return [];
    const data = isObject2(value.data) ? value.data : void 0;
    const payload = isObject2(value.payload) ? value.payload : isObject2(data?.payload) ? data?.payload : void 0;
    return [value, data, payload].filter((h2) => Boolean(h2));
  }
  function userStatesOf(value) {
    if (!isObject2(value)) return void 0;
    const data = isObject2(value.data) ? value.data : void 0;
    for (const holder of [value, data, isObject2(value.payload) ? value.payload : void 0, isObject2(data?.payload) ? data?.payload : void 0]) {
      if (holder && Array.isArray(holder.playerUserStates)) return holder.playerUserStates;
    }
    return void 0;
  }
  function sumVp(v) {
    if (typeof v === "number") return v;
    if (isObject2(v)) {
      let total2 = 0;
      for (const x of Object.values(v)) if (typeof x === "number") total2 += x;
      return total2;
    }
    return void 0;
  }
  function asRecord(v) {
    if (Array.isArray(v)) return Object.fromEntries(v.flatMap((x, i) => x === null || x === void 0 ? [] : [[String(i), x]]));
    return isObject2(v) ? v : void 0;
  }
  function get(tree, ...path) {
    let cur = tree;
    for (const key of path) {
      if (!isObject2(cur) && !Array.isArray(cur)) return void 0;
      cur = cur[key];
    }
    return cur;
  }
  function playerId(color) {
    return `c${color}`;
  }
  var stateDiffAdapter = {
    name: "state-diff",
    parse(frames) {
      const state = {};
      const events = [];
      const players = /* @__PURE__ */ new Map();
      const seenCorners = /* @__PURE__ */ new Map();
      const seenEdges = /* @__PURE__ */ new Set();
      const vpByPlayer = /* @__PURE__ */ new Map();
      const handByPlayer = /* @__PURE__ */ new Map();
      const devOwned = /* @__PURE__ */ new Map();
      const devUsed = /* @__PURE__ */ new Map();
      const awards = { longestRoad: "", largestArmy: "" };
      let lastRobber;
      let robberStartIndex;
      let rolls = 0;
      let lastDiceKey = "";
      let diceWasThrown = false;
      let sawState = false;
      const warnings = [];
      const userNames = /* @__PURE__ */ new Map();
      let topSelf;
      let firstStateBuildings = -1;
      for (const f of frames) {
        if (f.frame.dir !== "in" || f.value === void 0) continue;
        const users = userStatesOf(f.value);
        if (users) {
          for (const u of users) {
            if (!isObject2(u)) continue;
            const color = num(u.selectedColor ?? u.color);
            const name = typeof u.username === "string" && u.username ? u.username : void 0;
            if (color === void 0 || !name) continue;
            userNames.set(playerId(color), name);
            players.set(playerId(color), { id: playerId(color), color, name });
          }
        }
        for (const holder of holdersOf(f.value)) {
          const pc = num(holder.playerColor);
          if (pc !== void 0) topSelf = pc;
        }
        const patch = findStatePatch(f.value);
        if (!patch) continue;
        deepMerge(state, patch);
        sawState = true;
        const t = f.frame.t;
        const push = (e) => events.push({ ...e, t, turn: rolls });
        const turnColor = get(state, "currentState", "currentTurnPlayerColor") ?? get(state, "currentState", "turnPlayerColor");
        const turnPlayer2 = turnColor !== void 0 ? playerId(turnColor) : void 0;
        const playerStates = get(state, "playerStates");
        if (isObject2(playerStates)) {
          for (const [key, raw] of Object.entries(playerStates)) {
            if (!isObject2(raw)) continue;
            const color = num(raw.color) ?? num(key);
            const id = playerId(color ?? key);
            const name = [raw.username, raw.displayName, raw.name].find((n) => typeof n === "string" && n.length > 0);
            const prev = players.get(id);
            players.set(id, { id, color, name: name ?? userNames.get(id) ?? prev?.name ?? `Player ${color ?? key}` });
          }
        }
        const dice = get(state, "diceState");
        if (isObject2(dice)) {
          const thrown = dice.diceThrown === true;
          const d1 = num(dice.dice1);
          const d2 = num(dice.dice2);
          const key = `${d1}-${d2}`;
          if (thrown && d1 !== void 0 && d2 !== void 0 && (!diceWasThrown || key !== lastDiceKey)) {
            rolls++;
            push({ type: "roll", player: turnPlayer2, d1, d2, total: d1 + d2 });
          }
          diceWasThrown = thrown;
          lastDiceKey = key;
        }
        const corners = asRecord(get(state, "mapState", "tileCornerStates"));
        let buildingsThisMessage = 0;
        if (corners) {
          for (const [id, raw] of Object.entries(corners)) {
            if (!isObject2(raw)) continue;
            const owner = raw.owner;
            const kind = num(raw.buildingType);
            if (owner === void 0 || owner === null || !kind) continue;
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
            if (!isObject2(raw) || seenEdges.has(id)) continue;
            if (raw.owner === void 0 || raw.owner === null || !num(raw.type)) continue;
            seenEdges.add(id);
            buildingsThisMessage++;
            push({ type: "build", player: playerId(raw.owner), piece: "road", at: `${raw.x},${raw.y},${raw.z}`, setup: rolls === 0 });
          }
        }
        if (firstStateBuildings < 0) firstStateBuildings = buildingsThisMessage;
        const devState = get(state, "mechanicDevelopmentCardsState", "players");
        if (isObject2(devState)) {
          for (const [color, raw] of Object.entries(devState)) {
            if (!isObject2(raw)) continue;
            const id = playerId(color);
            const owned = Array.isArray(get(raw, "developmentCards", "cards")) ? get(raw, "developmentCards", "cards").length : void 0;
            const used = get(raw, "developmentCardsUsed");
            const usedList = Array.isArray(used) ? used : void 0;
            if (owned !== void 0) {
              const prev = devOwned.get(id);
              const prevUsed = devUsed.get(id) ?? 0;
              const bought = prev === void 0 ? 0 : owned + (usedList ? usedList.length - prevUsed : 0) - prev;
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
        if (isObject2(robber)) {
          const loc = num(robber.locationTileIndex);
          if (loc !== void 0) {
            if (robberStartIndex === void 0) robberStartIndex = loc;
            if (lastRobber !== void 0 && loc !== lastRobber) {
              push({ type: "robberMove", player: turnPlayer2 ?? "unknown", hex: String(loc) });
            }
            lastRobber = loc;
          }
        }
        for (const [stateKey, flag, eventType] of [
          ["mechanicLongestRoadState", "hasLongestRoad", "longestRoad"],
          ["mechanicLargestArmyState", "hasLargestArmy", "largestArmy"]
        ]) {
          const award = get(state, stateKey);
          if (!isObject2(award)) continue;
          for (const [color, raw] of Object.entries(award)) {
            if (isObject2(raw) && raw[flag] === true && awards[eventType] !== color) {
              awards[eventType] = color;
              push({ type: eventType, player: playerId(color) });
            }
          }
        }
        if (isObject2(playerStates)) {
          for (const [key, raw] of Object.entries(playerStates)) {
            if (!isObject2(raw)) continue;
            const id = playerId(num(raw.color) ?? key);
            const cards = get(raw, "resourceCards", "cards");
            if (Array.isArray(cards) && handByPlayer.get(id) !== cards.length) {
              handByPlayer.set(id, cards.length);
              push({ type: "hand", player: id, size: cards.length });
            }
            const vp = sumVp(raw.victoryPoints);
            if (vp !== void 0 && vpByPlayer.get(id) !== vp) {
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
      const ownCards = selfColor === void 0 ? void 0 : get(state, "playerStates", String(selfColor), "resourceCards", "cards");
      const selfCards = Array.isArray(ownCards) && ownCards.every((c) => typeof c === "number") ? ownCards : void 0;
      const handSizes = {};
      const finalStates = asRecord(get(state, "playerStates")) ?? {};
      for (const [key, raw] of Object.entries(finalStates)) {
        const cards = get(isObject2(raw) ? raw : {}, "resourceCards", "cards");
        if (Array.isArray(cards)) handSizes[playerId((isObject2(raw) ? num(raw.color) : void 0) ?? key)] = cards.length;
      }
      const turnPlayer = (() => {
        const c = num(get(state, "currentState", "currentTurnPlayerColor") ?? get(state, "currentState", "turnPlayerColor"));
        return c === void 0 ? void 0 : playerId(c);
      })();
      return {
        players: [...players.values()],
        events,
        board,
        warnings,
        selfId: selfColor === void 0 ? void 0 : playerId(selfColor),
        selfCards,
        handSizes,
        turnPlayer,
        snapshot: readSnapshot(state, turnPlayer)
      };
    }
  };
  function readSnapshot(state, turnPlayer) {
    const players = [];
    for (const [key, raw] of Object.entries(asRecord(get(state, "playerStates")) ?? {})) {
      if (!isObject2(raw)) continue;
      const color = String(num(raw.color) ?? key);
      const id = playerId(num(raw.color) ?? key);
      const ratios = {};
      const ratioState = raw.bankTradeRatiosState;
      if (isObject2(ratioState)) {
        for (const [rid, value] of Object.entries(ratioState)) {
          const resource = RESOURCE_BY_ID[Number(rid)];
          const rate = num(value);
          if (resource && rate) ratios[resource] = rate;
        }
      }
      const cards = get(raw, "resourceCards", "cards");
      const dev2 = get(state, "mechanicDevelopmentCardsState", "players", color);
      const owned = Array.isArray(get(isObject2(dev2) ? dev2 : {}, "developmentCards", "cards")) ? get(isObject2(dev2) ? dev2 : {}, "developmentCards", "cards") : [];
      const used = Array.isArray(get(isObject2(dev2) ? dev2 : {}, "developmentCardsUsed")) ? get(isObject2(dev2) ? dev2 : {}, "developmentCardsUsed") : [];
      const devCards = owned.every((c) => DEV_CARD[num(c) ?? -1]) ? owned.map((c) => DEV_CARD[num(c) ?? -1]) : void 0;
      const knights = used.filter((c) => (DEV_CARD[num(c) ?? -1] ?? "") === "knight").length;
      const road2 = get(state, "mechanicLongestRoadState", color);
      const army = get(state, "mechanicLargestArmyState", color);
      const piece = (group, field) => num(get(state, group, color, field));
      players.push({
        id,
        vp: sumVp(raw.victoryPointsState) ?? sumVp(raw.victoryPoints) ?? 0,
        handSize: Array.isArray(cards) ? cards.length : 0,
        ratios,
        roadLength: num(isObject2(road2) ? road2.longestRoad : void 0) ?? 0,
        hasLongestRoad: isObject2(road2) && road2.hasLongestRoad === true,
        army: num(isObject2(army) ? army.armySize ?? army.largestArmy : void 0) ?? knights,
        hasLargestArmy: isObject2(army) && army.hasLargestArmy === true,
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
    const bank = {};
    if (isObject2(bankRaw)) {
      for (const [rid, value] of Object.entries(bankRaw)) {
        const resource = RESOURCE_BY_ID[Number(rid)];
        const count2 = num(value);
        if (resource && count2 !== void 0) bank[resource] = count2;
      }
    }
    const dice = get(state, "diceState");
    const current = get(state, "currentState");
    const robber = num(get(state, "mechanicRobberState", "locationTileIndex"));
    return {
      players,
      bank: Object.keys(bank).length ? bank : void 0,
      dice: isObject2(dice) ? { thrown: dice.diceThrown === true, d1: num(dice.dice1), d2: num(dice.dice2) } : void 0,
      turnPlayer,
      turnState: isObject2(current) ? num(current.turnState) : void 0,
      actionState: isObject2(current) ? num(current.actionState) : void 0,
      completedTurns: isObject2(current) ? num(current.completedTurns) : void 0,
      robberHex: robber === void 0 ? void 0 : String(robber)
    };
  }
  function buildBoard(state, robberStartIndex) {
    const tiles = asRecord(get(state, "mapState", "tileHexStates"));
    if (!tiles) return void 0;
    const hexes = [];
    for (const [id, raw] of Object.entries(tiles)) {
      if (!isObject2(raw)) continue;
      const x = num(raw.x);
      const y = num(raw.y);
      if (x === void 0 || y === void 0) continue;
      const resource = HEX_RESOURCE[num(raw.type) ?? 0] ?? null;
      hexes.push({ id, x, y, resource, number: resource ? num(raw.diceNumber) ?? null : null });
    }
    if (!hexes.length) return void 0;
    const desert = hexes.find((h2) => h2.resource === null);
    const ports = Object.values(asRecord(get(state, "mapState", "portEdgeStates")) ?? {}).flatMap((raw) => {
      if (!isObject2(raw)) return [];
      const kind = portKind(num(raw.type) ?? 0);
      const [x, y, z] = [num(raw.x), num(raw.y), num(raw.z)];
      return kind && x !== void 0 && y !== void 0 && z !== void 0 ? [{ at: `${x},${y},${z}`, kind }] : [];
    });
    return {
      hexes,
      ports: ports.length ? ports : void 0,
      robberStart: robberStartIndex !== void 0 ? String(robberStartIndex) : desert?.id
    };
  }

  // src/analyzer/adapters/typedEvents.ts
  var TYPED = { log: 7, playerState: 12, board: 14, edge: 15, corner: 16, robber: 17 };
  var NUMERIC_RESOURCE = { 0: null, 1: "lumber", 2: "brick", 3: "wool", 4: "grain", 5: "ore" };
  var NAMED_RESOURCE = [
    [/lumber|wood|forest/i, "lumber"],
    [/brick|hill/i, "brick"],
    [/wool|sheep|pasture/i, "wool"],
    [/grain|wheat|field/i, "grain"],
    [/\bore\b|mountain/i, "ore"]
  ];
  function resourceOf(v) {
    const n = num(v);
    if (n !== void 0 && typeof v !== "string") return NUMERIC_RESOURCE[n] ?? null;
    if (typeof v === "string") return NAMED_RESOURCE.find(([re]) => re.test(v))?.[1] ?? NUMERIC_RESOURCE[num(v) ?? -1] ?? null;
    return null;
  }
  function envelopes(value, depth = 0) {
    if (depth > 5) return [];
    if (Array.isArray(value)) return value.flatMap((v) => envelopes(v, depth + 1));
    if (!isObject2(value)) return [];
    const out = [];
    const type = num(value.type);
    if (type !== void 0 && Object.values(TYPED).includes(type)) {
      const inner = [value.payload, value.data, value.body, value.event].find(isObject2);
      out.push({ type, body: inner ?? value });
    }
    for (const key of ["data", "payload", "events", "messages"]) {
      const child = value[key];
      if (isObject2(child) || Array.isArray(child)) out.push(...envelopes(child, depth + 1));
    }
    return out;
  }
  function coords(raw) {
    const c = [raw.hexCorner, raw.hexEdge, raw.coordinates, raw.position, raw].find(isObject2);
    const nested = [c, raw].find((o) => o && num(o.x) !== void 0 && num(o.y) !== void 0 && num(o.z) !== void 0);
    return nested ? `${num(nested.x)},${num(nested.y)},${num(nested.z)}` : void 0;
  }
  var ownerOf = (raw) => {
    const o = [raw.owner, raw.playerColor, raw.color, raw.player].map(num).find((n) => n !== void 0);
    return o === void 0 ? void 0 : `c${o}`;
  };
  function list(body, keys) {
    for (const key of keys) {
      const v = body[key];
      if (Array.isArray(v)) return v.filter(isObject2);
      if (isObject2(v)) return Object.values(v).filter(isObject2);
    }
    return [];
  }
  function readBoard(body) {
    const tiles = list(body, ["tiles", "hexes", "hexStates", "tileHexStates", "faces", "map"]);
    const hexes = [];
    tiles.forEach((raw, i) => {
      const x = num(raw.x);
      const y = num(raw.y);
      if (x === void 0 || y === void 0) return;
      const resource = resourceOf(raw.type ?? raw.resource ?? raw.tileType);
      hexes.push({ id: String(num(raw.id) ?? i), x, y, resource, number: resource ? num(raw.diceNumber ?? raw.number ?? raw.rollNumber) ?? null : null });
    });
    if (!hexes.length) return void 0;
    return { hexes, robberStart: hexes.find((h2) => h2.resource === null)?.id };
  }
  var typedEventsAdapter = {
    name: "typed-events",
    parse(frames) {
      const players = /* @__PURE__ */ new Map();
      const events = [];
      const corners = /* @__PURE__ */ new Map();
      const edges = /* @__PURE__ */ new Set();
      const vp = /* @__PURE__ */ new Map();
      let board;
      let rolls = 0;
      let lastRobber;
      for (const f of frames) {
        if (f.frame.dir !== "in" || f.value === void 0) continue;
        for (const { type, body } of envelopes(f.value)) {
          const t = f.frame.t;
          if (type === TYPED.board) board = readBoard(body) ?? board;
          else if (type === TYPED.playerState) {
            for (const raw of [body, ...list(body, ["players", "playerStates"])]) {
              const id = ownerOf(raw);
              if (!id) continue;
              const name = [raw.username, raw.displayName, raw.name].find((n) => typeof n === "string" && n.length > 0);
              const prev = players.get(id);
              players.set(id, { id, color: num(String(id).slice(1)), name: name ?? prev?.name ?? `Player ${String(id).slice(1)}` });
              const points = num(raw.victoryPoints ?? raw.vp ?? raw.points);
              if (points !== void 0 && vp.get(id) !== points) {
                vp.set(id, points);
                events.push({ type: "vp", player: id, vp: points, t, turn: rolls });
              }
            }
          } else if (type === TYPED.corner) {
            for (const raw of [body, ...list(body, ["corners", "buildings"])]) {
              const at = coords(raw);
              const owner = ownerOf(raw);
              const kind = num(raw.buildingType ?? raw.type ?? raw.piece) ?? 1;
              if (!at || !owner || corners.get(at) === kind) continue;
              corners.set(at, kind);
              events.push({ type: "build", player: owner, piece: kind >= 2 ? "city" : "settlement", at, setup: rolls === 0, t, turn: rolls });
            }
          } else if (type === TYPED.edge) {
            for (const raw of [body, ...list(body, ["edges", "roads"])]) {
              const at = coords(raw);
              const owner = ownerOf(raw);
              if (!at || !owner || edges.has(at)) continue;
              edges.add(at);
              events.push({ type: "build", player: owner, piece: "road", at, setup: rolls === 0, t, turn: rolls });
            }
          } else if (type === TYPED.robber) {
            const where = num(body.tileIndex ?? body.locationTileIndex ?? body.hexId ?? body.id ?? body.index);
            if (where !== void 0 && String(where) !== lastRobber) {
              if (lastRobber !== void 0) events.push({ type: "robberMove", player: ownerOf(body) ?? "unknown", hex: String(where), t, turn: rolls });
              lastRobber = String(where);
            }
          }
        }
      }
      return { players: [...players.values()], events, board, warnings: [] };
    }
  };

  // src/analyzer/parse.ts
  function pickPrimary(stateDiff, typed) {
    const a = { ...stateDiff, name: stateDiffAdapter.name };
    const b = { ...typed, name: typedEventsAdapter.name };
    const score = (r) => r.events.length + (r.board ? 1e3 : 0);
    const [best, other] = score(b) > score(a) ? [b, a] : [a, b];
    return { ...best, board: best.board ?? other.board, players: best.players.length ? best.players : other.players, selfId: best.selfId ?? other.selfId, selfCards: best.selfCards ?? other.selfCards, handSizes: best.handSizes ?? other.handSizes, turnPlayer: best.turnPlayer ?? other.turnPlayer, snapshot: best.snapshot ?? other.snapshot };
  }

  // src/extension/helper.ts
  var MAX_FRAMES = 4e3;
  var REPARSE_MS = 1e3;
  var STALE_AFTER_MS = 3e3;
  var CARD_RESOURCE = RESOURCES;
  function isFullState(d) {
    const v = d.value;
    return v?.data?.type === 4 && Boolean(v.data.payload?.gameState);
  }
  function neededResources(v) {
    let best;
    for (const key of ["city", "settlement", "dev"]) {
      const missing = RESOURCES.filter((r) => (COSTS[key][r] ?? 0) > v.hand[r]);
      if (missing.length && missing.length <= 2 && (!best || missing.length < best.length)) best = missing;
    }
    return best ?? [];
  }
  function createHelper(friendlyBelow = 3) {
    let frames = [];
    let result;
    let dirty = false;
    let sawFull = false;
    let lastParse = 0;
    let seen = 0;
    let placements = placementsFrom([]);
    let behindSince = 0;
    let planMemo;
    let midMemo;
    function feed(frame) {
      if (frame.dir !== "in") return;
      let d;
      try {
        d = decodeFrames([frame]).decoded[0];
      } catch {
        return;
      }
      if (!d || d.value === void 0) return;
      seen++;
      if (isFullState(d)) {
        frames = [];
        sawFull = true;
      }
      frames.push({ ...d, frame: { ...frame, data: "" } });
      if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES);
      dirty = true;
    }
    function reparse(now) {
      if (!dirty || now - lastParse < REPARSE_MS) return;
      dirty = false;
      lastParse = now;
      try {
        result = pickPrimary(stateDiffAdapter.parse(frames), typedEventsAdapter.parse(frames));
        placements = placementsFrom(result.events);
      } catch {
        result = void 0;
      }
    }
    const norm = (n) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const sameName = (a, b) => {
      const x = norm(a);
      const y = norm(b);
      return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
    };
    function identify(ctx) {
      const players = result?.players ?? [];
      const notes = [];
      const logNames = ctx.logNames;
      if (result?.selfId && players.some((p) => p.id === result?.selfId)) {
        const self = players.find((p) => p.id === result?.selfId);
        const logName2 = logNames.find((n) => sameName(n, self.name)) ?? (logNames.includes("You") ? "You" : self.name);
        return { id: result.selfId, logName: logName2, notes, confident: true };
      }
      const fromName = ctx.meName ? logNames.find((n) => sameName(n, ctx.meName)) : void 0;
      const logName = fromName ?? (logNames.includes("You") ? "You" : void 0);
      if (!logName) {
        notes.push(ctx.meName ? `Your username "${ctx.meName}" is not one of the players in the log (${logNames.join(", ") || "none yet"}).` : "Your username is not set.");
        return { choose: logNames.length >= 2 ? logNames : void 0, notes };
      }
      const opponents = logNames.filter((n) => n !== logName);
      const byName = logName === "You" ? void 0 : players.find((p) => sameName(p.name, logName));
      if (byName) return { id: byName.id, logName, notes, confident: true };
      const notOpponent = players.filter((p) => !opponents.some((o) => sameName(p.name, o)));
      if (notOpponent.length === 1 && players.length >= 2) return { id: notOpponent[0].id, logName, notes, confident: false };
      const placedAt = ctx.firstPlacedAt(logName);
      if (placedAt !== void 0 && result) {
        const firstBuild = /* @__PURE__ */ new Map();
        for (const e of result.events) if (e.type === "build" && !firstBuild.has(e.player)) firstBuild.set(e.player, e.t);
        const ranked = [...firstBuild].map(([id, t]) => ({ id, d: Math.abs(t - placedAt) })).sort((a, b) => a.d - b.d);
        if (ranked[0] && ranked[0].d < 4e3 && (!ranked[1] || ranked[1].d - ranked[0].d > 1e3)) return { id: ranked[0].id, logName, notes, confident: false };
      }
      notes.push(`Could not match "${logName}" to a network player (network names: ${players.map((p) => p.name).join(", ") || "none"}).`);
      return { logName, notes };
    }
    function debugReport(who, ctx) {
      const board = result?.board;
      return JSON.stringify({
        messages: seen,
        kept: frames.length,
        sawFullState: sawFull,
        self: result?.selfId,
        identifiedAs: who.id,
        logName: who.logName,
        players: result?.players,
        logNames: ctx.logNames,
        rolls: ctx.rolls,
        view: ctx.mapView,
        hook: ctx.hook ?? "page hook silent",
        hexes: board?.hexes.map((h2) => `${h2.x},${h2.y}:${h2.resource ?? "desert"}${h2.number ?? ""}`),
        ports: board?.ports?.map((p) => `${p.at}:${p.kind}`),
        settlements: [...placements.settlements],
        cities: [...placements.cities],
        roads: [...placements.roads],
        loggedSettlements: who.logName ? ctx.loggedSettlements(who.logName) : void 0,
        selfCards: result?.selfCards
      });
    }
    function selfHand(now = Date.now()) {
      reparse(now);
      const cards = result?.selfCards;
      if (!cards) return void 0;
      const hand = emptyHand();
      for (const c of cards) {
        const r = CARD_RESOURCE[c - 1];
        if (r) hand[r]++;
        else return void 0;
      }
      const self = result?.players.find((p) => p.id === result?.selfId);
      return { name: self?.name, hand };
    }
    function handSizes(now = Date.now()) {
      reparse(now);
      const sizes = result?.handSizes ?? {};
      return (result?.players ?? []).flatMap((p) => sizes[p.id] === void 0 ? [] : [{ name: p.name, size: sizes[p.id] }]);
    }
    function view(views, ctx, now = Date.now()) {
      reparse(now);
      const mapView2 = ctx.mapView ?? DEFAULT_VIEW;
      const title = "Hints (opt-in, estimates)";
      const players = result?.players ?? [];
      const diag = `Network data: ${result?.board ? `${result.board.hexes.length} hexes read` : "no board"}, ${players.length} players (${players.map((p) => p.name).join(", ") || "none"}), ${seen} messages${result?.selfId ? ", you identified by the game" : ""}.`;
      const who = identify(ctx);
      const debug = debugReport(who, ctx);
      if (!result?.board) {
        let why;
        if (sawFull) why = "A game state arrived but no board was in it.";
        else if (seen === 0 && !ctx.hook) why = "The extension's page hook is not running in this tab, so no game traffic can be read. Reload the Colonist tab. If this stays, your Firefox may be older than 128, or the add-on was loaded without reloading the tab.";
        else if (seen === 0 && ctx.hook && ctx.hook.sockets === 0) why = "The page hook is running but Colonist has not opened a game connection yet. Join or start a game; if you are already in one, reload the tab.";
        else if (seen === 0) why = `Colonist opened ${ctx.hook?.sockets ?? 0} connection(s) but no messages reached the helper. Reload the Colonist tab once.`;
        else why = "The board is only sent when the game loads, and this tab missed it. Reload the Colonist tab once (the game rejoins and the board is sent again).";
        return { title, lines: ["No placement hints yet.", why, diag], choose: who.choose, debug };
      }
      if (!who.id) {
        return {
          title,
          lines: ["Not advising until you pick who you are.", ...who.notes, "Hints need to know which player you are.", diag],
          choose: who.choose ?? (ctx.logNames.length >= 2 ? ctx.logNames : void 0),
          debug
        };
      }
      const mine = [...placements.settlements.values(), ...placements.cities.values()].filter((o) => o === who.id).length;
      const logged = who.logName ? ctx.loggedSettlements(who.logName) : 0;
      if (logged > mine) behindSince ||= now;
      else behindSince = 0;
      if (behindSince && now - behindSince > STALE_AFTER_MS) {
        return {
          title,
          lines: [
            `The board data is behind the game: the log shows ${logged} settlement${logged === 1 ? "" : "s"} by you, the network data only ${mine}. Hints are paused so they cannot mislead you.`,
            "Reload the Colonist tab once; the game rejoins and sends the board again."
          ],
          debug
        };
      }
      const robberNow = () => {
        const moves = result?.events.filter((e) => e.type === "robberMove") ?? [];
        return moves.at(-1)?.hex ?? result?.board?.robberStart;
      };
      const board = result.board;
      const nameOf = (id) => players.find((p) => p.id === id)?.name ?? id;
      const opponent = players.find((p) => p.id !== who.id);
      const oppView = opponent ? views.find((v) => sameName(v.name, opponent.name)) : void 0;
      const oppBuilt = placements.settlements.size + placements.cities.size - mine;
      const lines = [`Advising: ${nameOf(who.id)}.${who.confident ? "" : " This match is a guess; set your username in the popup if it is not you."}`];
      const sections = [];
      let coach;
      const marks = [];
      let svg;
      let picks = [];
      const opening = ctx.rolls === 0 && (mine < 2 || oppBuilt < 2);
      if (opening) {
        const myTurn = result.turnPlayer ? result.turnPlayer === who.id : void 0;
        const key = JSON.stringify([[...placements.settlements], [...placements.cities], who.id, myTurn]);
        if (planMemo?.key !== key) planMemo = { key, plan: coachedOpening(board, placements, who.id, 3, myTurn) };
        const plan = planMemo.plan;
        const boardCtx = contextFor(board);
        const ports = portAccess(boardCtx, roadDistance(boardCtx, placements, (o) => o === who.id), profileOf(boardCtx, placements, (o) => o === who.id));
        picks = plan.picks;
        lines.push(plan.note);
        const follow = picks[0]?.followUp;
        const placing = picks[0]?.at;
        const secondSpot = plan.mode === "pair" && mine === 0 ? follow?.at : void 0;
        const closeSecond = follow && placing && mine === 0 && plan.mode !== "pair" ? roadToward(board, placements, who.id, follow.at, placing) : void 0;
        const road2 = placing ? adviseRoad(board, placements, who.id, {
          from: placing,
          onlyFrom: true,
          toward: closeSecond && closeSecond.dist <= 2 ? follow.at : void 0,
          maxDist: 2,
          myRoadLength: result.snapshot?.players.find((p) => p.id === who.id)?.roadLength,
          oppRoadLength: result.snapshot?.players.find((p) => p.id !== who.id)?.roadLength,
          iHold: result.snapshot?.players.find((p) => p.id === who.id)?.hasLongestRoad
        }) : void 0;
        const secondRoad = secondSpot ? adviseRoad(board, placements, who.id, { from: secondSpot, onlyFrom: true, maxDist: 2 }) : void 0;
        const rolls = result.events.flatMap((e) => e.type === "roll" ? [{ total: e.total, d1: e.d1, d2: e.d2, player: e.player }] : []);
        const aligned = bagAligned(result.snapshot?.completedTurns, rolls.length);
        const edgePick = placing ? bestEdge(board, placements, who.id, { from: placing, onlyFrom: true, maxDist: 2, rolls, aligned }) : void 0;
        let setupRoad = road2;
        if (!setupRoad && edgePick) setupRoad = { edge: edgePick.edge, toward: edgePick.toward, reason: `Point this road toward your second spot. ${edgePick.reason}` };
        if (!setupRoad && placing) {
          const open = listOpenEdges(board, placements, who.id, placing, true)[0];
          if (open) setupRoad = { edge: open.edge, toward: open.to, reason: "This road leaves the settlement you are placing." };
        }
        const myView = views.find((v) => v.name === who.logName);
        const handKnown = Boolean(myView && (myView.exact || myView.unknown === 0 && myView.total > 0));
        const hand = handKnown ? myView?.hand : void 0;
        const projected = { settlements: new Map(placements.settlements), cities: new Map(placements.cities), roads: new Map(placements.roads) };
        if (placing && !projected.settlements.has(placing) && !projected.cities.has(placing)) projected.settlements.set(placing, who.id);
        const oppId = opponent?.id ?? "opp";
        for (const w of plan.oppWants.slice(0, 2)) {
          if (w.at !== placing && !projected.settlements.has(w.at) && !projected.cities.has(w.at)) projected.settlements.set(w.at, oppId);
        }
        const meSnap = result.snapshot?.players.find((p) => p.id === who.id);
        const oppSnap = result.snapshot?.players.find((p) => p.id !== who.id);
        const pct = positionWin(board, projected, who.id, { hand, myVp: meSnap?.vp || Math.max(2, mine + (placing ? 1 : 0)), hisVp: oppSnap?.vp || 2, rollCount: rolls.length });
        const next = nextRollText(rolls, aligned);
        const held = hand ? RESOURCES.reduce((s, r) => s + hand[r], 0) : meSnap?.handSize ?? 0;
        const limit = meSnap?.discardLimit ?? 9;
        const seven = held > limit ? `You hold ${held} cards. Drop ${Math.floor(held / 2)} if a 7 comes before you can spend them. ${sevensText(rolls, aligned, who.id)}` : `${sevensText(rolls, aligned, who.id)}${held >= limit - 2 && held > 0 ? ` You hold ${held}, close to the discard of ${limit}.` : ""}`;
        coach = coachFromOpening(plan, ports[0] && ports[0].value >= 0.5 ? ports[0].text : void 0, { first: setupRoad?.reason, second: secondRoad?.reason });
        coach = {
          ...coach,
          race: `About ${pct}% from here. ${next}`,
          tips: [
            { title: "Win", why: `About ${pct}% from here. This model's share under one shared build policy. Not a promise.` },
            { title: "Next roll", why: next },
            { title: "A 7", why: seven },
            ...coach.tips
          ]
        };
        lines.push(...picks.length ? picks.map((c, i) => `${i + 1}. ${c.reason}`) : plan.mode === "waiting" ? [] : ["No legal spot found."]);
        if (follow) {
          lines.push(plan.mode === "pair" && mine === 0 ? `Second settlement: ${follow.reason}` : `+ Then: ${follow.reason}`);
          marks.push({ at: follow.at, label: "+", kind: "follow" });
        }
        if (plan.oppWants.length) {
          sections.push({ title: "He is likely to want", lines: plan.oppWants.map((w, i) => `H${i + 1}. ${w.reason}`) });
          plan.oppWants.slice(0, 2).forEach((w, i) => marks.push({ at: w.at, label: `H${i + 1}`, kind: "his" }));
        }
        if (mine >= 1) {
          const weak = planMidgame(board, placements, who.id).weaknesses;
          if (weak.length) sections.push({ title: "Weak points", lines: weak });
        }
        lines.push("W wood, B brick, S sheep, G wheat, O ore.");
        if (setupRoad) {
          sections.unshift({ title: plan.mode === "pair" && secondRoad ? "First road" : "Next road", lines: [setupRoad.reason] });
          marks.push({ at: setupRoad.edge, label: secondRoad ? "1" : "R", kind: "road" });
        }
        if (secondRoad) {
          sections.splice(setupRoad ? 1 : 0, 0, { title: "Second road", lines: [secondRoad.reason] });
          marks.push({ at: secondRoad.edge, label: "2", kind: "road" });
        }
        if (edgePick?.follow && setupRoad && setupRoad.edge === edgePick.edge && edgePick.follow !== setupRoad.edge && !secondRoad) {
          marks.push({ at: edgePick.follow, label: "", kind: "road", later: true });
        }
      } else {
        const myView = views.find((v) => v.name === who.logName);
        if (myView) lines.push(...buildHints(myView));
        const plan = planMidgame(board, placements, who.id);
        const needs = oppView ? neededResources(oppView) : [];
        const handKnown = Boolean(myView && (myView.exact || myView.unknown === 0 && myView.total > 0));
        const oppCounted = oppView && oppView.total > 0 ? { hand: oppView.hand, unknown: oppView.unknown } : void 0;
        const finger = result.snapshot?.players.map((p) => [p.id, p.vp, p.roadLength, p.hasLongestRoad, p.knights, p.army, p.devCards?.join(","), p.handSize, p.devsInHand, p.ratios.lumber, p.ratios.brick, p.ratios.wool, p.ratios.grain, p.ratios.ore].join(":")).join("|");
        const rolls = result.events.flatMap((e) => e.type === "roll" ? [e.total] : []);
        const midKey = JSON.stringify([[...placements.settlements], [...placements.cities], [...placements.roads], who.id, handKnown ? myView?.hand : void 0, result.snapshot?.robberHex, result.snapshot?.dice?.thrown, result.snapshot?.completedTurns, rolls, finger, needs, oppCounted]);
        if (midMemo?.key !== midKey) {
          midMemo = {
            key: midKey,
            plan: planTurn({
              board,
              placements,
              me: who.id,
              hand: handKnown ? myView?.hand : void 0,
              handKnown,
              snapshot: result.snapshot,
              events: result.events,
              oppNeeds: needs,
              oppHand: oppCounted?.hand,
              oppUnknown: oppCounted?.unknown
            })
          };
        }
        const turn = midMemo.plan;
        coach = {
          phase: "midgame",
          headline: turn.headline,
          why: turn.why,
          race: turn.race,
          tips: turn.tips,
          next: turn.settle ? [turn.settle.reason] : [],
          at: turn.settle?.mark ? turn.settle.at : void 0
        };
        const grow = [];
        if (/city/i.test(turn.headline) && plan.upgrade) grow.push(plan.upgrade);
        const aimed = turn.settle?.mark ? turn.settle.at : void 0;
        if (turn.settle) grow.push(`${turn.settle.mark ? "This turn: " : "Next settlement: "}${turn.settle.reason}`);
        if (turn.alt && turn.alt.at !== aimed) grow.push(`Also: ${turn.alt.reason}`);
        if (aimed) picks = [{ at: aimed, score: 0, pips: 0, resources: [], numbers: [], reason: turn.settle?.reason ?? "Settle here." }];
        if (plan.upgrade && !grow.includes(plan.upgrade) && !/city/i.test(turn.headline)) grow.push(plan.upgrade);
        if (grow.length) sections.push({ title: "Where to settle", lines: grow });
        const block = [];
        if (oppView) {
          const can = ["city", "settlement", "dev"].filter((k) => oppView.afford[k] === "yes");
          if (can.length) block.push(`${oppView.name} can pay for a ${can.join(" or ")} right now.`);
        }
        block.push(...plan.oppWants.map((w, i) => `H${i + 1}. ${w.reason}`));
        plan.oppWants.forEach((w, i) => marks.push({ at: w.at, label: `H${i + 1}`, kind: "his" }));
        if (block.length) sections.push({ title: "What he is heading for", lines: block });
        const robber = robberTargets(board, placements, who.id, robberNow(), friendlyBelow, 2, needs);
        if (robber.length) {
          sections.push({
            title: "If you move the robber",
            lines: [
              "Friendly robber applies.",
              ...robber.map((r) => `${r.number}${r.resource ? ` ${r.resource}` : ""} hits ${r.targets.map(nameOf).join("/")}${r.note ? ` (${r.note})` : ""}`)
            ]
          });
        }
        if (plan.weaknesses.length) sections.push({ title: "Weak points", lines: plan.weaknesses });
        if (turn.road) {
          const pair2 = Boolean(turn.road2);
          sections.unshift({ title: pair2 ? "First road" : "Next road", lines: [turn.road.reason] });
          marks.push({ at: turn.road.edge, label: pair2 ? "1" : "R", kind: "road" });
        }
        if (turn.road2) {
          sections.splice(1, 0, { title: "Second road", lines: [turn.road2.reason] });
          marks.push({ at: turn.road2.edge, label: "2", kind: "road" });
        }
        if (turn.roadLater && !turn.road2) marks.push({ at: turn.roadLater.edge, label: "", kind: "road", later: true });
        if (!lines.length && !sections.length) lines.push("Nothing to suggest right now.");
      }
      svg = miniMapSvg(board, placements, picks, who.id, mapView2, robberNow(), marks);
      const advice = coach ? { phase: coach.phase, text: coach.headline, at: coach.at } : void 0;
      return { title, lines, sections, coach, advice, mapSvg: svg, mapLegend: true, mapPicks: picks.length > 0, mapMarks: marks.some((m) => m.kind !== "road"), mapRoads: marks.some((m) => m.kind === "road" && !m.later), mapRoadLater: marks.some((m) => m.kind === "road" && m.later), debug };
    }
    return {
      feed,
      view,
      selfHand,
      handSizes,
      reset() {
        frames = [];
        sawFull = false;
        result = void 0;
        dirty = false;
        seen = 0;
        behindSince = 0;
        planMemo = void 0;
        midMemo = void 0;
        placements = placementsFrom([]);
      }
    };
  }

  // src/extension/overlay.ts
  var LABEL5 = { lumber: "Lumber", brick: "Brick", wool: "Wool", grain: "Grain", ore: "Ore" };
  var COLOR = { lumber: "#2f7d32", brick: "#b5532f", wool: "#8bc34a", grain: "#e0b400", ore: "#78909c" };
  var AFFORD_LABEL = { road: "Road", settlement: "Settle", city: "City", dev: "Dev" };
  var CSS = `
:host { all: initial; }
.panel { position: fixed; top: 84px; right: 10px; width: 268px; z-index: 2147483647; font: 12px/1.35 system-ui, sans-serif; color: #e9edf1;
  background: rgba(24, 28, 34, 0.94); border: 1px solid #3a424d; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.45); user-select: none; }
.head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; cursor: move; border-bottom: 1px solid #2d343d; }
.head b { flex: 1; font-size: 12px; letter-spacing: .02em; }
.iconbtn { all: unset; cursor: pointer; padding: 0 5px; border-radius: 4px; color: #aab4bf; }
.iconbtn:hover { background: #2d343d; color: #fff; }
.body { padding: 6px 9px 8px; max-height: 70vh; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.player { padding: 6px 0; border-bottom: 1px solid #2d343d; }
.player:last-child { border-bottom: 0; }
.name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.name .total { margin-left: auto; font-variant-numeric: tabular-nums; }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #2d343d; color: #aab4bf; font-weight: 500; }
.badge.ok { background: #1e4d2b; color: #9be3ae; }
.badge.bad { background: #5a2323; color: #ffb4b4; }
.badge.warn { background: #5a4a14; color: #ffe08a; }
.res { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 6px 0 4px; }
.cell { text-align: center; border-radius: 6px; padding: 3px 0 2px; background: #20262d; position: relative; }
.cell .dot { display: block; height: 3px; border-radius: 2px; margin: 0 6px 2px; }
.cell .n { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cell .l { font-size: 9px; color: #8b97a4; }
.cell .pm { display: none; position: absolute; inset: 0; }
.cell:hover .pm { display: flex; }
.pm button { all: unset; flex: 1; text-align: center; cursor: pointer; background: rgba(0,0,0,.55); color: #fff; font-weight: 700; font-size: 14px; }
.pm button:first-child { border-radius: 6px 0 0 6px; } .pm button:last-child { border-radius: 0 6px 6px 0; }
.pm button:hover { background: rgba(255,255,255,.25); }
.chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #2d343d; color: #8b97a4; }
.chip.yes { background: #1e4d2b; color: #9be3ae; } .chip.maybe { background: #5a4a14; color: #ffe08a; }
.sub { color: #8b97a4; font-size: 11px; margin-top: 3px; }
.warn { color: #ffd37a; font-size: 11px; margin-top: 3px; }
.foot { display: flex; gap: 6px; align-items: center; padding: 6px 9px; border-top: 1px solid #2d343d; color: #8b97a4; font-size: 11px; }
.foot button { all: unset; cursor: pointer; padding: 1px 6px; border-radius: 4px; background: #2d343d; color: #dbe2e8; }
.foot button:hover { background: #3a424d; }
.notice { padding: 6px 9px; background: #3a2f12; color: #ffe08a; font-size: 11px; }
.helper { margin-top: 6px; padding-top: 6px; border-top: 1px solid #2d343d; }
.helper h4 { margin: 0 0 4px; font-size: 11px; color: #aab4bf; font-weight: 600; }
.coach { margin: 0 0 6px; padding: 6px 7px; border-radius: 8px; background: #17202a; border: 1px solid #314255; }
.coach .headline { font-weight: 700; color: #fff; font-size: 12px; }
.coach .why, .coach .tip span { color: #c5d0da; font-size: 11px; }
.coach .race { color: #9be3ae; font-size: 10px; margin-top: 3px; }
.coach .tip { margin-top: 5px; }
.coach .tip b { display: block; color: #ffd37a; font-size: 10px; letter-spacing: .03em; text-transform: uppercase; }
.helper ul { margin: 6px 0 0; padding: 0 0 0 16px; }
.helper h5 { margin: 8px 0 2px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #ffd37a; font-weight: 700; }
.helper li { margin: 0 0 4px; padding: 0; font-size: 11px; line-height: 1.35; }
.helper svg { display: block; width: 100%; height: auto; margin: 2px 0; border-radius: 6px; background: #12161b; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 0; font-size: 10px; color: #8b97a4; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
.legend button, .debugbtn { all: unset; cursor: pointer; padding: 1px 7px; border-radius: 8px; background: #2d343d; color: #dbe2e8; font-size: 10px; }
.legend button:hover, .debugbtn:hover { background: #3a424d; }
.pick { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 8px; background: #3a424d; color: #fff; font-size: 11px; }
.pick:hover { background: #55606e; }
.collapsed .body, .collapsed .foot, .collapsed .notice { display: none; }
`;
  function h(doc, tag, attrs = {}, ...kids) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === void 0 || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = String(v);
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids) if (kid !== void 0) el.append(kid);
    return el;
  }
  async function copyText(doc, text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = doc.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      doc.body.append(area);
      area.select();
      const ok = doc.execCommand("copy");
      area.remove();
      return ok;
    }
  }
  function playerBlock(doc, v, state, actions) {
    const isMe = v.name === state.me || v.exact === true;
    let badge;
    if (v.synced === void 0) badge = h(doc, "span", { class: "badge", title: "Colonist's own card counter could not be read" }, "unverified");
    else if (v.synced) badge = h(doc, "span", { class: "badge ok", title: v.exact ? "Read from the game state and matches Colonist's own card counter" : "Matches Colonist's own card counter" }, v.exact ? "exact" : "in sync");
    else if (!state.settled) badge = h(doc, "span", { class: "badge", title: "Waiting for the counter to catch up" }, "checking");
    else badge = h(doc, "span", { class: "badge bad", title: `Colonist shows ${v.panelCards}, the log adds up to ${v.total}` }, `off by ${v.delta > 0 ? "+" : ""}${v.delta}`);
    const cells = RESOURCES.map(
      (r) => h(
        doc,
        "div",
        { class: "cell" },
        h(doc, "span", { class: "dot", style: `background:${COLOR[r]}` }),
        h(doc, "span", { class: "n" }, String(v.hand[r])),
        h(doc, "span", { class: "l" }, LABEL5[r]),
        h(
          doc,
          "div",
          { class: "pm" },
          h(doc, "button", { title: `Remove one ${LABEL5[r]}`, onclick: () => actions.adjust(v.name, r, -1) }, "-"),
          h(doc, "button", { title: `Add one ${LABEL5[r]}`, onclick: () => actions.adjust(v.name, r, 1) }, "+")
        )
      )
    );
    const block = h(doc, "div", { class: "player" });
    block.append(
      h(doc, "div", { class: "name" }, isMe ? `${v.name} (you)` : v.name, badge, h(doc, "span", { class: "total", title: "Cards in hand" }, `${v.total}${v.unknown ? ` (${v.unknown}?)` : ""}`)),
      h(doc, "div", { class: "res" }, ...cells)
    );
    if (!isMe) {
      const chips = Object.keys(AFFORD_LABEL).map(
        (k) => h(doc, "span", { class: `chip ${v.afford[k] === "no" ? "" : v.afford[k]}`, title: v.afford[k] === "maybe" ? "Possible if the unknown card is right" : "" }, `${AFFORD_LABEL[k]}${v.afford[k] === "yes" ? " ok" : v.afford[k] === "maybe" ? " ?" : ""}`)
      );
      block.append(h(doc, "div", { class: "chips", title: "What they can pay for right now" }, ...chips));
      const odds = RESOURCES.filter((r) => v.hand[r] > 0).map((r) => `${LABEL5[r]} ${Math.round(v.stealOdds[r] * 100)}%`).join(" \xB7 ");
      if (odds) block.append(h(doc, "div", { class: "sub" }, `Steal odds: ${odds}`));
    }
    if (v.discardOnSeven > 0) block.append(h(doc, "div", { class: "sub" }, `Discards ${v.discardOnSeven} on a 7`));
    block.append(h(doc, "div", { class: "sub" }, `Dev cards: ${v.devBought} bought, ${v.devPlayed} played${v.knights ? ` (${v.knights} knights)` : ""}${v.devUnplayed ? ` \xB7 ${v.devUnplayed} in hand (may be VP)` : ""}`));
    for (const w of v.warnings.slice(-2)) block.append(h(doc, "div", { class: "warn" }, w));
    return block;
  }
  function createOverlay(doc, actions) {
    const host = doc.createElement("div");
    host.id = "colonist-recorder-overlay";
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    const panel = h(doc, "div", { class: "panel" });
    root.append(style, panel);
    let collapsed = false;
    let lastKey = "";
    let state;
    let busyUntil = 0;
    let deferred;
    let scrollTop = 0;
    let pressed = false;
    const draw = () => {
      if (!state) return;
      const s = state;
      const oldBody = panel.querySelector(".body");
      if (oldBody) scrollTop = oldBody.scrollTop;
      panel.className = `panel${collapsed ? " collapsed" : ""}`;
      const head = h(
        doc,
        "div",
        { class: "head" },
        h(doc, "b", {}, "Card counter"),
        h(doc, "button", { class: "iconbtn", title: collapsed ? "Expand" : "Collapse", onclick: () => {
          collapsed = !collapsed;
          lastKey = "";
          draw();
        } }, collapsed ? "+" : "-"),
        h(doc, "button", { class: "iconbtn", title: "Hide for this game", onclick: () => actions.hide() }, "x")
      );
      enableDrag(head, panel);
      const body = h(doc, "div", { class: "body" }, ...s.views.map((v) => playerBlock(doc, v, s, actions)));
      if (!s.views.length) body.append(h(doc, "div", { class: "sub" }, "Waiting for the game log. Play on; counts appear with the first rows."));
      if (s.helper) {
        const helper2 = h(doc, "div", { class: "helper" }, h(doc, "h4", {}, s.helper.title));
        const coach = s.helper.coach;
        if (coach) {
          helper2.append(
            h(
              doc,
              "div",
              { class: "coach" },
              h(doc, "div", { class: "headline" }, coach.headline),
              h(doc, "div", { class: "why" }, coach.why),
              coach.race ? h(doc, "div", { class: "race" }, coach.race) : void 0,
              ...coach.tips.map((t) => h(doc, "div", { class: "tip" }, h(doc, "b", {}, t.title), h(doc, "span", {}, t.why)))
            )
          );
        }
        if (s.helper.mapSvg) {
          const parsed = new DOMParser().parseFromString(s.helper.mapSvg, "image/svg+xml").documentElement;
          if (parsed.localName === "svg") helper2.append(doc.importNode(parsed, true));
          if (s.helper.mapLegend) {
            helper2.append(
              h(
                doc,
                "div",
                { class: "legend" },
                h(doc, "span", {}, h(doc, "i", { style: "background:#2563eb" }), "you"),
                h(doc, "span", {}, h(doc, "i", { style: "background:#e11d48" }), "opponent"),
                ...s.helper.mapPicks ? [h(doc, "span", {}, h(doc, "i", { style: "background:#ffd54a" }), "suggested")] : [],
                ...s.helper.mapMarks ? [h(doc, "span", {}, h(doc, "i", { style: "background:transparent;border:1.5px dashed #e11d48" }), "he wants")] : [],
                ...s.helper.mapRoads ? [h(doc, "span", {}, h(doc, "i", { style: "background:#ffd54a" }), "place this road")] : [],
                ...s.helper.mapRoadLater ? [h(doc, "span", {}, h(doc, "i", { style: "background:transparent;border:1.5px dashed #ffd54a" }), "then this road")] : [],
                h(doc, "span", {}, h(doc, "i", { style: "background:#10151a;border:1px solid #8b97a4" }), "robber"),
                h(doc, "button", { title: "Turn the map by 60 degrees until it looks like Colonist's board", onclick: () => actions.turnMap?.(2) }, "rotate"),
                h(doc, "button", { title: "Turn the map by 30 degrees", onclick: () => actions.turnMap?.(1) }, "30\xB0"),
                h(doc, "button", { title: "Mirror left to right", onclick: () => actions.flipMap?.() }, "flip \u2194"),
                h(doc, "button", { title: "Mirror top to bottom", onclick: () => actions.flipMap?.(true) }, "flip \u2195")
              )
            );
          }
        }
        helper2.append(h(doc, "ul", {}, ...s.helper.lines.map((l) => h(doc, "li", {}, l))));
        for (const section of s.helper.sections ?? []) {
          helper2.append(h(doc, "h5", {}, section.title), h(doc, "ul", {}, ...section.lines.map((l) => h(doc, "li", {}, l))));
        }
        if (s.helper.choose?.length) {
          helper2.append(
            h(doc, "div", { class: "chips" }, h(doc, "span", { class: "sub" }, "I am:"), ...s.helper.choose.map((n) => h(doc, "button", { class: "pick", onclick: () => actions.pickMe?.(n) }, n)))
          );
        }
        const debug = s.helper.debug;
        if (debug) {
          const btn = h(doc, "button", { class: "debugbtn", title: "Copy what the helper read, to report a problem" }, "copy debug info");
          btn.addEventListener("click", () => {
            void copyText(doc, debug).then((ok) => {
              btn.textContent = ok ? "copied" : "copy failed";
            });
          });
          helper2.append(h(doc, "div", { class: "legend" }, btn));
        }
        body.append(helper2);
      }
      const foot = h(
        doc,
        "div",
        { class: "foot" },
        h(doc, "span", {}, `${s.log.rows} rows${s.log.missing ? ` \xB7 ${s.log.missing} missing` : ""}`),
        h(doc, "button", { title: "Scroll the game log once to re-read every row", onclick: () => actions.sweep() }, s.log.sweeping ? "reading..." : "rebuild"),
        s.adjustments ? h(doc, "button", { title: "Undo manual +/- corrections", onclick: () => actions.clearAdjustments() }, "undo edits") : void 0
      );
      panel.replaceChildren(head, ...s.notice ? [h(doc, "div", { class: "notice" }, s.notice)] : [], body, foot);
      body.scrollTop = scrollTop;
      body.addEventListener("scroll", () => {
        scrollTop = body.scrollTop;
      }, { passive: true });
    };
    const touch = (ms) => {
      busyUntil = Math.max(busyUntil, Date.now() + ms);
    };
    panel.addEventListener("wheel", () => touch(700), { passive: true });
    panel.addEventListener("touchmove", () => touch(700), { passive: true });
    panel.addEventListener("scroll", () => touch(700), { capture: true, passive: true });
    panel.addEventListener("pointerdown", () => {
      pressed = true;
    });
    const release = () => {
      if (!pressed) return;
      pressed = false;
      touch(150);
    };
    doc.addEventListener("pointerup", release);
    doc.addEventListener("pointercancel", release);
    const flush2 = () => {
      deferred = void 0;
      if (pressed || Date.now() < busyUntil) {
        deferred = setTimeout(flush2, 200);
        return;
      }
      lastKey = "";
      const next = state;
      if (next) api2.render(next);
    };
    const enableDrag = (handle, target) => {
      handle.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("button")) return;
        const rect = target.getBoundingClientRect();
        const dx = ev.clientX - rect.left;
        const dy = ev.clientY - rect.top;
        const move = (e) => {
          target.style.left = `${Math.max(0, e.clientX - dx)}px`;
          target.style.top = `${Math.max(0, e.clientY - dy)}px`;
          target.style.right = "auto";
        };
        const up = () => {
          doc.removeEventListener("pointermove", move);
          doc.removeEventListener("pointerup", up);
        };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
      });
    };
    const api2 = {
      host,
      render(next) {
        state = next;
        const key = JSON.stringify([next.views, next.log, next.settled, next.adjustments, next.notice, next.helper, collapsed]);
        if (key === lastKey) return;
        if (pressed || Date.now() < busyUntil) {
          deferred ??= setTimeout(flush2, 200);
          return;
        }
        lastKey = key;
        draw();
      },
      setVisible(visible) {
        host.style.display = visible ? "" : "none";
      },
      destroy() {
        if (deferred) clearTimeout(deferred);
        host.remove();
      }
    };
    return api2;
  }

  // src/extension/bridge.ts
  var BRIDGE_TAG = "__colonistRecorder";
  var FORCE_KEY = "forceRecord";
  var ME_KEY = "me";
  var OVERLAY_KEY = "overlay";
  var WS_KEY = "recordWs";
  var HELPER_KEY = "helper";
  var MAPVIEW_KEY = "mapView";
  function gameIdFromLocation(loc) {
    const params = new URLSearchParams(loc.search);
    const fromQuery = params.get("gameId") ?? params.get("game");
    if (fromQuery) return fromQuery;
    const hash = loc.hash.replace(/^#/, "").replace(/^\/?/, "");
    if (/^[A-Za-z0-9_-]{3,}$/.test(hash)) return hash;
    return "";
  }

  // src/extension/content.ts
  var FLUSH_INTERVAL_MS = 1e3;
  var PREROLL_MS = 15e3;
  var PREROLL_MAX = 400;
  var NON_GAME_HASHES = /* @__PURE__ */ new Set(["lobby", "home", "play", "settings", "profile", "store", "leaderboard"]);
  var sessionStart = Date.now();
  var forceRecord = false;
  var me = "";
  var overlayEnabled = true;
  var recordWs = true;
  var helperEnabled = false;
  var mapView = DEFAULT_VIEW;
  var overlayHidden = false;
  var currentId = "";
  var currentGameId = "";
  var sockets = [];
  var knownSockets = [];
  var hook;
  var ringFrames = [];
  var ringLog = [];
  var pendingFrames = [];
  var pendingLog = [];
  var pendingMeta = {};
  var segmentIdx = /* @__PURE__ */ new Set();
  function detectGameId() {
    const id = gameIdFromLocation(window.location);
    return NON_GAME_HASHES.has(id.toLowerCase()) ? "" : id;
  }
  function trimRing() {
    const cutoff = Date.now() - PREROLL_MS;
    ringFrames = ringFrames.filter((f) => f.t >= cutoff).slice(-PREROLL_MAX);
    ringLog = ringLog.filter((l) => l.t >= cutoff).slice(-PREROLL_MAX);
  }
  function startSegment(id, gameId) {
    flush();
    currentId = id;
    currentGameId = gameId;
    endHandled = "";
    finalShotTaken = false;
    boardShots = 0;
    lastBoardShot = Date.now();
    lastPanelKey = "";
    overlayHidden = false;
    hints = [];
    hintsDirty = false;
    capture.reset();
    engine.reset();
    endScreen.reset();
    sockets = [...knownSockets];
    pendingFrames = ringFrames.splice(0);
    pendingLog = ringLog.splice(0);
    segmentIdx = new Set(pendingLog.flatMap((l) => l.idx === void 0 ? [] : [l.idx]));
    for (const l of pendingLog) engine.addEntry(l);
    void loadAdjustments(id);
  }
  function syncSegment() {
    const gameId = detectGameId();
    if (gameId) {
      if (gameId !== currentGameId) startSegment(gameId, gameId);
    } else if (forceRecord && !currentId) {
      startSegment(`session-${sessionStart}`, "");
    }
  }
  function onFrame(frame) {
    if (helperEnabled || recordWs) helper.feed(frame);
    if (!recordWs) return;
    syncSegment();
    if (currentId) pendingFrames.push(frame);
    else {
      ringFrames.push(frame);
      trimRing();
    }
  }
  function onLog(entry) {
    syncSegment();
    if (entry.idx !== void 0 && currentId) {
      if (segmentIdx.has(entry.idx)) return;
      segmentIdx.add(entry.idx);
    }
    if (END_RE.test(entry.text)) onGameEnd();
    if (currentId) {
      pendingLog.push(entry);
      engine.addEntry(entry);
    } else {
      ringLog.push(entry);
      trimRing();
    }
  }
  function flush() {
    if (!currentId || !pendingFrames.length && !pendingLog.length && !sockets.length && !Object.keys(pendingMeta).length && !hintsDirty) return;
    const message = {
      kind: "flush",
      id: currentId,
      gameId: currentGameId,
      url: window.location.href,
      sockets,
      frames: pendingFrames,
      log: pendingLog,
      meta: { me: me || void 0, userAgent: navigator.userAgent, ...pendingMeta, ...hintsDirty ? { hints: hints.slice() } : {} }
    };
    hintsDirty = false;
    pendingFrames = [];
    pendingLog = [];
    pendingMeta = {};
    sockets = [];
    try {
      void api.runtime.sendMessage(message).catch(() => void 0);
    } catch {
    }
  }
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    const data = ev.data;
    if (!data || data[BRIDGE_TAG] !== true) return;
    if (data.type === "frame") onFrame(data.frame);
    else if (data.type === "hello") hook = { at: Date.now(), sockets: data.sockets, frames: data.frames };
    else if (data.type === "socket") {
      knownSockets.push(data.socket);
      sockets.push(data.socket);
    }
  });
  var END_RE = /\bwon the game\b/i;
  var endHandled = "";
  var lastPanelKey = "";
  var capture = createLogCapture(document, (entry) => onLog(entry));
  function onGameEnd() {
    const id = currentId;
    if (!id || endHandled === id) return;
    endHandled = id;
    setTimeout(() => {
      void capture.sweep("game end").then(() => {
        if (id === currentId) pendingMeta = { ...pendingMeta, logGaps: capture.status().missing };
      });
    }, 1200);
  }
  function snapshotPanel() {
    const snap = scrapePanel(document, capture.status().maxIdx);
    if (!snap) return void 0;
    const key = JSON.stringify(snap.players.map((p) => [p.color, p.cards, p.stats.map((s) => s.value)]));
    if (key !== lastPanelKey) {
      lastPanelKey = key;
      onLog({ t: Date.now(), text: "", panel: snap });
    }
    return snap;
  }
  var engine = new LiveEngine();
  var helper = createHelper();
  var BOARD_SHOT_EVERY_MS = 4 * 6e4;
  var MAX_BOARD_SHOTS = 6;
  var finalShotTaken = false;
  var boardShots = 0;
  var lastBoardShot = Date.now();
  var promptUntil = 0;
  var promptNote = "";
  function requestShot(label) {
    if (!currentId) return;
    const message = { kind: "shot", id: currentId, gameId: currentGameId, url: window.location.href, label, t: Date.now() };
    try {
      void api.runtime.sendMessage(message).catch(() => void 0);
    } catch {
    }
  }
  var endScreen = createEndScreen(document, {
    names: () => engine.views().map((v) => v.name),
    onCapture(end, tab, isNew) {
      if (!currentId) return;
      pendingMeta = { ...pendingMeta, endScreen: JSON.parse(JSON.stringify(end)), endScreenText: Object.values(end.tabs).map((t) => t.text).join("\n") };
      if (isNew) setTimeout(() => requestShot(`Game over: ${tab}`), 150);
    },
    onClosed() {
      if (!currentId || finalShotTaken) return;
      finalShotTaken = true;
      const missing = endScreen.state().missing;
      promptNote = missing.length ? `Window closed with ${missing.length} tabs unsaved (${missing.join(", ")}). Final board saved.` : "All stats saved. Final board saved.";
      promptUntil = Date.now() + 8e3;
      setTimeout(() => requestShot("Final board"), 900);
    }
  });
  var endPrompt = createEndPrompt(document);
  function renderPrompt() {
    const s = endScreen.state();
    const note = Date.now() < promptUntil ? promptNote : "";
    const show = overlayEnabled && Boolean(currentId) && (s.open || Boolean(note));
    if (show && !endPrompt.host.isConnected) document.documentElement.append(endPrompt.host);
    endPrompt.setVisible(show);
    if (show) endPrompt.render(s, note ? { done: note } : void 0);
  }
  function maybeBoardShot() {
    if (!currentId || endScreen.state().open || boardShots >= MAX_BOARD_SHOTS) return;
    if (engine.rowCount() < 10 || Date.now() - lastBoardShot < BOARD_SHOT_EVERY_MS) return;
    lastBoardShot = Date.now();
    boardShots++;
    requestShot(`Board after ${engine.rowCount()} log rows`);
  }
  var overlay = createOverlay(document, {
    adjust(name, resource, delta) {
      engine.adjust(name, resource, delta);
      saveAdjustments();
      renderOverlay();
    },
    sweep() {
      void capture.sweep("manual").then(renderOverlay);
      renderOverlay();
    },
    clearAdjustments() {
      engine.clearAdjustments();
      saveAdjustments();
      renderOverlay();
    },
    hide() {
      overlayHidden = true;
      renderOverlay();
    },
    pickMe(name) {
      me = name;
      void api.storage.local.set({ [ME_KEY]: name }).catch(() => void 0);
      renderOverlay();
    },
    turnMap(steps) {
      setMapView(turnView(mapView, steps));
    },
    flipMap(vertical) {
      setMapView(mirrorView(mapView, vertical));
    }
  });
  function setMapView(next) {
    mapView = normalizeView(next);
    void api.storage.local.set({ [MAPVIEW_KEY]: mapView }).catch(() => void 0);
    renderOverlay();
  }
  var sameNameLoose = (a, b) => {
    const norm = (n) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return norm(a).length > 0 && norm(a) === norm(b);
  };
  function liveViews() {
    const views = engine.views();
    const own = helper.selfHand();
    const sizes = helper.handSizes();
    const name = viewerName();
    return views.map((v) => {
      const isOwn = Boolean(own && (own.name && sameNameLoose(v.name, own.name) || name && sameNameLoose(v.name, name) || v.name === "You"));
      const size = sizes.find((s) => sameNameLoose(s.name, v.name))?.size;
      let next = v;
      if (isOwn && own) {
        const total2 = Object.values(own.hand).reduce((a, b) => a + b, 0);
        next = { ...next, hand: own.hand, unknown: 0, total: total2, warnings: [], exact: true };
      }
      const cards = size ?? next.panelCards;
      if (cards !== void 0) next = { ...next, panelCards: cards, delta: cards - next.total, synced: cards === next.total };
      return next;
    });
  }
  var adjKey = (id) => `adj:${id}`;
  function saveAdjustments() {
    if (!currentId) return;
    void api.storage.local.set({ [adjKey(currentId)]: engine.adjustmentsJSON() }).catch(() => void 0);
  }
  async function loadAdjustments(id) {
    try {
      const stored = await api.storage.local.get(adjKey(id));
      const saved = stored[adjKey(id)];
      if (saved && id === currentId) engine.loadAdjustments(saved);
    } catch {
    }
  }
  function viewerName() {
    if (me) return me;
    return (document.querySelector(SEL.headerUsername)?.textContent ?? "").trim();
  }
  var hints = [];
  var hintsDirty = false;
  function noteAdvice(advice) {
    if (!advice || !currentId) return;
    const last = hints[hints.length - 1];
    if (last && last.text === advice.text && last.at === advice.at) return;
    hints.push({ t: Date.now(), phase: advice.phase, text: advice.text, at: advice.at });
    if (hints.length > 60) hints.splice(0, hints.length - 60);
    hintsDirty = true;
  }
  function renderOverlay() {
    const show = overlayEnabled && !overlayHidden && Boolean(currentId) && engine.rowCount() > 0;
    if (!show) {
      overlay.setVisible(false);
      return;
    }
    if (!overlay.host.isConnected) document.documentElement.append(overlay.host);
    overlay.setVisible(true);
    const status = capture.status();
    const views = liveViews();
    const helperView = helperEnabled ? helper.view(views, {
      meName: viewerName() || void 0,
      logNames: views.map((v) => v.name),
      rolls: engine.rolls(),
      firstPlacedAt: (n) => engine.firstPlacedAt(n),
      loggedSettlements: (n) => engine.loggedSettlements(n),
      mapView,
      hook: hook && Date.now() - hook.at < 6e3 ? { sockets: hook.sockets, frames: hook.frames } : void 0
    }) : void 0;
    noteAdvice(helperView?.advice);
    overlay.render({
      views,
      me: viewerName() || void 0,
      log: { rows: engine.rowCount(), missing: status.missing, sweeping: status.sweeping },
      settled: Date.now() - engine.lastRowAt > 1500,
      adjustments: engine.adjustmentCount(),
      helper: helperView,
      notice: status.missing > 0 && !status.sweeping ? `${status.missing} log rows have not been read yet. Counts may be off until they are (press rebuild).` : void 0
    });
  }
  void api.storage.local.get([FORCE_KEY, ME_KEY, OVERLAY_KEY, WS_KEY, HELPER_KEY, MAPVIEW_KEY]).then((v) => {
    mapView = normalizeView(v[MAPVIEW_KEY]);
    forceRecord = Boolean(v[FORCE_KEY]);
    me = typeof v[ME_KEY] === "string" ? v[ME_KEY] : "";
    overlayEnabled = v[OVERLAY_KEY] !== false;
    recordWs = v[WS_KEY] !== false;
    helperEnabled = v[HELPER_KEY] === true;
  });
  api.storage.onChanged.addListener((changes) => {
    if (changes[FORCE_KEY]) forceRecord = Boolean(changes[FORCE_KEY].newValue);
    if (changes[ME_KEY]) me = String(changes[ME_KEY].newValue ?? "");
    if (changes[OVERLAY_KEY]) {
      overlayEnabled = changes[OVERLAY_KEY].newValue !== false;
      if (overlayEnabled) overlayHidden = false;
    }
    if (changes[WS_KEY]) recordWs = changes[WS_KEY].newValue !== false;
    if (changes[HELPER_KEY]) helperEnabled = changes[HELPER_KEY].newValue === true;
    if (changes[MAPVIEW_KEY]) mapView = normalizeView(changes[MAPVIEW_KEY].newValue);
  });
  window.addEventListener("hashchange", syncSegment);
  window.addEventListener("popstate", syncSegment);
  window.addEventListener("pagehide", flush);
  setInterval(() => {
    syncSegment();
    capture.tick();
    if (currentId) {
      maybeBoardShot();
      const snap = snapshotPanel();
      engine.setMe(viewerName() || void 0);
      engine.setPanel(snap);
    }
    const gaps = capture.status();
    if (currentId && gaps.maxIdx >= 0) pendingMeta = { ...pendingMeta, logGaps: gaps.missing };
    renderOverlay();
    renderPrompt();
    flush();
  }, FLUSH_INTERVAL_MS);
  setInterval(() => {
    if (!currentId) return;
    endScreen.tick();
    renderPrompt();
  }, 300);
  capture.start();
})();
