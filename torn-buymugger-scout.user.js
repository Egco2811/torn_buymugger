// ==UserScript==
// @name         Torn Buy-Mug Scout
// @namespace    torn-buymugger-scout
// @version      1.0.5
// @description  Flags buy-muggable bazaar sellers using FFScouter battle-stat estimates, with toggleable filters, a watchlist for players who are nearly back, and an in-page UI. If you enjoy it, send a Xanax to Egco [2598210].
// @author       Egco [2598210]
// @license      AGPL-3.0-or-later
// @copyright    Copyright (C) 2026 Egco [2598210]
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// @connect      ffscouter.com
// @connect      weav3r.dev
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Torn Buy-Mug Scout - open source, free software, no charge, no warranty.
// Copyright (C) 2026 Egco [2598210]
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
// General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// The AGPL is the strongest copyleft licence in common use: anyone who
// redistributes this, or runs a modified version of it as a network
// service, must release their source under the same terms.
(function() {
  "use strict";
  const VERSION = "1.0.5";
  const STORE_PREFIX = "tbms_";
  const TORN_BASE = "https://api.torn.com";
  const FF_BASE = "https://ffscouter.com/api/v1";
  const TORN_HARD_CAP = 100;
  const ERR_TOO_MANY = 5;
  const ERR_DAILY_LIMIT = 14;
  const ERR_BAD_KEY = 2;
  const ERR_KEY_DISABLED = 9;
  const ERR_ACCESS = 3;
  const ERR_FIELDS = 4;
  const ERR_BAD_ID = 6;
  const ERR_PRIVATE = 7;
  const ERR_KEY_LEVEL = 16;
  const ERR_BACKEND = 17;
  const FOOTER_REF_IDS = [ "notes_panel_button", "people_panel_button" ];
  const FOOTER_BTN_ID = "tbms-footer-btn";
  const PANEL_W = 700;
  const WEAV3R_BASE = "https://weav3r.dev/api";
  const AUTHOR_NAME = "Egco";
  const AUTHOR_ID = "2598210";
  const TIP_LINE = "If you enjoyed this, send " + AUTHOR_NAME + " [" + AUTHOR_ID + "] a Xanax - it is always appreciated.";
  const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  function rawGet(key) {
    try {
      if (hasGM) {
        const v = GM_getValue(key, undefined);
        if (v !== undefined) return v;
      } else {
        const v = window.localStorage.getItem(STORE_PREFIX + key);
        if (v !== null) return v;
      }
    } catch (e) {}
    return undefined;
  }
  function rawSet(key, value) {
    try {
      if (hasGM) GM_setValue(key, value); else window.localStorage.setItem(STORE_PREFIX + key, value);
    } catch (e) {}
  }
  function rawDelete(key) {
    try {
      if (hasGM) {
        if (typeof GM_deleteValue === "function") GM_deleteValue(key); else GM_setValue(key, "");
        return;
      }
      window.localStorage.removeItem(STORE_PREFIX + key);
    } catch (e) {}
  }
  function loadJSON(key, fallback) {
    const raw = rawGet(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    rawSet(key, JSON.stringify(value));
  }
  const DEFAULT_SETTINGS = {
    api: {
      tornKey: "",
      ffKey: "",
      delayMs: 250,
      maxPerMinute: 100,
      cacheMinutes: 15,
      ffChunkSize: 60,
      workers: 5,
      rateLimitWaitMs: 6e4,
      rateLimitRetries: 2
    },
    me: {
      id: 0,
      name: "",
      level: 0,
      factionId: 0,
      bs: 0,
      bsUpdated: 0
    },
    scan: {
      autoHarvest: true,
      scanScripts: false,
      maxTargetsPerScan: 80,
      maxCandidates: 300,
      fetchProperty: true,
      useWeav3r: true,
      lastItemId: 0,
      auto: {
        on: false,
        itemId: 0,
        intervalSec: 60
      }
    },
    watch: {
      autoAdd: true,
      windowMin: 30,
      checkEverySec: 30,
      keepReadyMin: 45
    },
    econ: {
      mugMerits: 0,
      mugPlunder: 0
    },
    filters: {
      inTornOnly: {
        on: true,
        value: 1
      },
      notHospitalised: {
        on: true,
        value: 1
      },
      soonInTorn: {
        on: true,
        value: 5
      },
      soonOutOfHospital: {
        on: true,
        value: 5
      },
      notActiveWithin: {
        on: false,
        value: 30
      },
      minBazaarValue: {
        on: false,
        value: 1e6
      },
      minLoot: {
        on: false,
        value: 0
      },
      minItemCount: {
        on: false,
        value: 1
      },
      minWorthyItems: {
        on: false,
        value: 1
      },
      worthyUnitPrice: {
        on: true,
        value: 1e5
      },
      minDealCount: {
        on: false,
        value: 1
      },
      dealDiscount: {
        on: true,
        value: .15
      },
      vault: "ignore",
      maxFairFight: {
        on: true,
        value: 3
      },
      bsVsMine: {
        on: true,
        value: 1
      },
      maxBsEstimate: {
        on: false,
        value: 5e8
      },
      allowUnknownStats: {
        on: true,
        value: 1
      },
      minScore: {
        on: false,
        value: 0
      },
      sameFaction: {
        on: true,
        value: 1
      },
      minLevel: {
        on: false,
        value: 1
      },
      maxLevel: {
        on: false,
        value: 100
      }
    },
    ui: {
      open: false,
      tab: "scan",
      onlyMatches: false,
      toast: true,
      fabPos: null,
      panelPos: null,
      panelSize: null
    }
  };
  const SETTINGS_KEY = "settings";
  const CACHE_KEY = "cache_v1";
  function mergeDefaults(base, incoming) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!incoming || typeof incoming !== "object") return out;
    Object.keys(base).forEach(function(k) {
      const b = base[k];
      const i = incoming[k];
      if (i === undefined) return;
      if (b && typeof b === "object" && !Array.isArray(b)) {
        out[k] = mergeDefaults(b, i);
      } else {
        out[k] = i;
      }
    });
    return out;
  }
  let settings = mergeDefaults(DEFAULT_SETTINGS, loadJSON(SETTINGS_KEY, {}));
  let saveTimer = null;
  function saveSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function() {
      saveJSON(SETTINGS_KEY, settings);
    }, 150);
  }
  let cache = loadJSON(CACHE_KEY, {});
  function cachePrune() {
    const ttl = Math.max(1, settings.api.cacheMinutes) * 6e4;
    const now = Date.now();
    let changed = false;
    Object.keys(cache).forEach(function(id) {
      if (now - (cache[id].at || 0) > ttl) {
        delete cache[id];
        changed = true;
      }
    });
    if (changed) saveJSON(CACHE_KEY, cache);
  }
  function cacheGet(id) {
    const hit = cache[id];
    if (!hit) return null;
    const ttl = Math.max(1, settings.api.cacheMinutes) * 6e4;
    if (Date.now() - (hit.at || 0) > ttl) return null;
    return hit.data;
  }
  function cacheSet(id, data) {
    cache[id] = {
      at: Date.now(),
      data: data
    };
  }
  function cacheFlush() {
    cache = {};
    rawDelete(CACHE_KEY);
  }
  const hasGMX = typeof GM_xmlhttpRequest === "function";
  function httpGet(url) {
    return new Promise(function(resolve, reject) {
      if (hasGMX) {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          timeout: 25e3,
          headers: {
            Accept: "application/json"
          },
          onload: function(res) {
            resolve({
              status: res.status,
              text: res.responseText || ""
            });
          },
          onerror: function() {
            reject(new Error("Network error contacting " + hostOf(url)));
          },
          ontimeout: function() {
            reject(new Error("Timed out contacting " + hostOf(url)));
          }
        });
      } else {
        fetch(url, {
          credentials: "omit"
        }).then(function(r) {
          return r.text().then(function(t) {
            resolve({
              status: r.status,
              text: t
            });
          });
        }).catch(reject);
      }
    });
  }
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return url;
    }
  }
  function sleep(ms) {
    return new Promise(function(r) {
      setTimeout(r, ms);
    });
  }
  const q = {
    chain: Promise.resolve(),
    stamps: [],
    lastAt: 0,
    pausedUntil: 0,
    waiters: []
  };
  function pauseTornQueue(ms, reason) {
    const until = Date.now() + ms;
    if (until <= q.pausedUntil) return;
    q.pausedUntil = until;
    (q.waiters || []).forEach(function(fn) {
      try {
        fn(until, reason);
      } catch (e) {}
    });
  }
  function onQueuePaused(fn) {
    q.waiters = q.waiters || [];
    q.waiters.push(fn);
  }
  function enqueue(fn) {
    const run = q.chain.then(async function() {
      const delay = Math.max(0, settings.api.delayMs, 0);
      for (;;) {
        if (q.pausedUntil > Date.now()) {
          await sleep(Math.min(q.pausedUntil - Date.now(), 5e3));
          continue;
        }
        const now = Date.now();
        const gap = q.lastAt + delay - now;
        if (gap > 0) {
          await sleep(gap);
          continue;
        }
        while (q.stamps.length && now - q.stamps[0] > 6e4) q.stamps.shift();
        const cap = Math.min(TORN_HARD_CAP, Math.max(1, settings.api.maxPerMinute || 90));
        if (q.stamps.length >= cap) {
          await sleep(6e4 - (now - q.stamps[0]) + 120);
          continue;
        }
        break;
      }
      q.lastAt = Date.now();
      q.stamps.push(q.lastAt);
      return fn();
    });
    q.chain = run.catch(function() {});
    return run;
  }
  async function tornGet(pathAndQuery) {
    return enqueue(async function() {
      const url = TORN_BASE + pathAndQuery;
      const res = await httpGet(url);
      let data;
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        return {
          ok: false,
          code: -1,
          error: "Unparseable response from Torn"
        };
      }
      if (data && data.error) {
        return {
          ok: false,
          code: data.error.code,
          error: data.error.error
        };
      }
      return {
        ok: true,
        data: data
      };
    });
  }
  async function ffGet(pathAndQuery) {
    const res = await httpGet(FF_BASE + pathAndQuery);
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error("Unparseable response from FFScouter");
    }
    if (data && !Array.isArray(data) && data.error) {
      throw new Error(data.error);
    }
    return data;
  }
  const KEY_URL_SAFE = function(k) {
    return encodeURIComponent(k || "");
  };
  async function fetchPlayer(id) {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const ladder = [ "profile,basic,battlestats,bazaar", "profile,basic,bazaar", "profile,basic" ];
    let lastErr = null;
    for (let i = 0; i < ladder.length; i++) {
      const res = await tornGet("/user/" + id + "?selections=" + ladder[i] + "&key=" + key);
      if (res.ok) return {
        data: res.data,
        selections: ladder[i]
      };
      if (res.code === ERR_TOO_MANY) {
        const e = new Error(res.error);
        e.rateLimit = true;
        throw e;
      }
      if (res.code === ERR_DAILY_LIMIT) {
        const e = new Error(res.error);
        e.fatal = true;
        e.dailyLimit = true;
        throw e;
      }
      if (res.code === ERR_BAD_KEY || res.code === ERR_KEY_DISABLED) {
        const e = new Error(res.error);
        e.badKey = true;
        e.fatal = true;
        throw e;
      }
      if (res.code === ERR_BAD_ID) {
        const e = new Error(res.error);
        e.badId = true;
        throw e;
      }
      lastErr = res;
      if (i === ladder.length - 1) break;
    }
    const e = new Error(lastErr && lastErr.error || "Lookup failed");
    e.tornCode = lastErr && lastErr.code;
    throw e;
  }
  async function fetchSelf() {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const ladder = [ "profile,basic,battlestats,money", "profile,basic,money", "profile,basic" ];
    let lastErr = null;
    for (let i = 0; i < ladder.length; i++) {
      const res = await tornGet("/user/?selections=" + ladder[i] + "&key=" + key);
      if (res.ok) return res.data;
      lastErr = res;
      if (res.code === ERR_BAD_KEY || res.code === ERR_KEY_DISABLED) break;
    }
    const e = new Error(lastErr && lastErr.error || "Lookup failed");
    e.tornCode = lastErr && lastErr.code;
    throw e;
  }
  async function fetchProperty(id) {
    const res = await tornGet("/v2/user/" + id + "/property?key=" + KEY_URL_SAFE(settings.api.tornKey));
    if (!res.ok) return {
      error: res.error,
      code: res.code
    };
    return {
      data: res.data
    };
  }
  function parseBattleStats(node) {
    if (!node) return null;
    const keys = [ "strength", "speed", "dexterity", "defense" ];
    const parts = keys.map(function(k) {
      return toNumber(node[k]);
    });
    if (parts.every(function(v) {
      return v === null;
    })) return null;
    const sum = parts.reduce(function(a, b) {
      return a + (b || 0);
    }, 0);
    if (node.total !== undefined && node.total !== null && toNumber(node.total) === null) {
      return sum || null;
    }
    return toNumber(node.total) !== null ? toNumber(node.total) : sum;
  }
  function toItemArray(node) {
    if (Array.isArray(node)) return node;
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node.items)) return node.items;
    const out = [];
    Object.keys(node).forEach(function(k) {
      const v = node[k];
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    });
    return out;
  }
  function bazaarLineFor(items, itemId) {
    const want = toNumber(itemId);
    if (want === null || !Array.isArray(items)) return null;
    const line = items.filter(function(it) {
      if (!it || typeof it !== "object") return false;
      const id = toNumber(it.ID !== undefined ? it.ID : it.item_id);
      return id === want;
    });
    return line.length ? line : null;
  }
  function normaliseUser(data) {
    const d = data || {};
    const profile = d.profile || {};
    const basic = d.basic || {};
    const nestedStats = d.stats || d.battlestats || null;
    const firstNum = function() {
      for (let i = 0; i < arguments.length; i++) {
        const v = toNumber(arguments[i]);
        if (v !== null) return v;
      }
      return null;
    };
    let stats = null;
    if (nestedStats && toNumber(nestedStats.strength) !== null) {
      stats = nestedStats;
    } else if (toNumber(d.strength) !== null) {
      stats = {
        strength: d.strength,
        speed: d.speed,
        dexterity: d.dexterity,
        defense: d.defense,
        total: d.total
      };
    }
    if (stats && toNumber(stats.total) === null) {
      const sum = [ "strength", "speed", "dexterity", "defense" ].reduce(function(a, k) {
        return a + (toNumber(stats[k]) || 0);
      }, 0);
      stats = Object.assign({}, stats, {
        total: sum
      });
    }
    const la = d.last_action || profile.last_action || null;
    const lastAction = la && typeof la === "object" ? firstNum(la.timestamp, la.time) : firstNum(la);
    const bazaar = toItemArray(d.bazaar);
    return {
      id: firstNum(d.player_id, basic.player_id),
      name: d.name || profile.name || basic.name || null,
      level: firstNum(d.level, profile.level, basic.level),
      factionId: firstNum(d.faction_id, basic.faction_id) || 0,
      status: d.status || profile.status || null,
      lastAction: lastAction,
      stats: stats,
      bazaar: bazaar,
      property: d.property || null
    };
  }
  const ITEMS_CACHE_KEY = "items_v1";
  const ITEMS_TTL_MS = 7 * 24 * 3600 * 1e3;
  const NAMES_CACHE_KEY = "names_v1";
  let nameCache = loadJSON(NAMES_CACHE_KEY, {});
  function rememberName(id, name) {
    if (!id || !name || /^Player \d+$/.test(name)) return;
    if (nameCache[id] === name) return;
    nameCache[id] = name;
    const keys = Object.keys(nameCache);
    if (keys.length > 2e3) delete nameCache[keys[0]];
    saveJSON(NAMES_CACHE_KEY, nameCache);
  }
  function knownName(id) {
    return nameCache[id] || null;
  }
  const diagnostics = {
    lastRaw: null,
    lastRawLabel: ""
  };
  function rememberRaw(label, data) {
    let text;
    try {
      text = JSON.stringify(data);
    } catch (e) {
      text = String(data);
    }
    diagnostics.lastRaw = (text || "").slice(0, 4e3);
    diagnostics.lastRawLabel = label;
  }
  async function weav3rItemIndex() {
    const res = await httpGet(WEAV3R_BASE + "/marketplace?limit=2000");
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error("the item index was unreadable");
    }
    const list = data && data.items;
    if (!Array.isArray(list) || !list.length) throw new Error("no items in the response");
    const out = {};
    list.forEach(function(it) {
      if (!it || it.item_id == null || it.item_id <= 0) return;
      out[it.item_id] = it.item_name || "Item " + it.item_id;
    });
    return out;
  }
  async function loadItemList(forceRefresh) {
    const cached = loadJSON(ITEMS_CACHE_KEY, null);
    if (!forceRefresh && cached && cached.at && Date.now() - cached.at < ITEMS_TTL_MS && Object.keys(cached.items || {}).length) {
      return cached.items;
    }
    let items = null;
    if (settings.api.tornKey) {
      try {
        const key = KEY_URL_SAFE(settings.api.tornKey);
        const res = await tornGet("/torn/?selections=items&key=" + key);
        if (res.ok) {
          const raw = res.data && res.data.items || {};
          const out = {};
          Object.keys(raw).forEach(function(id) {
            out[id] = raw[id] && raw[id].name || "Item " + id;
          });
          if (Object.keys(out).length) items = out;
        }
      } catch (e) {
        log("Torn item list: " + e.message, "warn");
      }
    }
    if (!items && settings.scan.useWeav3r) {
      try {
        items = await weav3rItemIndex();
      } catch (e) {
        log("weav3r item list: " + e.message, "warn");
      }
    }
    if (items && Object.keys(items).length) {
      saveJSON(ITEMS_CACHE_KEY, {
        at: Date.now(),
        items: items
      });
      return items;
    }
    return {};
  }
  function normaliseBazaarRows(raw, itemId) {
    const out = [];
    const seen = {};
    function pickNumber(node, names, depth) {
      depth = depth || 0;
      if (!node || typeof node !== "object" || depth > 3) return null;
      for (let i = 0; i < names.length; i++) {
        const v = toNumber(node[names[i]]);
        if (v !== null) return v;
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const v = node[keys[i]];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const got = pickNumber(v, names, depth + 1);
          if (got !== null) return got;
        }
      }
      return null;
    }
    function add(id, row) {
      if (!isValidPlayerId(id) || seen[id]) return;
      seen[id] = true;
      out.push({
        id: id,
        name: row.player_name || row.seller_name || row.name || null,
        price: pickNumber(row, [ "cost", "price", "unit_price" ]),
        qty: pickNumber(row, [ "quantity", "amount", "qty", "count" ]),
        marketPrice: pickNumber(row, [ "market_price", "marketPrice", "average_price" ])
      });
    }
    function walk(node, keyHint, depth) {
      if (!node || depth > 4) return;
      if (Array.isArray(node)) {
        node.forEach(function(entry) {
          walk(entry, keyHint, depth + 1);
        });
        return;
      }
      if (typeof node !== "object") return;
      const explicit = toNumber(node.player_id != null ? node.player_id : node.seller_id != null ? node.seller_id : node.user_id != null ? node.user_id : null);
      if (explicit !== null) {
        add(explicit, node);
        return;
      }
      if (keyHint !== undefined && keyHint !== null && !isNaN(Number(keyHint))) {
        const asNum = Number(keyHint);
        if (isValidPlayerId(asNum)) {
          add(asNum, node);
          return;
        }
      }
      const loose = toNumber(node.ID != null ? node.ID : node.id);
      if (loose !== null && loose !== toNumber(itemId) && isValidPlayerId(loose)) {
        add(loose, node);
        return;
      }
      Object.keys(node).forEach(function(k) {
        walk(node[k], k, depth + 1);
      });
    }
    const roots = [];
    if (raw && !Array.isArray(raw) && typeof raw === "object") {
      [ "bazaar", "listings", "itemmarket", "data" ].forEach(function(k) {
        if (raw[k] !== undefined) roots.push(raw[k]);
      });
      if (!roots.length) roots.push(raw);
    } else {
      roots.push(raw);
    }
    roots.forEach(function(root) {
      walk(root, undefined, 0);
    });
    return out;
  }
  async function weav3rBazaarSellers(itemId) {
    const res = await httpGet(WEAV3R_BASE + "/marketplace/" + itemId + "?limit=100");
    if (res.status !== 200) {
      throw new Error("the scanner answered HTTP " + res.status);
    }
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error("the scanner returned something unreadable");
    }
    if (!data || !Array.isArray(data.listings)) {
      throw new Error("the scanner returned no listings");
    }
    const sellers = normaliseBazaarRows(data, itemId);
    if (!sellers.length) rememberRaw("weav3r marketplace " + itemId, data);
    return {
      marketPrice: toNumber(data.market_price),
      bazaarAverage: toNumber(data.bazaar_average),
      sellers: sellers
    };
  }
  async function findBazaarSellers(itemId) {
    const attempts = [];
    if (settings.api.tornKey) attempts.push([ "torn v2", tornBazaarSellersV2, true ]);
    if (settings.scan.useWeav3r) attempts.push([ "weav3r", weav3rBazaarSellers, false ]);
    const byId = {};
    const used = [];
    const problems = [];
    let marketPrice = null;
    for (let i = 0; i < attempts.length; i++) {
      const label = attempts[i][0];
      try {
        const res = await attempts[i][1](itemId);
        const sellers = Array.isArray(res) ? res : res && res.sellers || [];
        if (res && res.marketPrice && !marketPrice) marketPrice = res.marketPrice;
        if (!sellers.length) {
          problems.push(label + " listed none");
          continue;
        }
        used.push(label + ":" + sellers.length);
        sellers.forEach(function(row) {
          const cur = byId[row.id];
          if (!cur) {
            byId[row.id] = {
              id: row.id,
              name: row.name || null,
              price: row.price,
              qty: row.qty,
              marketPrice: row.marketPrice
            };
            return;
          }
          if (cur.price == null && row.price != null) cur.price = row.price;
          if (cur.qty == null && row.qty != null) cur.qty = row.qty;
          if (cur.marketPrice == null && row.marketPrice != null) cur.marketPrice = row.marketPrice;
          if (!cur.name && row.name) cur.name = row.name;
        });
      } catch (e) {
        problems.push(label + ": " + e.message);
      }
    }
    const sellers = Object.keys(byId).map(function(k) {
      return byId[k];
    });
    const detail = attempts.map(function(a) {
      const label = a[0];
      const hit = used.find(function(u) {
        return u.indexOf(label + ":") === 0;
      });
      if (hit) return hit;
      const problem = problems.find(function(p) {
        return p.indexOf(label) === 0;
      });
      return label + ": 0" + (problem ? " (" + problem.replace(label + ": ", "").replace(label + " ", "") + ")" : "");
    });
    return {
      source: used.length ? used.join(" + ") : null,
      sellers: sellers,
      marketPrice: marketPrice,
      detail: detail,
      problems: problems,
      sawData: sellers.length > 0
    };
  }
  async function tornBazaarSellersV2(itemId) {
    const res = await tornGet("/v2/market/" + itemId + "/bazaar?key=" + KEY_URL_SAFE(settings.api.tornKey));
    if (!res.ok) {
      const e = new Error(res.error);
      e.tornCode = res.code;
      throw e;
    }
    const sellers = normaliseBazaarRows(res.data, itemId);
    if (!sellers.length) rememberRaw("market " + itemId + " (v2)", res.data);
    return sellers;
  }
  function currentItemId() {
    const href = window.location.href;
    const m = href.match(/[?&#/]itemID=(\d+)/i) || href.match(/item\.php\?id=(\d+)/i) || href.match(/[?&#/]item_?id=(\d+)/i);
    return m ? toNumber(m[1]) : null;
  }
  async function ffLookup(ids) {
    const out = {};
    if (!ids.length) return out;
    const key = KEY_URL_SAFE(settings.api.ffKey || settings.api.tornKey);
    const chunk = Math.max(1, Math.min(200, settings.api.ffChunkSize || 60));
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      let data;
      try {
        data = await ffGet("/get-stats?key=" + key + "&targets=" + slice.join(","));
      } catch (e) {
        log("FFScouter: " + e.message, "warn");
        continue;
      }
      const rows = Array.isArray(data) ? data : data && data.targets ? data.targets : [];
      rows.forEach(function(row) {
        const pid = row.player_id || row.id;
        if (!pid) return;
        out[pid] = {
          fairFight: toNumber(row.fair_fight),
          bsEstimate: toNumber(row.bs_estimate),
          bsHuman: row.bs_estimate_human || null,
          bssPublic: toNumber(row.bss_public),
          source: row.source || null,
          lastUpdated: toNumber(row.last_updated)
        };
      });
      if (i + chunk < ids.length) await sleep(3200);
    }
    return out;
  }
  async function ffCheckKey() {
    const key = KEY_URL_SAFE(settings.api.ffKey || settings.api.tornKey);
    return ffGet("/check-key?key=" + key);
  }
  function toNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[,\s$]/g, ""));
    return isFinite(n) ? n : null;
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function formatNumber(n) {
    if (n === null || n === undefined || !isFinite(n)) return "-";
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function formatMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return "-";
    return "$" + formatNumber(n);
  }
  function formatAgo(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return "-";
    if (seconds < 60) return Math.round(seconds) + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    if (seconds < 86400) return (seconds / 3600).toFixed(1) + "h";
    return (seconds / 86400).toFixed(1) + "d";
  }
  function readStatus(input) {
    const st = input && input.status || input || {};
    const state = String(st.state || "").trim();
    const description = String(st.description || "").trim();
    const hay = (state + " " + description).toLowerCase();
    const has = !!state;
    const is = function(name, re) {
      return has ? state.toLowerCase() === name : re.test(hay);
    };
    const isAbroad = is("abroad", /abroad/);
    const isTravelling = has ? state.toLowerCase() === "traveling" || state.toLowerCase() === "travelling" : /travelling|traveling/.test(hay);
    const isHospital = is("hospital", /hospital/);
    const isJail = is("jail", /jail/);
    const isFederal = is("federal", /federal/);
    const isFallen = has ? state.toLowerCase() === "fallen" : /dead|fallen/.test(hay);
    const okay = has ? state.toLowerCase() === "okay" : !description;
    const available = okay && !isAbroad && !isTravelling && !isHospital && !isJail && !isFederal && !isFallen;
    return {
      state: state || (description ? "unknown" : "Okay"),
      description: description,
      until: toNumber(st.until),
      isAbroad: isAbroad,
      isTravelling: isTravelling,
      isHospital: isHospital,
      isJail: isJail,
      isFederal: isFederal,
      isFallen: isFallen,
      inTorn: !isAbroad && !isTravelling,
      available: available
    };
  }
  function secondsUntilFree(status, nowSec) {
    if (!status || !status.until) return null;
    const now = nowSec || Math.floor(Date.now() / 1e3);
    const left = status.until - now;
    return left > 0 ? left : 0;
  }
  function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined) return null;
    if (seconds <= 0) return "now";
    return formatAgo(seconds);
  }
  function detectVault(propertySelection) {
    if (!propertySelection || typeof propertySelection !== "object") {
      return {
        hasVault: null,
        vaultAmount: null
      };
    }
    let hasVault = null;
    let vaultAmount = null;
    if (propertySelection.vault !== undefined && propertySelection.vault !== null) {
      const amt = toNumber(propertySelection.vault);
      hasVault = true;
      vaultAmount = amt;
    }
    const props = propertySelection.properties || {};
    Object.keys(props).forEach(function(pid) {
      const p = props[pid];
      if (!p || typeof p !== "object") return;
      if (hasVault === true) return;
      const flat = safeStringify(p).toLowerCase();
      if (flat.indexOf("vault") !== -1) {
        hasVault = true;
        const nested = findKeyValue(p, "vault");
        const amt = toNumber(nested);
        if (amt !== null && vaultAmount === null) vaultAmount = amt;
      }
    });
    return {
      hasVault: hasVault,
      vaultAmount: vaultAmount
    };
  }
  function safeStringify(obj) {
    try {
      return JSON.stringify(obj) || "";
    } catch (e) {
      return "";
    }
  }
  function propertyLabel(property) {
    if (!property || typeof property !== "object") return null;
    const props = property.properties || property;
    const ids = Object.keys(props);
    for (let i = 0; i < ids.length; i++) {
      const p = props[ids[i]];
      if (p && typeof p === "object") {
        const name = p.name || p.property || p.property_type;
        if (name && typeof name === "string") return name;
      }
    }
    return null;
  }
  function findKeyValue(obj, needle, depth) {
    depth = depth || 0;
    if (depth > 6 || !obj || typeof obj !== "object") return null;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.toLowerCase().indexOf(needle) !== -1) {
        const v = obj[k];
        if (typeof v === "number" || typeof v === "string") return v;
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v && typeof v === "object") {
        const got = findKeyValue(v, needle, depth + 1);
        if (got !== null) return got;
      }
    }
    return null;
  }
  function summariseBazaar(items, opts) {
    const o = opts || {};
    const worthyUnitPrice = o.worthyUnitPrice || 0;
    const dealDiscount = o.dealDiscount || 0;
    const list = Array.isArray(items) ? items : [];
    let buyout = 0;
    let marketValue = 0;
    let count = 0;
    let worthyCount = 0;
    let worthyBuyout = 0;
    let dealCount = 0;
    let dealBuyout = 0;
    let topItem = null;
    list.forEach(function(it) {
      if (!it || typeof it !== "object") return;
      const price = toNumber(it.price) || 0;
      const qty = toNumber(it.quantity) || 0;
      const market = toNumber(it.market_price);
      const line = price * qty;
      const name = it.name || "item #" + (it.ID || "?");
      buyout += line;
      count += qty;
      if (market !== null) marketValue += market * qty;
      const isWorthy = worthyUnitPrice > 0 ? price >= worthyUnitPrice : true;
      if (isWorthy) {
        worthyCount += qty;
        worthyBuyout += line;
      }
      if (market !== null && market > 0 && price <= market * (1 - dealDiscount)) {
        dealCount += qty;
        dealBuyout += line;
      }
      if (!topItem || line > topItem.value) {
        topItem = {
          name: name,
          value: line,
          qty: qty,
          price: price,
          market: market
        };
      }
    });
    return {
      items: list,
      itemLines: list.length,
      count: count,
      buyout: buyout,
      marketValue: marketValue,
      worthyCount: worthyCount,
      worthyBuyout: worthyBuyout,
      dealCount: dealCount,
      dealBuyout: dealBuyout,
      topItem: topItem
    };
  }
  const MUG_BASE_LOW = 5;
  const MUG_BASE_HIGH = 10;
  const MUG_BASE_LIKELY = 6.5;
  const MUG_MERIT_STEP = 5;
  const MUG_PLUNDER_MAX = 49;
  function roundHalfAway(value, places) {
    const f = Math.pow(10, places);
    return (value < 0 ? -1 : 1) * (Math.round(Math.abs(value) * f) / f);
  }
  function mugMultiplier(econ) {
    const e = econ || settings.econ || {};
    const merits = clamp(Math.round(toNumber(e.mugMerits) || 0), 0, 10);
    const plunder = clamp(toNumber(e.mugPlunder) || 0, 0, MUG_PLUNDER_MAX);
    return 1 + merits * MUG_MERIT_STEP / 100 + plunder / 100;
  }
  function mugBand(cash, econ) {
    const c = Math.max(0, toNumber(cash) || 0);
    const mult = mugMultiplier(econ);
    const lowPct = roundHalfAway(MUG_BASE_LOW * mult, 2);
    const highPct = roundHalfAway(MUG_BASE_HIGH * mult, 2);
    const likelyPct = roundHalfAway(MUG_BASE_LIKELY * mult, 2);
    return {
      cash: c,
      multiplier: mult,
      lowPct: lowPct,
      likelyPct: likelyPct,
      highPct: highPct,
      low: Math.floor(c * lowPct / 100),
      likely: Math.floor(c * likelyPct / 100),
      high: Math.floor(c * highPct / 100)
    };
  }
  function mugPercent(cash, econ) {
    return mugBand(cash, econ).likelyPct;
  }
  function mugTake(cash, econ) {
    return mugBand(cash, econ).likely;
  }
  function formatPercent(value) {
    return String(roundHalfAway(toNumber(value) || 0, 2));
  }
  function mugModifierLabel(econ) {
    const e = econ || settings.econ || {};
    const merits = clamp(Math.round(toNumber(e.mugMerits) || 0), 0, 10);
    const plunder = clamp(toNumber(e.mugPlunder) || 0, 0, MUG_PLUNDER_MAX);
    const parts = [];
    if (merits) parts.push("Masterful Looting " + merits + "/10");
    if (plunder) parts.push("Plunder " + formatPercent(plunder) + "%");
    return parts.length ? parts.join(" + ") : "no mug bonuses";
  }
  function signedMoney(value) {
    const v = toNumber(value) || 0;
    return (v < 0 ? "-" : "+") + formatMoney(Math.abs(v));
  }
  function lootBreakdown(subject, econ) {
    const e = econ || settings.econ;
    const listing = subject && subject.listing;
    const onSale = subject && subject.listingSummary || subject && subject.itemSummary || {};
    const empty = {
      qty: 0,
      price: 0,
      marketPrice: 0,
      spend: 0,
      marketValue: 0,
      unitDifference: 0,
      totalDifference: 0,
      gross: 0,
      grossLow: 0,
      grossHigh: 0,
      pct: 0,
      pctLow: 0,
      pctHigh: 0,
      net: 0,
      netLow: 0,
      netHigh: 0,
      mugBand: mugBand(0, e)
    };
    const spend = toNumber(subject && subject.value) || toNumber(onSale.buyout) || 0;
    if (spend <= 0) return empty;
    const qty = listing && toNumber(listing.qty) || toNumber(onSale.count) || 0;
    const price = listing && toNumber(listing.price) || (qty ? spend / qty : 0);
    const marketUnit = listing && toNumber(listing.marketPrice) || (qty ? toNumber(onSale.marketValue) / qty : 0);
    const worth = marketUnit > 0 ? marketUnit : price;
    const unitDifference = worth - price;
    const totalDifference = Math.floor(unitDifference * qty);
    const band = mugBand(spend, e);
    return {
      qty: qty,
      price: price,
      marketPrice: marketUnit,
      spend: spend,
      marketValue: Math.floor(worth * qty),
      unitDifference: unitDifference,
      totalDifference: totalDifference,
      gross: band.likely,
      grossLow: band.low,
      grossHigh: band.high,
      pct: band.likelyPct,
      pctLow: band.lowPct,
      pctHigh: band.highPct,
      net: totalDifference + band.likely,
      netLow: totalDifference + band.low,
      netHigh: totalDifference + band.high,
      mugBand: band
    };
  }
  function predictedLoot(subject, econ) {
    return lootBreakdown(subject, econ).net;
  }
  function estimateEconomics(subject, econ) {
    const e = econ || settings.econ;
    const d = lootBreakdown(subject, e);
    return {
      spend: d.spend,
      mugTargetCash: d.spend,
      mugPercent: d.spend > 0 ? d.pct : 0,
      mugPercentLow: d.spend > 0 ? d.pctLow : 0,
      mugPercentHigh: d.spend > 0 ? d.pctHigh : 0,
      mugGross: d.gross,
      mugTake: d.gross,
      mugGrossLow: d.grossLow,
      mugGrossHigh: d.grossHigh,
      itemsWorth: d.marketValue,
      unitDifference: d.unitDifference,
      totalDifference: d.totalDifference,
      net: d.net,
      netLow: d.netLow,
      netHigh: d.netHigh,
      roi: d.spend > 0 ? d.net / d.spend : 0
    };
  }
  function evaluateTarget(subject, opts) {
    const s = opts.settings;
    const f = s.filters;
    const me = s.me;
    const fail = [];
    const pass = [];
    const status = subject.status;
    const ff = subject.ff || {};
    const vault = subject.vault || {
      hasVault: null,
      vaultAmount: null
    };
    const bazar = subject.bazaar;
    if (subject.lookupError && !subject.screenedOut) fail.push(subject.lookupError);
    if (subject.screenedOut) {
      const still = strengthFailReason(subject.ff);
      fail.push(still ? "screened out: " + still : "not checked - run a scan to include");
      return {
        id: subject.id,
        name: subject.name,
        score: 0,
        verdict: "reject",
        reasons: fail,
        positives: [],
        rank: 1
      };
    }
    const untilFree = secondsUntilFree(status);
    const soonMins = f.soonOutOfHospital.value;
    const landMins = f.soonInTorn.value;
    const lockedUp = status.isHospital || status.isJail || status.isFederal || status.isFallen;
    const away = !status.inTorn;
    let soonOut = false;
    if (lockedUp && f.soonOutOfHospital.on && untilFree !== null) {
      soonOut = untilFree <= soonMins * 60;
    }
    let soonLand = false;
    if (away && f.soonInTorn.on && untilFree !== null) {
      soonLand = untilFree <= landMins * 60;
    }
    if (away) {
      if (soonLand) {
        pass.push("lands in " + formatCountdown(untilFree));
      } else if (f.inTornOnly.on) {
        fail.push(status.isAbroad ? "abroad" : "travelling");
      }
    } else if (f.inTornOnly.on) {
      pass.push("in Torn");
    }
    if (lockedUp) {
      if (soonOut) {
        pass.push("free in " + formatCountdown(untilFree));
      } else if (f.notHospitalised.on) {
        fail.push(status.isHospital ? "hospitalised" : status.isJail ? "jailed" : status.isFederal ? "federal" : "fallen");
      }
    }
    if (f.notActiveWithin.on) {
      const mins = subject.lastActionAgo !== null ? subject.lastActionAgo / 60 : null;
      if (mins !== null && mins < f.notActiveWithin.value) {
        fail.push("active " + formatAgo(subject.lastActionAgo) + " ago");
      } else if (mins !== null) {
        pass.push("idle " + formatAgo(subject.lastActionAgo));
      }
    }
    const onSale = subject.listingSummary || subject.itemSummary || bazar;
    const onSaleValue = subject.value || 0;
    const loot = subject.loot === undefined ? predictedLoot(subject) : subject.loot;
    if (f.minBazaarValue.on && subject.valueUnknown) {
      pass.push("value not returned");
    } else if (f.minBazaarValue.on && onSaleValue < f.minBazaarValue.value) {
      fail.push("on sale " + formatMoney(onSaleValue));
    } else if (f.minBazaarValue.on) {
      pass.push("on sale " + formatMoney(onSaleValue));
    }
    if (f.minLoot.on && loot < f.minLoot.value) {
      fail.push("loot " + formatMoney(loot));
    } else if (f.minLoot.on) {
      pass.push("loot " + formatMoney(loot));
    }
    if (f.minItemCount.on && bazar.count < f.minItemCount.value && !subject.listing) {
      fail.push(bazar.count + " items");
    }
    if (f.minWorthyItems.on && bazar.worthyCount < f.minWorthyItems.value) {
      fail.push("worthy " + bazar.worthyCount);
    } else if (f.minWorthyItems.on) {
      pass.push("worthy " + bazar.worthyCount);
    }
    if (f.minDealCount.on && bazar.dealCount < f.minDealCount.value) {
      fail.push("deals " + bazar.dealCount);
    } else if (f.minDealCount.on && bazar.dealCount > 0) {
      pass.push("deals " + bazar.dealCount);
    }
    if (f.vault === "require") {
      if (vault.hasVault !== true) fail.push(vault.hasVault === null ? "vault unknown" : "no vault"); else pass.push("has a vault");
    } else if (f.vault === "exclude") {
      if (vault.hasVault === true) fail.push("has a vault"); else if (vault.hasVault === false) pass.push("no vault");
    }
    const ffScore = ff.fairFight;
    const bsEst = ff.bsEstimate;
    const hasStats = ffScore !== null && ffScore !== undefined;
    if (!hasStats && !f.allowUnknownStats.on) {
      fail.push("no FF data");
    }
    if (f.maxFairFight.on) {
      if (ffScore === null || ffScore === undefined) {
        if (!f.allowUnknownStats.on) fail.push("FF unknown");
      } else if (ffScore > f.maxFairFight.value) {
        fail.push("FF " + ffScore.toFixed(2));
      } else {
        pass.push("FF " + ffScore.toFixed(2));
      }
    }
    if (f.bsVsMine.on) {
      const myBs = toNumber(me.bs) || 0;
      if (bsEst === null || bsEst === undefined) {
        if (!f.allowUnknownStats.on) fail.push("BS unknown");
      } else if (myBs <= 0) {
        fail.push("your stats not set");
      } else if (bsEst > myBs * f.bsVsMine.value) {
        fail.push("stats " + formatNumber(bsEst) + " vs " + formatNumber(myBs));
      } else {
        pass.push("stats " + formatNumber(bsEst) + " vs " + formatNumber(myBs));
      }
    }
    if (f.maxBsEstimate.on) {
      if (bsEst === null || bsEst === undefined) {
        if (!f.allowUnknownStats.on) fail.push("BS unknown");
      } else if (bsEst > f.maxBsEstimate.value) {
        fail.push("BS " + formatNumber(bsEst));
      }
    }
    if (f.sameFaction.on && me.factionId && subject.factionId === me.factionId) {
      fail.push("your faction");
    }
    if (f.minLevel.on && subject.level !== null && subject.level < f.minLevel.value) {
      fail.push("level " + subject.level);
    }
    if (f.maxLevel.on && subject.level !== null && subject.level > f.maxLevel.value) {
      fail.push("level " + subject.level);
    }
    const myBs = toNumber(me.bs) || 0;
    let safety;
    if (bsEst && myBs > 0) {
      safety = clamp(1 - bsEst / (myBs * 3), 0, 1);
    } else if (hasStats) {
      safety = clamp(1 - ffScore / 5, 0, 1);
    } else {
      safety = .4;
    }
    const safeLoot = isFinite(loot) ? loot : 0;
    const profitTerm = clamp(Math.log10(1 + Math.abs(safeLoot)) / 7, 0, 1);
    const goods = clamp(Math.log10(1 + Math.max(0, onSaleValue || 0)) / 9, 0, 1);
    const ready = status.available ? 1 : soonOut || soonLand ? .6 : 0;
    let score = 100 * (.45 * safety + .35 * profitTerm + .1 * goods + .1 * ready);
    if (safeLoot < 0) score = -score;
    if (!isFinite(score)) score = 0;
    if (f.minScore.on && score < f.minScore.value) {
      fail.push("score " + score.toFixed(0));
    }
    const verdict = fail.length === 0 ? "match" : "reject";
    return {
      id: subject.id,
      name: subject.name,
      score: Math.round(score),
      verdict: verdict,
      reasons: fail,
      positives: pass,
      rank: status.available ? 0 : 1
    };
  }
  const ID_PATTERNS = [ /[?&#/]XID=(\d+)/gi, /[?&#/]userId=(\d+)/gi, /[?&#/]userID=(\d+)/gi, /[?&#/]uid=(\d+)/gi, /[?&#/]seller_?id=(\d+)/gi, /data-user-?id\s*=\s*["']?(\d+)/gi, /data-player\s*=\s*["']?(\d+)/gi ];
  function extractIdsFromHtml(html, opts) {
    opts = opts || {};
    const found = new Set;
    const text = String(html || "");
    ID_PATTERNS.forEach(function(re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const id = parseInt(m[1], 10);
        if (isValidPlayerId(id)) found.add(id);
      }
    });
    const profileRe = /profiles\.php(?:[?#/]+|.*?[?&#/])(\d{4,})/gi;
    let pm;
    while ((pm = profileRe.exec(text)) !== null) {
      const id = parseInt(pm[1], 10);
      if (isValidPlayerId(id)) found.add(id);
    }
    return Array.from(found);
  }
  function isValidPlayerId(id) {
    return Number.isInteger(id) && id > 0 && id <= 99999999;
  }
  function isSelf(id) {
    return !!settings.me.id && Number(id) === Number(settings.me.id);
  }
  function buildSubject(id, torn, ff, nameHint, listing, itemId) {
    const u = normaliseUser(torn);
    const status = readStatus(u.status);
    const listingUnusable = !!listing && (toNumber(listing.price) === null || toNumber(listing.qty) === null);
    if (listingUnusable) listing = null;
    const asked = torn && torn.__tbmsSelections;
    const bazaarRead = !asked || asked.indexOf("bazaar") !== -1;
    const publicBs = parseBattleStats(u.stats);
    const bazaar = summariseBazaar(u.bazaar, {
      worthyUnitPrice: settings.filters.worthyUnitPrice.on ? settings.filters.worthyUnitPrice.value : 0,
      dealDiscount: settings.filters.dealDiscount.on ? settings.filters.dealDiscount.value : 0
    });
    const listingSummary = listing ? summariseBazaar([ {
      name: listing.itemName,
      price: listing.price,
      quantity: listing.qty,
      market_price: listing.marketPrice
    } ], {
      dealDiscount: settings.filters.dealDiscount.on ? settings.filters.dealDiscount.value : 0
    }) : null;
    const itemLine = listingSummary ? null : bazaarLineFor(u.bazaar, itemId);
    const itemSummary = itemLine ? summariseBazaar(itemLine, {
      dealDiscount: settings.filters.dealDiscount.on ? settings.filters.dealDiscount.value : 0
    }) : null;
    const vault = detectVault(u.property);
    const lastAction = u.lastAction;
    const lastActionAgo = lastAction !== null ? Math.max(0, Math.floor(Date.now() / 1e3) - (lastAction >= 1e12 ? Math.floor(lastAction / 1e3) : lastAction)) : null;
    const resolvedName = u.name || nameHint || knownName(id) || "Player " + id;
    rememberName(id, resolvedName);
    const subject = {
      id: id,
      name: resolvedName,
      level: u.level,
      factionId: u.factionId,
      status: status,
      lastActionAgo: lastActionAgo,
      publicBs: publicBs,
      vault: vault,
      propertyName: propertyLabel(u.property),
      bazaar: bazaar,
      listing: listing || null,
      listingSummary: listingSummary,
      itemId: toNumber(itemId),
      itemSummary: itemSummary,
      value: listingSummary ? listingSummary.buyout : itemSummary ? itemSummary.buyout : 0,
      valueSource: listingSummary ? "listing" : itemSummary ? "bazaar line" : "none",
      valueUnknown: !(listingSummary || itemSummary),
      valueUnknownReason: listingSummary || itemSummary ? null : listingUnusable ? "the listing came back without a price and quantity" : !bazaarRead ? "Torn did not return their bazaar" : !toNumber(itemId) ? "no item selected" : "that item is not in their bazaar",
      bazaarRead: bazaarRead,
      ff: ff || {
        fairFight: null,
        bsEstimate: null,
        bsHuman: null,
        source: null
      },
      raw: torn
    };
    subject.lootDetail = lootBreakdown(subject);
    subject.loot = subject.lootDetail.net;
    subject.lootGross = subject.lootDetail.gross;
    return subject;
  }
  function buildStubSubject(id, nameHint, reason) {
    return {
      id: id,
      name: nameHint || knownName(id) || "Player " + id,
      level: null,
      factionId: 0,
      status: readStatus(null),
      lastActionAgo: null,
      publicBs: null,
      vault: {
        hasVault: null,
        vaultAmount: null
      },
      bazaar: summariseBazaar([], {}),
      listing: null,
      listingSummary: null,
      value: 0,
      valueSource: "none",
      loot: 0,
      lootGross: 0,
      lootDetail: {
        spend: 0,
        gross: 0,
        goods: 0,
        net: 0
      },
      ff: {
        fairFight: null,
        bsEstimate: null,
        bsHuman: null,
        source: null
      },
      lookupError: reason || "lookup failed",
      raw: null
    };
  }
  function screenedOutSubject(row, ff, reason, nameHint) {
    const known = ff && ff[row.id] || {};
    const subject = buildStubSubject(row.id, row && row.name || nameHint, "screened out: " + reason);
    subject.ff = {
      fairFight: toNumber(known.fairFight),
      bsEstimate: toNumber(known.bsEstimate),
      bsHuman: known.bsHuman || null,
      source: known.source || null
    };
    subject.screenedOut = true;
    return subject;
  }
  const scan = {
    running: false,
    abort: false,
    errorMessage: null,
    emptyNote: null,
    skipped: 0,
    subjects: [],
    results: [],
    seenIds: {},
    lastLabel: ""
  };
  function addSubject(subject) {
    if (!subject || scan.seenIds[subject.id]) return false;
    scan.seenIds[subject.id] = true;
    scan.subjects.push(subject);
    return true;
  }
  function resetSubjects() {
    scan.subjects = [];
    scan.seenIds = {};
  }
  const RESULTS_KEY = "results_v1";
  const RESULTS_TTL_MS = 12 * 3600 * 1e3;
  const RESULTS_CAP = 200;
  const RESULTS_SHAPE = 4;
  function slimSubject(s) {
    const slimSummary = function(sum) {
      if (!sum) return null;
      return {
        itemLines: sum.itemLines,
        count: sum.count,
        buyout: sum.buyout,
        marketValue: sum.marketValue,
        worthyCount: sum.worthyCount,
        worthyBuyout: sum.worthyBuyout,
        dealCount: sum.dealCount,
        dealBuyout: sum.dealBuyout,
        topItem: sum.topItem
      };
    };
    return {
      id: s.id,
      name: s.name,
      level: s.level,
      factionId: s.factionId,
      status: s.status,
      lastActionAgo: s.lastActionAgo,
      publicBs: s.publicBs,
      vault: s.vault,
      propertyName: s.propertyName,
      bazaar: slimSummary(s.bazaar),
      listing: s.listing,
      listingSummary: slimSummary(s.listingSummary),
      itemId: s.itemId,
      itemSummary: slimSummary(s.itemSummary),
      value: s.value,
      valueSource: s.valueSource,
      valueUnknown: s.valueUnknown,
      valueUnknownReason: s.valueUnknownReason,
      bazaarRead: s.bazaarRead,
      loot: s.loot,
      lootGross: s.lootGross,
      lootDetail: s.lootDetail,
      ff: s.ff,
      screenedOut: s.screenedOut,
      lookupError: s.lookupError
    };
  }
  let persistTimer = null;
  function schedulePersistResults() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function() {
      persistTimer = null;
      if (!scan.subjects.length) return;
      saveJSON(RESULTS_KEY, {
        v: RESULTS_SHAPE,
        at: Date.now(),
        label: scan.lastLabel || "",
        subjects: scan.subjects.slice(0, RESULTS_CAP).map(slimSubject)
      });
    }, 400);
  }
  function restoreResults() {
    const saved = loadJSON(RESULTS_KEY, null);
    if (!saved || !Array.isArray(saved.subjects) || !saved.subjects.length) return 0;
    if (saved.v !== RESULTS_SHAPE) return 0;
    if (Date.now() - (saved.at || 0) > RESULTS_TTL_MS) return 0;
    resetSubjects();
    saved.subjects.forEach(function(s) {
      if (!s || !s.id) return;
      if (s.listing && (s.listing.price == null || s.listing.qty == null)) s.listing = null;
      scan.seenIds[s.id] = true;
      scan.subjects.push(s);
    });
    scan.lastLabel = saved.label || "";
    applyVerdicts();
    return scan.subjects.length;
  }
  const auto = {
    timer: null,
    nextAt: 0,
    ticker: null
  };
  function autoIntervalMs() {
    return Math.max(10, toNumber(settings.scan.auto.intervalSec) || 120) * 1e3;
  }
  function scheduleAutoScan(delayMs) {
    if (auto.timer) clearTimeout(auto.timer);
    auto.nextAt = Date.now() + delayMs;
    auto.timer = setTimeout(async function() {
      auto.timer = null;
      if (!settings.scan.auto.on) return;
      const itemId = settings.scan.auto.itemId;
      if (!itemId) {
        stopAutoScan("No item selected for auto-scan.");
        return;
      }
      if (scan.running) {
        scheduleAutoScan(15e3);
        return;
      }
      await runItemScan(itemId, {
        background: true
      });
      if (settings.scan.auto.on) scheduleAutoScan(autoIntervalMs());
    }, Math.max(0, delayMs));
    paintAutoButton();
  }
  function startAutoScan(itemId) {
    const chosen = toNumber(itemId) || settings.scan.lastItemId || 0;
    if (!chosen) {
      setStatus("Pick an item first - auto-scan needs something to watch.", "warn");
      return;
    }
    settings.scan.auto.itemId = chosen;
    settings.scan.auto.on = true;
    settings.scan.lastItemId = chosen;
    saveSettings();
    scheduleAutoScan(0);
    setStatus("Auto-scan running for " + itemLabel(chosen) + ".", "ok");
    paintAutoButton();
  }
  function stopAutoScan(reason) {
    settings.scan.auto.on = false;
    saveSettings();
    if (auto.timer) clearTimeout(auto.timer);
    auto.timer = null;
    auto.nextAt = 0;
    paintAutoButton();
    if (reason) setStatus(reason, "warn");
  }
  function itemLabel(id) {
    return itemTable[id] ? itemTable[id] + " (#" + id + ")" : "item #" + id;
  }
  function startAutoTicker() {
    if (auto.ticker) return;
    auto.ticker = setInterval(function() {
      if (!settings.scan.auto.on || !auto.nextAt) return;
      if (scan.running) return;
      const left = Math.ceil((auto.nextAt - Date.now()) / 1e3);
      if (left > 0) {
        setStatus("Auto-scan on " + itemLabel(settings.scan.auto.itemId) + " - next scan in " + left + "s.", "progress");
      }
    }, 1e3);
  }
  function paintAutoButton() {
    const btn = document.getElementById("tbms-auto-btn");
    if (!btn) return;
    btn.textContent = settings.scan.auto.on ? "Pause auto-scan" : "Auto-scan";
    btn.classList.toggle("tbms-danger", !!settings.scan.auto.on);
    btn.classList.toggle("tbms-primary", !settings.scan.auto.on);
  }
  const WATCH_KEY = "watch_v1";
  let watchlist = loadJSON(WATCH_KEY, {});
  let watchTicker = null;
  function watchEntries() {
    return Object.keys(watchlist).map(function(k) {
      return watchlist[k];
    });
  }
  function watchSave() {
    saveJSON(WATCH_KEY, watchlist);
  }
  function watchReadyEntries() {
    return watchEntries().filter(function(e) {
      return e.ready;
    });
  }
  function watchAdd(id, name, status, note) {
    if (!id || isSelf(id)) return false;
    const existing = watchlist[id];
    const entry = existing || {
      id: id,
      addedAt: Date.now(),
      checkedAt: 0
    };
    entry.name = name || entry.name || knownName(id) || "Player " + id;
    if (status) {
      entry.state = status.state;
      entry.until = status.until || null;
    }
    if (note) entry.note = note;
    if (!existing) entry.ready = false;
    watchlist[id] = entry;
    watchSave();
    return !existing;
  }
  function watchRemove(id) {
    delete watchlist[id];
    watchSave();
    paintWatchTab();
  }
  function watchPrune() {
    const keepMs = Math.max(1, toNumber(settings.watch.keepReadyMin) || 45) * 6e4;
    const now = Date.now();
    let changed = false;
    watchEntries().forEach(function(e) {
      if (e.ready && e.readyAt && now - e.readyAt > keepMs) {
        delete watchlist[e.id];
        changed = true;
      }
    });
    if (changed) watchSave();
  }
  function watchDue(manual) {
    const now = Date.now();
    return watchEntries().filter(function(e) {
      if (manual) return true;
      if (e.ready) return !e.checkedAt || Date.now() - e.checkedAt > 3e5;
      if (!e.until) return !e.checkedAt || Date.now() - e.checkedAt > 12e4;
      if (e.until * 1e3 - Date.now() <= 9e4) return true;
      return !e.checkedAt || Date.now() - e.checkedAt > 6e5;
    }).sort(function(a, b) {
      return (a.until || 0) - (b.until || 0);
    }).slice(0, 25);
  }
  async function runWatchCheck(manual) {
    const due = watchDue(manual);
    if (!due.length) {
      if (manual) {
        setStatus(watchEntries().length ? "Nobody is due yet - they are queued for when their time is up." : "Watchlist is empty. Scan an item, or add players from the results.", "info");
      }
      return 0;
    }
    let justBack = 0;
    for (let i = 0; i < due.length; i++) {
      const entry = due[i];
      if (scan.abort && !manual) break;
      setStatus("Checking watchlist " + (i + 1) + "/" + due.length + "...", "progress");
      try {
        const res = await fetchPlayer(entry.id);
        const sub = buildSubject(entry.id, res.data, null, entry.name);
        const wasReady = !!entry.ready;
        entry.name = sub.name;
        entry.state = sub.status.state;
        entry.until = sub.status.until || null;
        entry.bazaarValue = sub.bazaar.buyout;
        entry.checkedAt = Date.now();
        entry.ready = sub.status.available;
        entry.abroad = !sub.status.inTorn;
        entry.hospital = !!sub.status.isHospital;
        if (entry.ready) {
          entry.readyAt = entry.readyAt || Date.now();
          if (!wasReady) justBack++;
        } else {
          entry.readyAt = null;
        }
        delete entry.error;
      } catch (e) {
        entry.checkedAt = Date.now();
        entry.error = e.message;
        if (e.rateLimit || e.fatal) break;
      }
    }
    watchSave();
    paintWatchTab();
    if (justBack) {
      const names = watchReadyEntries().map(function(e) {
        return e.name;
      }).slice(0, 3).join(", ");
      setStatus(justBack + " watched player(s) are back: " + names + " - ready to attack.", "ok");
    } else if (manual) {
      const stillAway = watchEntries().filter(function(e) {
        return !e.ready && e.abroad;
      }).length;
      setStatus("Checked " + due.length + " watched player(s); none are reachable" + (stillAway ? " (" + stillAway + " are abroad and count as away even out of hospital)" : "") + ".", "info");
    }
    return justBack;
  }
  function startWatchTicker() {
    if (watchTicker) return;
    const every = Math.max(15, toNumber(settings.watch.checkEverySec) || 60) * 1e3;
    watchTicker = setInterval(function() {
      if (!watchEntries().length) return;
      if (scan.running) return;
      watchPrune();
      runWatchCheck(false);
    }, every);
  }
  function autoWatchSubjects() {
    if (!settings.watch.autoAdd) return 0;
    const windowSec = Math.max(1, toNumber(settings.watch.windowMin) || 30) * 60;
    let added = 0;
    scan.subjects.forEach(function(sub) {
      if (sub.lookupError || sub.screenedOut || !sub.status || sub.status.available) return;
      const left = secondsUntilFree(sub.status);
      if (left === null || left > windowSec) return;
      const where = sub.status.inTorn ? "in " + sub.status.state.toLowerCase() : "away";
      if (watchAdd(sub.id, sub.name, sub.status, "seen during a scan, " + where)) added++;
    });
    return added;
  }
  function log(msg, kind) {
    scan.logs = scan.logs || [];
    scan.logs.push({
      at: Date.now(),
      msg: msg,
      kind: kind || "info"
    });
    if (scan.logs.length > 200) scan.logs.shift();
    setStatus(msg, kind);
  }
  function applyVerdicts() {
    scan.results = scan.subjects.map(function(subject) {
      return {
        subject: subject,
        verdict: evaluateTarget(subject, {
          settings: settings
        })
      };
    }).sort(function(a, b) {
      if (a.verdict.verdict !== b.verdict.verdict) {
        return a.verdict.verdict === "match" ? -1 : 1;
      }
      if (b.verdict.score !== a.verdict.score) {
        return b.verdict.score - a.verdict.score;
      }
      return b.subject.bazaar.buyout - a.subject.bazaar.buyout;
    });
    const matches = scan.results.filter(function(r) {
      return r.verdict.verdict === "match";
    }).length;
    renderResults();
    updateBadge(matches);
    schedulePersistResults();
    return matches;
  }
  function relevantForProperty(subject) {
    if (settings.filters.vault !== "ignore") return true;
    if (!settings.scan.fetchProperty) return false;
    const probe = evaluateTarget(subject, {
      settings: settings
    });
    if (probe.verdict === "match") return true;
    return probe.reasons.every(function(r) {
      return r === "vault unknown" || r === "no vault" || r === "has a vault";
    });
  }
  function prefilterByStrength(rows, ff) {
    const keep = [];
    const rejected = [];
    const cut = {
      tooStrong: 0,
      unknown: 0
    };
    rows.forEach(function(row) {
      const known = ff && ff[row.id] || {};
      const reason = strengthFailReason(known);
      if (reason) {
        if (reason === "no FFScouter data") cut.unknown++; else cut.tooStrong++;
        rejected.push({
          row: row,
          reason: reason
        });
        return;
      }
      keep.push(row);
    });
    return {
      keep: keep,
      rejected: rejected,
      cut: cut,
      dropped: rejected.length
    };
  }
  function strengthFailReason(known) {
    const f = settings.filters;
    const myBs = toNumber(settings.me.bs) || 0;
    const ffScore = toNumber(known && known.fairFight);
    const bsEst = toNumber(known && known.bsEstimate);
    const hasData = ffScore !== null || bsEst !== null;
    if (!hasData && !f.allowUnknownStats.on) return "no FFScouter data";
    if (f.maxFairFight.on && ffScore !== null && ffScore > f.maxFairFight.value) {
      return "fair fight " + ffScore.toFixed(2);
    }
    if (f.maxBsEstimate.on && bsEst !== null && bsEst > f.maxBsEstimate.value) {
      return "stats " + formatNumber(bsEst);
    }
    if (f.bsVsMine.on && bsEst !== null && myBs > 0 && bsEst > myBs * f.bsVsMine.value) {
      return "stats " + formatNumber(bsEst) + " vs " + formatNumber(myBs);
    }
    return null;
  }
  async function learnOwnId() {
    try {
      const me = normaliseUser(await fetchSelf());
      const id = me.id;
      if (id) {
        settings.me.id = id;
        settings.me.name = me.name || settings.me.name;
        settings.me.factionId = me.factionId || settings.me.factionId;
        saveSettings();
      }
      return id || 0;
    } catch (e) {
      log("Could not read your own player id - you may show up in your own results.", "warn");
      return 0;
    }
  }
  async function runScan(explicitIds, sourceLabel, nameHints, precomputedFf, opts) {
    if (scan.running) return;
    const s = settings;
    const listings = opts && opts.listings || {};
    const pageItemId = opts && opts.itemId || currentItemId() || 0;
    const scannedItemId = pageItemId;
    if (pageItemId && !Object.keys(listings).length) {
      try {
        const found = await findBazaarSellers(pageItemId);
        found.sellers.forEach(function(row) {
          const price = toNumber(row.price);
          const qty = toNumber(row.qty);
          if (price === null || qty === null) return;
          listings[row.id] = {
            itemId: pageItemId,
            itemName: itemTable[pageItemId] || row.name || "item " + pageItemId,
            price: price,
            qty: qty,
            marketPrice: row.marketPrice != null ? row.marketPrice : found.marketPrice
          };
        });
        if (Object.keys(listings).length) {
          log("Priced " + Object.keys(listings).length + " seller(s) on this page from " + found.source + ".", "info");
        }
      } catch (e) {
        log("Could not price this page: " + e.message, "warn");
      }
    }
    const hints = Object.assign({}, harvestNameHints(), nameHints || {});
    if (!s.api.tornKey) {
      setStatus("Add your Torn API key in Setup first.", "error");
      switchTab("setup");
      return;
    }
    if (!s.me.id) await learnOwnId();
    const ids = explicitIds && explicitIds.length ? explicitIds.slice() : harvestIds();
    const allIds = ids.filter(function(id) {
      return !isSelf(id);
    });
    if (!allIds.length) {
      setStatus("No seller links on this page. Bazaar listings and item pages name their sellers; anonymous item-market listings do not.", "warn");
      return;
    }
    const pool = allIds.slice(0, Math.max(1, s.scan.maxCandidates || 300));
    const candidates = pool;
    if (!candidates.length) {
      setStatus("No sellers found to check.", "info");
      return;
    }
    scan.running = true;
    scan.abort = false;
    scan.errorMessage = null;
    scan.skipped = 0;
    scan.lastLabel = sourceLabel || "this page";
    if (!(opts && opts.append)) resetSubjects();
    scan.results = [];
    renderResults();
    setScanningUi(true);
    try {
      log((sourceLabel ? sourceLabel + " - checking " : "Checking ") + candidates.length + " new seller(s), cheapest source first.", "info");
      setStatus("Screening " + candidates.length + " seller(s) on FFScouter...", "progress");
      const ff = precomputedFf || await ffLookup(candidates);
      const pre = prefilterByStrength(candidates.map(function(id) {
        return {
          id: id
        };
      }), ff);
      const targets = pre.keep.map(function(row) {
        return row.id;
      }).slice(0, Math.max(1, s.scan.maxTargetsPerScan));
      scan.skipped = pre.dropped;
      if (pre.dropped) {
        log("Screening removed " + pre.dropped + " of " + candidates.length + " sellers (" + pre.cut.tooStrong + " too strong, " + pre.cut.unknown + " no data) without spending a Torn request.", "info");
      }
      if (!targets.length) {
        scan.running = false;
        setScanningUi(false);
        pre.rejected.forEach(function(r) {
          addSubject(screenedOutSubject(r.row, ff, r.reason, hints[r.row.id]));
        });
        scan.emptyNote = "All " + candidates.length + " sellers were ruled out by the cheap checks (mostly too strong). " + 'Loosen "Fair fight at most" or "Stats at most mine" to see more.';
        applyVerdicts();
        setStatus("Nothing survived the strength screen.", "warn");
        return;
      }
      const queue = targets.slice();
      let done = 0;
      const retries = {};
      const workerCount = Math.max(1, Math.min(8, s.api.workers || 3));
      const workers = [];
      for (let w = 0; w < workerCount; w++) {
        workers.push(async function() {
          for (;;) {
            if (scan.abort) return;
            const id = queue.shift();
            if (id === undefined) return;
            let consumed = true;
            try {
              let torn = cacheGet(id);
              if (!torn) {
                const res = await fetchPlayer(id);
                torn = res.data;
                if (res.selections.indexOf("bazaar") !== -1) {
                  cacheSet(id, torn);
                  saveJSON(CACHE_KEY, cache);
                }
                torn.__tbmsSelections = res.selections;
              }
              addSubject(buildSubject(id, torn, ff[id], hints[id], listings[id], scannedItemId));
            } catch (e) {
              if (e.rateLimit) {
                retries[id] = (retries[id] || 0) + 1;
                const maxTries = Math.max(0, s.api.rateLimitRetries);
                if (retries[id] > maxTries) {
                  scan.errorMessage = "Torn was still rate limiting after " + maxTries + " wait(s) - stopping. Try a bigger gap between calls in Settings.";
                  log(scan.errorMessage, "error");
                  scan.abort = true;
                  return;
                }
                pauseTornQueue(Math.max(1e3, s.api.rateLimitWaitMs || 6e4));
                queue.push(id);
                consumed = false;
                continue;
              }
              if (e.fatal) {
                scan.errorMessage = e.badKey ? "Torn rejected the API key (" + e.message + ") - check it in Setup." : "Torn stopped the scan: " + e.message;
                log(scan.errorMessage, "error");
                scan.abort = true;
                return;
              }
              if (e.badId || e.tornCode === ERR_BAD_ID) {
                continue;
              }
              const why = e.tornCode === ERR_PRIVATE ? "data is private" : e.tornCode === ERR_KEY_LEVEL || e.tornCode === ERR_ACCESS ? "key level too low" : e.message;
              const stub = buildStubSubject(id, hints[id], why);
              if (listings[id]) {
                stub.listing = listings[id];
                stub.itemId = scannedItemId;
                stub.listingSummary = summariseBazaar([ {
                  name: listings[id].itemName,
                  price: listings[id].price,
                  quantity: listings[id].qty,
                  market_price: listings[id].marketPrice
                } ], {});
                stub.value = stub.listingSummary.buyout;
                stub.valueSource = "listing";
                stub.lootDetail = lootBreakdown(stub);
                stub.loot = stub.lootDetail.net;
                stub.lootGross = stub.lootDetail.gross;
              }
              addSubject(stub);
              log((hints[id] || id) + ": " + why, "warn");
            } finally {
              if (consumed) {
                done++;
                setStatus("Fetched " + done + "/" + targets.length + " players...", "progress");
              }
            }
          }
        }());
      }
      await Promise.all(workers);
      pre.rejected.forEach(function(r) {
        addSubject(screenedOutSubject(r.row, ff, r.reason, hints[r.row.id]));
      });
      applyVerdicts();
      if (s.scan.fetchProperty && !scan.abort) {
        const needs = scan.subjects.filter(function(sub) {
          return !sub.lookupError && !sub.propertyFetched && relevantForProperty(sub);
        });
        if (needs.length) {
          let doneP = 0;
          for (let i = 0; i < needs.length; i++) {
            if (scan.abort) break;
            const sub = needs[i];
            try {
              const prop = await fetchProperty(sub.id);
              sub.propertyFetched = true;
              if (prop.data) {
                sub.vault = detectVault(prop.data);
                sub.propertyName = propertyLabel(prop.data);
              }
            } catch (e) {
              sub.propertyFetched = true;
              if (e.rateLimit) {
                scan.errorMessage = "Torn rate limit reached while fetching properties.";
                break;
              }
            }
            doneP++;
            setStatus("Checked property " + doneP + "/" + needs.length + "...", "progress");
          }
        }
      }
      const matches = applyVerdicts();
      const watched = autoWatchSubjects();
      if (watched) {
        log(watched + " player(s) who will be free soon were added to the watchlist.", "ok");
        paintWatchTab();
      }
      showResultsToast();
      if (scan.errorMessage) {
        log(scan.errorMessage, "error");
      } else {
        log(matches + " buy-mug candidate(s) out of " + scan.results.length + " scanned.", "ok");
      }
    } catch (e) {
      log("Scan failed: " + e.message, "error");
    } finally {
      scan.running = false;
      setScanningUi(false);
      if (currentStatusKind === "progress" || currentStatusKind === "info") {
        setStatus("Ready.", "info");
      }
    }
  }
  function harvestIds() {
    const html = collectPageText();
    let ids = extractIdsFromHtml(html);
    const self = extractIdsFromHtml(window.location.href);
    self.forEach(function(id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });
    return ids.filter(function(id) {
      return !isSelf(id);
    });
  }
  function harvestNameHints() {
    const hints = {};
    try {
      const anchors = document.querySelectorAll("a[href]");
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const href = a.getAttribute("href") || "";
        if (!/XID=|userId=|userID=/i.test(href)) continue;
        const ids = extractIdsFromHtml(href);
        if (ids.length !== 1) continue;
        const text = (a.textContent || "").trim().replace(/\s+/g, " ");
        if (!text || text.length > 40) continue;
        if (!hints[ids[0]]) hints[ids[0]] = text;
      }
    } catch (e) {}
    return hints;
  }
  function collectPageText() {
    const parts = [];
    try {
      const anchors = document.querySelectorAll("a[href]");
      for (let i = 0; i < anchors.length; i++) {
        parts.push(anchors[i].getAttribute("href") || "");
      }
      const withData = document.querySelectorAll("[data-user-id],[data-userid],[data-player]");
      for (let i = 0; i < withData.length; i++) {
        const el = withData[i];
        const uid = el.getAttribute("data-user-id") || el.getAttribute("data-userid");
        const pid = el.getAttribute("data-player");
        if (uid) parts.push("XID=" + uid);
        if (pid) parts.push("XID=" + pid);
      }
      if (settings.scan.scanScripts) {
        const scripts = document.querySelectorAll("script:not([src])");
        for (let i = 0; i < scripts.length && i < 40; i++) {
          const t = scripts[i].textContent || "";
          if (t.length < 2e5) parts.push(t);
        }
      }
    } catch (e) {
      log("Harvest error: " + e.message, "warn");
    }
    return parts.join("\n");
  }
  let harvestTimer = null;
  function scheduleHarvest() {
    if (!settings.scan.autoHarvest) return;
    if (harvestTimer) clearTimeout(harvestTimer);
    harvestTimer = setTimeout(function() {
      const n = harvestIds().length;
      const el = document.getElementById("tbms-harvest-count");
      if (el) el.textContent = String(n);
    }, 900);
  }
  const CSS = [
    ":root{",
    "--tb-accent:#4cc2d9;--tb-accent-dim:#1d7f92;--tb-bg:#11161b;--tb-bg-alt:#161d23;",
    "--tb-bg-sunken:#0c1115;--tb-line:#242f38;--tb-line-soft:#1b242b;",
    "--tb-text:#e3ebf2;--tb-text-dim:#94a3b0;--tb-text-faint:#63727e;",
    "--tb-ok:#4ade80;--tb-warn:#fbbf24;--tb-bad:#f87171;--tb-r:9px;}",
    "#tbms-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;",
    "font-family:ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;",
    "font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;color:var(--tb-text);}",
    "#tbms-root *{box-sizing:border-box;}",
    "#tbms-root ::-webkit-scrollbar{width:9px;height:9px;}",
    "#tbms-root ::-webkit-scrollbar-track{background:transparent;}",
    "#tbms-root ::-webkit-scrollbar-thumb{background:#2b3843;border-radius:6px;",
    "border:2px solid transparent;background-clip:content-box;}",
    "#tbms-root ::-webkit-scrollbar-thumb:hover{background:#3b4c59;background-clip:content-box;}",
    "#tbms-fab{position:fixed;bottom:5px;right:8px;pointer-events:auto;cursor:pointer;",
    "width:28px;height:28px;padding:0;border-radius:5px;border:1px solid #2c3a42;",
    "background:linear-gradient(#2f9fb4,#17606f);color:#eafcff;font-size:14px;",
    "line-height:1;display:flex;align-items:center;justify-content:center;",
    "box-shadow:0 1px 3px rgba(0,0,0,.55);transition:background .12s ease;}",
    "#tbms-fab:hover{background:linear-gradient(#45bdd3,#1d7a84);}",
    "#tbms-fab.tbms-dragging{cursor:grabbing;}",
    "#tbms-badge{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;",
    "border-radius:8px;background:#16a34a;color:#fff;font-size:10px;line-height:15px;",
    "text-align:center;padding:0 5px;display:none;font-weight:600;}",
    "#tbms-badge.tbms-show{display:block;}",
    "#tbms-footer-btn{position:relative;}",
    "#tbms-footer-btn svg{display:block;}",
    "#tbms-footer-btn{background:linear-gradient(#2f9fb4,#17606f)!important;",
    "border-color:#3fb6cc!important;}",
    "#tbms-footer-btn:hover{background:linear-gradient(#45bdd3,#1d7a84)!important;}",
    ".tbms-footer-badge{position:absolute;top:-3px;right:-3px;min-width:11px;height:11px;",
    "border-radius:6px;background:#16a34a;color:#fff;font-size:8px;line-height:11px;",
    "text-align:center;padding:0 2px;font-weight:600;display:none;pointer-events:none;",
    "box-shadow:0 0 0 1px rgba(0,0,0,.55);}",
    ".tbms-footer-badge.tbms-show{display:block;}",
    "#tbms-panel{position:fixed;width:min(880px,96vw);max-height:76vh;pointer-events:auto;",
    "display:flex;flex-direction:column;",
    "background:var(--tb-bg);color:var(--tb-text);border:1px solid var(--tb-line);",
    "border-radius:var(--tb-r);overflow:hidden;",
    "box-shadow:0 24px 60px -12px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.02) inset;}",
    "#tbms-panel.tbms-hidden{display:none;}",
    "#tbms-head{display:flex;align-items:center;gap:10px;padding:9px 14px;",
    "background:var(--tb-bg-alt);border-bottom:1px solid var(--tb-line);cursor:move;",
    "user-select:none;}",
    "#tbms-head .tbms-title{font-weight:650;color:var(--tb-text);letter-spacing:-.01em;}",
    "#tbms-head .tbms-ver{color:var(--tb-text-faint);font-size:11px;}",
    "#tbms-head .tbms-spacer{flex:1;}",
    ".tbms-btn{pointer-events:auto;cursor:pointer;background:#1c242c;color:var(--tb-text);",
    "border:1px solid var(--tb-line);border-radius:7px;padding:5px 11px;font-size:12px;",
    "font-family:inherit;font-weight:500;white-space:nowrap;transition:background .12s ease,",
    "border-color .12s ease,color .12s ease;}",
    ".tbms-btn:hover{background:#232e37;border-color:#33414c;}",
    ".tbms-btn:active{transform:translateY(1px);}",
    ".tbms-btn.tbms-primary{background:var(--tb-accent-dim);border-color:#2a94a8;",
    "color:#f2fdff;font-weight:600;}",
    ".tbms-btn.tbms-primary:hover{background:#228ea3;border-color:#3fb6cc;}",
    ".tbms-btn.tbms-danger{color:#fca5a5;border-color:#4b2f33;background:#221a1c;}",
    ".tbms-btn.tbms-danger:hover{background:#2d2023;border-color:#7a3b3b;}",
    ".tbms-btn[disabled]{opacity:.4;cursor:not-allowed;}",
    ".tbms-btn[disabled]:hover{background:#1c242c;border-color:var(--tb-line);}",
    "#tbms-tabs{display:flex;gap:2px;padding:5px 10px 0;background:var(--tb-bg-alt);}",
    ".tbms-tab{cursor:pointer;background:transparent;border:1px solid transparent;",
    "border-bottom:none;color:var(--tb-text-dim);padding:5px 12px;border-radius:7px 7px 0 0;",
    "font-size:12px;font-family:inherit;font-weight:500;transition:color .12s ease,background .12s ease;}",
    ".tbms-tab:hover{color:var(--tb-text);}",
    ".tbms-tab.tbms-active{background:var(--tb-bg);color:var(--tb-accent);border-color:var(--tb-line);",
    "font-weight:600;}",
    ".tbms-tab.tbms-tab-alert{color:var(--tb-ok);}",
    ".tbms-tab.tbms-tab-alert:after{content:\"\";display:inline-block;width:6px;height:6px;",
    "border-radius:50%;background:var(--tb-ok);margin-left:6px;vertical-align:middle;",
    "box-shadow:0 0 6px rgba(74,222,128,.8);}",
    "#tbms-body{overflow:auto;padding:14px;flex:1 1 auto;min-height:0;}",
    ".tbms-sec{margin-bottom:16px;}",
    ".tbms-sec h4{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.02em;",
    "color:var(--tb-text-faint);}",
    ".tbms-row{display:flex;align-items:center;gap:9px;padding:4px 0;flex-wrap:nowrap;",
    "min-height:28px;}",
    ".tbms-row label.tbms-label{flex:1 1 auto;min-width:0;color:var(--tb-text);cursor:pointer;",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}",
    ".tbms-row label.tbms-label:hover{color:var(--tb-accent);}",
    ".tbms-hint{color:var(--tb-text-faint);font-size:11.5px;line-height:1.5;}",
    ".tbms-num{width:104px;flex:0 0 auto;background:var(--tb-bg-sunken);color:var(--tb-text);",
    "border:1px solid var(--tb-line);border-radius:6px;padding:4px 7px;font-size:12px;",
    "font-family:inherit;font-variant-numeric:tabular-nums;transition:border-color .12s ease,box-shadow .12s ease;}",
    ".tbms-num:focus,.tbms-text:focus{outline:none;border-color:var(--tb-accent-dim);",
    "box-shadow:0 0 0 3px rgba(76,194,217,.14);}",
    ".tbms-num:disabled{opacity:.45;}",
    ".tbms-row .tbms-suffix{flex:0 0 auto;color:var(--tb-text-faint);font-size:11.5px;}",
    ".tbms-text{width:100%;background:var(--tb-bg-sunken);border:1px solid var(--tb-line);",
    "color:var(--tb-text);border-radius:6px;padding:6px 10px;font-size:12.5px;font-family:inherit;",
    "transition:border-color .12s ease,box-shadow .12s ease;}",
    ".tbms-text::placeholder{color:#4d5a66;}",
    ".tbms-masked{-webkit-text-security:disc;text-security:disc;",
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:2px;}",
    ".tbms-masked::placeholder{-webkit-text-security:none;text-security:none;",
    "letter-spacing:normal;font-family:inherit;}",
    ".tbms-switch{position:relative;flex:0 0 auto;width:34px;min-width:34px;height:20px;",
    "margin:0;display:inline-block;}",
    ".tbms-switch input{opacity:0;width:0;height:0;position:absolute;}",
    ".tbms-slider{position:absolute;inset:0;background:#2a3640;border-radius:10px;",
    "transition:background .16s ease;cursor:pointer;}",
    ".tbms-slider:before{content:\"\";position:absolute;width:14px;height:14px;left:3px;top:3px;",
    "background:#8496a4;border-radius:50%;transition:transform .16s ease,background .16s ease;",
    "box-shadow:0 1px 2px rgba(0,0,0,.4);}",
    ".tbms-switch input:checked+.tbms-slider{background:var(--tb-accent-dim);}",
    ".tbms-switch input:checked+.tbms-slider:before{transform:translateX(14px);background:#eafcff;}",
    "details.tbms-adv{border:1px solid var(--tb-line-soft);border-radius:8px;padding:0 12px;",
    "margin:0 0 12px;background:rgba(255,255,255,.012);}",
    "details.tbms-adv>summary{cursor:pointer;padding:9px 0;color:var(--tb-text-dim);font-size:11.5px;",
    "font-weight:600;list-style:none;outline:none;}",
    "details.tbms-adv>summary::-webkit-details-marker{display:none;}",
    "details.tbms-adv>summary:hover{color:var(--tb-text);}",
    "details.tbms-adv>summary:before{content:\"\\25B8\";display:inline-block;width:14px;",
    "color:var(--tb-text-faint);transition:transform .15s ease;}",
    "details.tbms-adv[open]>summary:before{transform:rotate(90deg);}",
    "details.tbms-adv[open]{padding-bottom:10px;}",
    "table.tbms-table{width:100%;border-collapse:collapse;font-size:12px;",
    "font-variant-numeric:tabular-nums;table-layout:fixed;}",
    "table.tbms-table th{position:sticky;top:0;background:var(--tb-bg-alt);color:var(--tb-text-dim);",
    "text-align:left;padding:7px 8px;border-bottom:1px solid var(--tb-line);cursor:pointer;",
    "white-space:nowrap;font-size:11px;font-weight:600;letter-spacing:.02em;user-select:none;}",
    "table.tbms-table th:hover{color:var(--tb-accent);}",
    "table.tbms-table td{padding:6px 8px;border-bottom:1px solid var(--tb-line-soft);",
    "vertical-align:top;white-space:nowrap;color:var(--tb-text);overflow:hidden;",
    "text-overflow:ellipsis;max-width:220px;}",
    "table.tbms-table td.tbms-accent{padding-left:12px;}",
    "table.tbms-table td.tbms-wrap{white-space:normal;min-width:132px;}",
    "table.tbms-table td.tbms-wrap .tbms-pill{white-space:normal;display:inline-block;}",
    "table.tbms-table tbody tr{transition:background .1s ease;}",
    "table.tbms-table tr.tbms-match{background:rgba(74,222,128,.055);}",
    "table.tbms-table tr.tbms-match td.tbms-accent,",
    "table.tbms-table tr.tbms-match td:first-child{box-shadow:inset 3px 0 0 var(--tb-ok);}",
    "table.tbms-table tr.tbms-reject{opacity:.62;}",
    "table.tbms-table tbody tr:hover{background:rgba(76,194,217,.07);opacity:1;}",
    ".tbms-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;",
    "font-weight:550;border:1px solid var(--tb-line);color:var(--tb-text-dim);",
    "background:rgba(255,255,255,.03);}",
    ".tbms-pill.tbms-ok{border-color:rgba(74,222,128,.35);color:#86efac;",
    "background:rgba(74,222,128,.1);}",
    ".tbms-pill.tbms-bad{border-color:rgba(248,113,113,.35);color:#fca5a5;",
    "background:rgba(248,113,113,.1);}",
    ".tbms-pill.tbms-warn{border-color:rgba(251,191,36,.32);color:#fcd34d;",
    "background:rgba(251,191,36,.1);}",
    ".tbms-link{color:var(--tb-accent);text-decoration:none;font-weight:500;}",
    ".tbms-link:hover{text-decoration:underline;}",
    "#tbms-foot{border-top:1px solid var(--tb-line);padding:9px 14px;background:var(--tb-bg-alt);",
    "font-size:11.5px;color:var(--tb-text-dim);display:flex;gap:10px;align-items:center;",
    "min-height:34px;}",
    "#tbms-foot.tbms-err{color:#fca5a5;}",
    "#tbms-foot.tbms-warn{color:#fcd34d;}",
    "#tbms-foot.tbms-ok{color:#86efac;}",
    "#tbms-foot.tbms-progress{color:var(--tb-accent);}",
    ".tbms-empty{padding:30px 22px;text-align:center;color:var(--tb-text-faint);font-size:12.5px;}",
    ".tbms-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:12px;",
    "color:var(--tb-text-dim);}",
    ".tbms-kv b{color:var(--tb-text);font-weight:500;}",
    "#tbms-suggest{border-radius:8px!important;}",
    ".tbms-suggest-row{font-size:12.5px!important;border-bottom:1px solid var(--tb-line-soft);}",
    ".tbms-suggest-row:last-child{border-bottom:none;}",
    ".tbms-suggest-row:hover{background:#1f2b34!important;}",
    "#tbms-toasts{position:fixed;right:14px;bottom:44px;z-index:2147483001;",
    "display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;}",
    ".tbms-toast{pointer-events:auto;position:relative;width:296px;max-width:92vw;",
    "background:var(--tb-bg-alt);border:1px solid var(--tb-line);border-left:3px solid var(--tb-ok);",
    "border-radius:10px;padding:10px 12px 9px;color:var(--tb-text);font-size:12px;",
    "box-shadow:0 14px 34px -10px rgba(0,0,0,.75);animation:tbms-toast-in .18s ease-out;}",
    "@keyframes tbms-toast-in{from{transform:translateY(10px)}to{transform:translateY(0)}}",
    ".tbms-toast-head{display:flex;align-items:baseline;gap:6px;margin:0 18px 2px 0;",
    "font-weight:650;color:var(--tb-text);}",
    ".tbms-toast-sub{color:var(--tb-text-faint);font-size:11px;margin:0 18px 6px 0;",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".tbms-toast-close{position:absolute;top:2px;right:4px;background:none;border:none;",
    "color:var(--tb-text-faint);font-size:17px;line-height:1;cursor:pointer;padding:2px 5px;",
    "border-radius:4px;}",
    ".tbms-toast-close:hover{color:var(--tb-text);background:#232e37;}",
    ".tbms-toast-row{display:flex;align-items:center;gap:6px;padding:5px 0;",
    "border-top:1px solid var(--tb-line-soft);}",
    ".tbms-toast-who{flex:1 1 auto;min-width:0;}",
    ".tbms-toast-name{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;}",
    ".tbms-toast-meta{display:block;color:var(--tb-text-faint);font-size:10.5px;",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".tbms-toast-btn{font:inherit;font-size:10.5px;padding:3px 7px;border-radius:6px;",
    "border:1px solid var(--tb-line);background:#1c242c;color:var(--tb-text);cursor:pointer;",
    "text-decoration:none;white-space:nowrap;}",
    ".tbms-toast-btn:hover{background:#232e37;border-color:#33414c;}",
    ".tbms-toast-btn.tbms-toast-attack{background:#7d2f33;border-color:#9c3a40;color:#ffe9ea;",
    "font-weight:650;}",
    ".tbms-toast-btn.tbms-toast-attack:hover{background:#93383d;}",
    ".tbms-toast-foot{display:flex;gap:6px;align-items:center;margin-top:7px;",
    "padding-top:7px;border-top:1px solid var(--tb-line-soft);}",
    ".tbms-toast-more{flex:1 1 auto;color:var(--tb-text-faint);font-size:10.5px;}",
    ".tbms-tip{margin-top:8px;padding:7px 9px;border-radius:7px;font-size:11.5px;",
    "color:#e8d9a0;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.28);}",
  ].join("");
  function injectStyle() {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(CSS);
      return;
    }
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function(k) {
        if (k === "class") node.className = attrs[k]; else if (k === "text") node.textContent = attrs[k]; else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2), attrs[k]);
        } else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function(c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  const MAIN_GROUPS = [ {
    title: "Where they are",
    items: [ {
      type: "toggle",
      path: "filters.inTornOnly",
      label: "In Torn, not abroad",
      hint: "Drops anyone shown as Abroad or Travelling. You cannot mug someone who is out of the country."
    }, {
      type: "toggle",
      path: "filters.notHospitalised",
      label: "Not hospitalised or jailed",
      hint: "You cannot mug someone who is already locked up."
    }, {
      type: "toggleNumber",
      path: "filters.notActiveWithin",
      label: "Not active within",
      suffix: "min",
      hint: "Keeps players who have not acted inside this window. A seller who just moved is likely watching their own bazaar."
    }, {
      type: "toggleNumber",
      path: "filters.soonInTorn",
      label: "Or landing within",
      suffix: "min",
      hint: "Abroad and travelling players are allowed through when they land inside this window - you can be waiting on the tarmac for them. 0 disables it."
    }, {
      type: "toggleNumber",
      path: "filters.soonOutOfHospital",
      label: "Or released within",
      suffix: "min",
      hint: "Hospitalised, jailed and federal players are allowed through when they get out inside this window. 0 disables it."
    } ]
  }, {
    title: "What they are carrying",
    items: [ {
      type: "toggleNumber",
      path: "filters.minBazaarValue",
      label: "Value on sale at least",
      hint: "What you would spend buying the item you searched for from this seller: their price x their quantity, in their bazaar or on the item market."
    }, {
      type: "select",
      path: "filters.vault",
      label: "Property vault",
      options: [ [ "ignore", "Ignore" ], [ "exclude", "Skip vault owners" ], [ "require", "Only vault owners" ] ],
      hint: 'A vault keeps cash out of reach and usually means a more careful player. "Unknown" counts as not having one.'
    }, {
      type: "toggleNumber",
      path: "filters.minLoot",
      label: "Net profit at least",
      hint: "(market value per item - their price per item) x quantity, plus the mug. Buying under market gains on every item and buying over it loses on every item, so this catches both without a separate price rule."
    } ]
  }, {
    title: "How strong they are",
    items: [ {
      type: "toggleNumber",
      path: "filters.maxFairFight",
      label: "Fair fight at most",
      step: "0.1",
      hint: "Lower is safer. Below 1 is usually a comfortable win."
    }, {
      type: "toggleNumber",
      path: "filters.bsVsMine",
      label: "Stats at most mine ×",
      step: "0.1",
      hint: "Their FFScouter estimate against your own stats. 1.0 means they look no stronger than you. Load your stats in Setup first."
    } ]
  } ];
  const ADVANCED_GROUPS = [ {
    title: "Money & stock detail",
    items: [ {
      type: "toggleNumber",
      path: "filters.minItemCount",
      label: "At least this many items",
      hint: "Counts quantity, not listings."
    }, {
      type: "toggleNumber",
      path: "filters.minWorthyItems",
      label: 'At least this many "worthy" items',
      hint: "Items priced at or above the worthy-unit-price below."
    }, {
      type: "toggleNumber",
      path: "filters.worthyUnitPrice",
      label: 'An item is "worthy" from',
      hint: "Per-unit price threshold that decides what is worth buying."
    }, {
      type: "toggleNumber",
      path: "filters.minDealCount",
      label: "At least this many items under market",
      hint: "Items priced below market by the discount below."
    }, {
      type: "toggleNumber",
      path: "filters.dealDiscount",
      label: "Discount that counts as a deal",
      step: "0.01",
      hint: "0.15 means 15% under the going rate."
    } ]
  }, {
    title: "Strength detail",
    items: [ {
      type: "toggleNumber",
      path: "filters.maxBsEstimate",
      label: "Estimated stats at most",
      hint: "An absolute ceiling, independent of your own stats."
    }, {
      type: "toggle",
      path: "filters.allowUnknownStats",
      label: "Include players with no FFScouter data",
      hint: "Turn this off for a strictly vetted shortlist."
    }, {
      type: "toggleNumber",
      path: "filters.minScore",
      label: "Scout score at least",
      hint: "The 0-100 blend of safety, cash and stock shown in the results."
    } ]
  }, {
    title: "Exclusions",
    items: [ {
      type: "toggle",
      path: "filters.sameFaction",
      label: "Skip my own faction"
    }, {
      type: "toggleNumber",
      path: "filters.minLevel",
      label: "Level at least"
    }, {
      type: "toggleNumber",
      path: "filters.maxLevel",
      label: "Level at most"
    } ]
  } ];
  function getPath(path) {
    const parts = path.split(".");
    let cur = settings;
    for (let i = 0; i < parts.length; i++) cur = cur[parts[i]];
    return cur;
  }
  function setPath(path, value) {
    const parts = path.split(".");
    let cur = settings;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
    saveSettings();
  }
  function buildControl(item) {
    const wrap = el("div", {
      class: "tbms-row"
    });
    let numInput = null;
    let switchInput = null;
    if (item.type === "toggle" || item.type === "toggleNumber") {
      const node = getPath(item.path);
      const switchWrap = el("label", {
        class: "tbms-switch"
      });
      const input = el("input", {
        type: "checkbox"
      });
      input.checked = !!node.on;
      input.addEventListener("change", function() {
        node.on = input.checked;
        saveSettings();
        if (item.type === "toggleNumber" && numInput) numInput.disabled = !input.checked;
      });
      switchWrap.appendChild(input);
      switchWrap.appendChild(el("span", {
        class: "tbms-slider"
      }));
      wrap.appendChild(switchWrap);
      switchInput = input;
    }
    const label = el("label", {
      class: "tbms-label",
      text: item.label
    });
    if (item.hint) label.title = item.hint;
    label.addEventListener("click", function(e) {
      if (!switchInput) return;
      e.preventDefault();
      switchInput.checked = !switchInput.checked;
      switchInput.dispatchEvent(new Event("change", {
        bubbles: true
      }));
    });
    wrap.appendChild(label);
    if (item.type === "toggleNumber") {
      numInput = el("input", {
        class: "tbms-num",
        type: "number",
        step: item.step || "1"
      });
      numInput.value = getPath(item.path).value;
      numInput.disabled = !getPath(item.path).on;
      numInput.addEventListener("change", function() {
        const v = Number(numInput.value);
        getPath(item.path).value = isFinite(v) ? v : 0;
        saveSettings();
      });
      wrap.appendChild(numInput);
      if (item.suffix) wrap.appendChild(el("span", {
        class: "tbms-suffix",
        text: item.suffix
      }));
    }
    if (item.type === "select") {
      const sel = el("select", {
        class: "tbms-num"
      });
      sel.style.width = "auto";
      item.options.forEach(function(pair) {
        const o = el("option", {
          value: pair[0],
          text: pair[1]
        });
        if (getPath(item.path) === pair[0]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function() {
        setPath(item.path, sel.value);
      });
      wrap.appendChild(sel);
    }
    return wrap;
  }
  let panel = null;
  const FOOTER_ICON = [ '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" CLASS>', '<defs><linearGradient id="tbms_icon_grad" x1="0.5" x2="0.5" y2="1"', ' gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#f2fbfd"/>', '<stop offset="1" stop-color="#b9dde6"/></linearGradient></defs>', '<g fill="url(#tbms_icon_grad)">', '<path d="M9.4 2.6h5.2l-.9 2.2h-3.4z"/>', '<path d="M12 5.4c-3.7 0-6.6 3.9-6.6 8.3 0 4.4 2.8 7.7 6.6 7.7s6.6-3.3 6.6-7.7c0-4.4-2.9-8.3-6.6-8.3Zm0 3.1a1.5 1.5 0 0 1 1.5 1.5c.9.3 1.5 1 1.5 1.9h-1.4c0-.5-.7-.9-1.6-.9s-1.6.4-1.6.9.7.8 1.6.9c1.4.2 3 .7 3 2.3 0 .9-.6 1.7-1.5 2v1h-1.5v-1c-.9-.3-1.5-1.1-1.5-2h1.4c0 .5.7 1 1.6 1s1.6-.4 1.6-.9-.7-.8-1.6-.9c-1.4-.2-3-.7-3-2.2 0-.9.6-1.7 1.5-2a1.5 1.5 0 0 1 1.1-2.6Z"/>', "</g>", "</svg>" ].join("");
  function findFooterRefBtn() {
    for (let i = 0; i < FOOTER_REF_IDS.length; i++) {
      const el = document.getElementById(FOOTER_REF_IDS[i]);
      if (el && el.parentNode) return el;
    }
    return null;
  }
  function buildFooterButton(refBtn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = FOOTER_BTN_ID;
    btn.className = refBtn.className || "";
    btn.title = "Buy-Mug Scout";
    const iconClass = refBtn.querySelector("svg") ? refBtn.querySelector("svg").getAttribute("class") || "" : "";
    btn.innerHTML = FOOTER_ICON.replace("CLASS", iconClass ? 'class="' + iconClass + '"' : "");
    const badge = document.createElement("span");
    badge.id = "tbms-footer-badge";
    badge.className = "tbms-footer-badge";
    btn.appendChild(badge);
    btn.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      settings.ui.open = !settings.ui.open;
      saveSettings();
      syncPanelVisibility();
    });
    return btn;
  }
  function mountFooterButton() {
    const refBtn = findFooterRefBtn();
    const existing = document.getElementById(FOOTER_BTN_ID);
    if (!refBtn) {
      if (existing) existing.remove();
      showFab(true);
      return;
    }
    showFab(false);
    if (existing && existing.parentNode === refBtn.parentNode) return;
    if (existing) existing.remove();
    refBtn.parentNode.insertBefore(buildFooterButton(refBtn), refBtn);
  }
  function showFab(show) {
    const fab = document.getElementById("tbms-fab");
    if (fab) fab.style.display = show ? "flex" : "none";
  }
  function watchFooter() {
    let pending = false;
    const soon = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame.bind(window) : function(fn) {
      setTimeout(fn, 16);
    };
    const obs = new MutationObserver(function() {
      if (pending) return;
      pending = true;
      soon(function() {
        pending = false;
        mountFooterButton();
      });
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  function applyFabPos() {
    const fab = document.getElementById("tbms-fab");
    if (!fab) return;
    const pos = settings.ui.fabPos;
    if (!pos) {
      fab.style.left = "";
      fab.style.top = "";
      fab.style.right = "";
      fab.style.bottom = "";
      return;
    }
    fab.style.left = pos.left + "px";
    fab.style.top = pos.top + "px";
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  }
  function makeDraggable(fab) {
    const SIZE = 28;
    let drag = null;
    fab.addEventListener("mousedown", function(e) {
      if (e.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      drag = {
        x: e.clientX,
        y: e.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      e.preventDefault();
    });
    document.addEventListener("mousemove", function(e) {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      fab.classList.add("tbms-dragging");
      fab.style.left = clamp(drag.left + dx, 0, window.innerWidth - SIZE) + "px";
      fab.style.top = clamp(drag.top + dy, 0, window.innerHeight - SIZE) + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    });
    document.addEventListener("mouseup", function() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      fab.classList.remove("tbms-dragging");
      if (!moved) {
        settings.ui.open = !settings.ui.open;
        saveSettings();
        syncPanelVisibility();
        return;
      }
      const rect = fab.getBoundingClientRect();
      settings.ui.fabPos = {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      };
      saveSettings();
      if (settings.ui.open) positionPanel();
    });
  }
  function openerRect() {
    const btn = document.getElementById(FOOTER_BTN_ID);
    const fab = document.getElementById("tbms-fab");
    const target = btn && btn.offsetParent !== null ? btn : fab && fab.style.display !== "none" ? fab : null;
    return target ? target.getBoundingClientRect() : null;
  }
  function applyPanelGeom() {
    if (!panel) return;
    const size = settings.ui.panelSize;
    if (size) {
      panel.style.width = Math.max(360, size.w) + "px";
      panel.style.height = Math.max(260, size.h) + "px";
      panel.style.maxHeight = "none";
    } else {
      panel.style.width = "";
      panel.style.height = "";
      panel.style.maxHeight = "";
    }
  }
  function positionPanel() {
    if (!panel) return;
    applyPanelGeom();
    const saved = settings.ui.panelPos;
    if (saved) {
      const w = panel.offsetWidth || 700;
      const h = panel.offsetHeight || 400;
      panel.style.left = clamp(saved.left, 0, Math.max(0, window.innerWidth - w)) + "px";
      panel.style.top = clamp(saved.top, 0, Math.max(0, window.innerHeight - 40)) + "px";
      return;
    }
    const r = openerRect();
    if (!r) {
      panel.style.left = Math.max(6, window.innerWidth - 706) + "px";
      panel.style.top = "40px";
      return;
    }
    const w = panel.offsetWidth || Math.min(PANEL_W, window.innerWidth * .96);
    const h = panel.offsetHeight || 400;
    const left = clamp(r.right - w, 6, Math.max(6, window.innerWidth - w - 6));
    let top = r.top - h - 8;
    if (top < 6) top = Math.min(r.bottom + 8, Math.max(6, window.innerHeight - h - 6));
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }
  function makePanelDraggable() {
    const head = panel.querySelector("#tbms-head");
    let drag = null;
    head.addEventListener("mousedown", function(e) {
      if (e.button !== 0) return;
      if (e.target.closest("button, a, input, select")) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        x: e.clientX,
        y: e.clientY,
        left: rect.left,
        top: rect.top
      };
      head.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function(e) {
      if (!drag) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const left = clamp(drag.left + (e.clientX - drag.x), -w + 80, window.innerWidth - 80);
      const top = clamp(drag.top + (e.clientY - drag.y), 0, window.innerHeight - 30);
      panel.style.left = Math.round(left) + "px";
      panel.style.top = Math.round(top) + "px";
      e.preventDefault();
    });
    document.addEventListener("mouseup", function() {
      if (!drag) return;
      drag = null;
      head.style.cursor = "";
      const rect = panel.getBoundingClientRect();
      settings.ui.panelPos = {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      };
      saveSettings();
    });
  }
  function makePanelResizable() {
    const grip = el("div", {
      id: "tbms-grip",
      title: "Drag to resize",
      style: "position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;" + "background:linear-gradient(135deg,transparent 45%,#4b5f6b 45%,#4b5f6b 58%,transparent 58%," + "transparent 70%,#4b5f6b 70%,#4b5f6b 83%,transparent 83%);z-index:5;"
    });
    panel.appendChild(grip);
    let drag = null;
    grip.addEventListener("mousedown", function(e) {
      if (e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        x: e.clientX,
        y: e.clientY,
        w: rect.width,
        h: rect.height
      };
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener("mousemove", function(e) {
      if (!drag) return;
      panel.style.width = Math.max(360, drag.w + (e.clientX - drag.x)) + "px";
      panel.style.height = Math.max(260, drag.h + (e.clientY - drag.y)) + "px";
      e.preventDefault();
    });
    document.addEventListener("mouseup", function() {
      if (!drag) return;
      drag = null;
      const rect = panel.getBoundingClientRect();
      settings.ui.panelSize = {
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      };
      saveSettings();
    });
  }
  function buildPanel() {
    const root = el("div", {
      id: "tbms-root"
    });
    const fab = el("button", {
      id: "tbms-fab",
      title: "Buy-Mug Scout - click to open, drag to move"
    });
    fab.appendChild(document.createTextNode("◎"));
    const badge = el("span", {
      id: "tbms-badge"
    });
    fab.appendChild(badge);
    makeDraggable(fab);
    root.appendChild(fab);
    panel = el("div", {
      id: "tbms-panel"
    });
    const head = el("div", {
      id: "tbms-head"
    });
    head.appendChild(el("span", {
      class: "tbms-title",
      text: "Buy-Mug Scout by " + AUTHOR_NAME + " [" + AUTHOR_ID + "]"
    }));
    head.appendChild(el("span", {
      class: "tbms-ver",
      text: "v" + VERSION
    }));
    head.appendChild(el("span", {
      class: "tbms-spacer"
    }));
    const closeBtn = el("button", {
      class: "tbms-btn",
      text: "Close"
    });
    closeBtn.addEventListener("click", function() {
      settings.ui.open = false;
      saveSettings();
      syncPanelVisibility();
    });
    head.appendChild(closeBtn);
    panel.appendChild(head);
    const tabs = el("div", {
      id: "tbms-tabs"
    });
    [ [ "scan", "Scan" ], [ "filters", "Filters" ], [ "results", "Results" ], [ "watch", "Watch" ], [ "setup", "Setup" ] ].forEach(function(pair) {
      const btn = el("button", {
        class: "tbms-tab",
        "data-tab": pair[0],
        text: pair[1],
        onclick: function() {
          switchTab(pair[0]);
        }
      });
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);
    const body = el("div", {
      id: "tbms-body"
    });
    [ "scan", "filters", "results", "watch", "setup" ].forEach(function(name) {
      body.appendChild(el("section", {
        class: "tbms-section",
        "data-tab": name
      }));
    });
    panel.appendChild(body);
    panel.appendChild(el("div", {
      id: "tbms-foot",
      text: "Ready."
    }));
    root.appendChild(panel);
    document.body.appendChild(root);
    renderScanTab();
    renderFiltersTab();
    renderResults();
    renderWatchTab();
    renderSetupTab();
    applyFabPos();
    mountFooterButton();
    makePanelDraggable();
    makePanelResizable();
    applyPanelGeom();
    switchTab(settings.ui.tab || "scan");
    syncPanelVisibility();
    updateBadge(0);
  }
  function section(name) {
    return panel.querySelector('section[data-tab="' + name + '"]');
  }
  function switchTab(name) {
    settings.ui.tab = name;
    saveSettings();
    Array.prototype.forEach.call(panel.querySelectorAll(".tbms-tab"), function(t) {
      t.classList.toggle("tbms-active", t.getAttribute("data-tab") === name);
    });
    Array.prototype.forEach.call(panel.querySelectorAll("section[data-tab]"), function(s) {
      s.style.display = s.getAttribute("data-tab") === name ? "block" : "none";
    });
    if (name === "watch") renderWatchTab();
  }
  let currentStatusKind = "info";
  function syncPanelVisibility() {
    if (!panel) return;
    panel.classList.toggle("tbms-hidden", !settings.ui.open);
    if (settings.ui.open) positionPanel();
  }
  function setStatus(msg, kind) {
    const foot = document.getElementById("tbms-foot");
    if (!foot) return;
    foot.textContent = msg;
    foot.className = kind ? "tbms-" + kind : "";
    currentStatusKind = kind || "info";
  }
  function updateBadge(n) {
    [ "tbms-badge", "tbms-footer-badge" ].forEach(function(id) {
      const b = document.getElementById(id);
      if (!b) return;
      b.textContent = String(n);
      b.classList.toggle("tbms-show", n > 0);
    });
  }
  function setScanningUi(running) {
    const scanBtn = document.getElementById("tbms-scan-btn");
    const itemBtn = document.getElementById("tbms-item-scan-btn");
    const stopBtn = document.getElementById("tbms-stop-btn");
    if (scanBtn) scanBtn.disabled = running;
    if (itemBtn) itemBtn.disabled = running || !Object.keys(itemTable).length;
    if (stopBtn) stopBtn.disabled = !running;
  }
  function renderScanTab() {
    const s = section("scan");
    s.innerHTML = "";
    s.appendChild(el("div", {
      class: "tbms-hint",
      style: "margin-bottom:8px;",
      text: "Pick an item and the script asks Torn for every bazaar seller listing it - no page reading, works from any Torn page. Read-only."
    }));
    const itemRow = el("div", {
      id: "tbms-item-row",
      class: "tbms-row",
      style: "position:relative;"
    });
    const itemInput = el("input", {
      class: "tbms-text",
      id: "tbms-item-input",
      placeholder: "item name or id",
      autocomplete: "off",
      spellcheck: "false"
    });
    itemInput.style.flex = "1 1 auto";
    itemRow.appendChild(itemInput);
    const itemBtn = el("button", {
      id: "tbms-item-scan-btn",
      class: "tbms-btn tbms-primary",
      text: "Scan bazaars"
    });
    itemBtn.addEventListener("click", async function() {
      const id = await resolveItemId(itemInput.value, itemInput.getAttribute("data-item-id"));
      if (!id) {
        setStatus(Object.keys(itemTable).length ? 'No item matched "' + itemInput.value.trim() + '". Pick one from the list.' : "Item list not loaded yet - you can still type an item id.", "warn");
        openItemSuggestions();
        return;
      }
      hideItemSuggestions();
      settings.scan.lastItemId = id;
      saveSettings();
      runItemScan(id);
    });
    itemRow.appendChild(itemBtn);
    const autoBtn = el("button", {
      id: "tbms-auto-btn",
      class: "tbms-btn tbms-primary",
      text: "Auto-scan",
      title: "Keep re-checking this item’s bazaar sellers in the background. The on/paused state is saved, so it survives a refresh."
    });
    autoBtn.addEventListener("click", async function() {
      if (settings.scan.auto.on) {
        stopAutoScan("Auto-scan paused. It stays paused after a refresh.");
        return;
      }
      const id = await resolveItemId(itemInput.value, itemInput.getAttribute("data-item-id"));
      startAutoScan(id);
    });
    itemRow.appendChild(autoBtn);
    const suggestions = el("div", {
      id: "tbms-item-suggest",
      style: "display:none;position:absolute;top:100%;left:0;right:0;z-index:20;" + "max-height:190px;overflow:auto;background:#0d1216;border:1px solid #33434c;" + "border-radius:4px;box-shadow:0 8px 20px rgba(0,0,0,.6);"
    });
    s.appendChild(itemRow);
    itemRow.appendChild(suggestions);
    let matches = [];
    let activeIndex = -1;
    function hideItemSuggestions() {
      suggestions.style.display = "none";
      activeIndex = -1;
    }
    function paintSuggestions() {
      suggestions.innerHTML = "";
      matches.forEach(function(row, i) {
        const opt = el("div", {
          class: "tbms-suggest-row",
          style: "padding:4px 8px;cursor:pointer;font-size:12px;" + (i === activeIndex ? "background:#1f6f7d;color:#eafcff;" : "color:#c3d3db;"),
          text: row.name + "  #" + row.id
        });
        opt.addEventListener("mousedown", function(e) {
          e.preventDefault();
          choose(row);
        });
        suggestions.appendChild(opt);
      });
      suggestions.style.display = matches.length ? "block" : "none";
    }
    function choose(row) {
      itemInput.value = row.name;
      itemInput.setAttribute("data-item-id", String(row.id));
      hideItemSuggestions();
      setStatus("Selected " + row.name + " (#" + row.id + "). Press the button to scan it.", "info");
    }
    function updateSuggestions() {
      const q = itemInput.value.trim().toLowerCase();
      itemInput.removeAttribute("data-item-id");
      if (!q) {
        matches = [];
        hideItemSuggestions();
        return;
      }
      if (!Object.keys(itemTable).length) {
        ensureItemTable().then(function(items) {
          if (Object.keys(items).length && itemInput.value.trim()) updateSuggestions();
        });
      }
      matches = searchItems(q, 8);
      activeIndex = matches.length ? 0 : -1;
      paintSuggestions();
    }
    function openItemSuggestions() {
      updateSuggestions();
      if (!matches.length) {
        setStatus(Object.keys(itemTable).length ? "No item matched that." : "Item list is still loading - you can type an item id meanwhile.", "warn");
      }
    }
    itemInput.addEventListener("input", updateSuggestions);
    itemInput.addEventListener("focus", updateSuggestions);
    itemInput.addEventListener("blur", function() {
      setTimeout(hideItemSuggestions, 120);
    });
    itemInput.addEventListener("keydown", function(e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!matches.length) return;
        e.preventDefault();
        activeIndex = e.key === "ArrowDown" ? (activeIndex + 1) % matches.length : (activeIndex - 1 + matches.length) % matches.length;
        paintSuggestions();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (matches.length && activeIndex >= 0) choose(matches[activeIndex]); else itemBtn.click();
      } else if (e.key === "Escape") {
        hideItemSuggestions();
      }
    });
    const detected = currentItemId();
    if (detected) {
      itemInput.value = String(detected);
      s.appendChild(el("div", {
        class: "tbms-hint",
        style: "margin-bottom:6px;",
        text: "This page is about item " + detected + " - press the button to scan it."
      }));
    }
    const intervalRow = el("div", {
      class: "tbms-row"
    });
    const intervalInput = el("input", {
      id: "tbms-auto-interval",
      class: "tbms-num",
      type: "number",
      min: "10"
    });
    intervalInput.value = settings.scan.auto.intervalSec;
    intervalInput.addEventListener("change", function() {
      const v = Number(intervalInput.value);
      const safe = isFinite(v) && v >= 10 ? Math.round(v) : 10;
      settings.scan.auto.intervalSec = safe;
      intervalInput.value = safe;
      saveSettings();
      if (settings.scan.auto.on) scheduleAutoScan(autoIntervalMs());
      setStatus("Auto-scan will repeat every " + safe + " seconds.", "info");
    });
    intervalRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Auto-scan every"
    }));
    intervalRow.appendChild(intervalInput);
    intervalRow.appendChild(el("span", {
      class: "tbms-suffix",
      text: "sec (min 10)"
    }));
    s.appendChild(intervalRow);
    const toastRow = el("div", {
      class: "tbms-row"
    });
    const toastSwitch = el("label", {
      class: "tbms-switch"
    });
    const toastInput = el("input", {
      type: "checkbox"
    });
    toastInput.checked = !!settings.ui.toast;
    toastInput.addEventListener("change", function() {
      settings.ui.toast = toastInput.checked;
      saveSettings();
      if (!toastInput.checked) dismissResultsToast();
    });
    toastSwitch.appendChild(toastInput);
    toastSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    toastRow.appendChild(toastSwitch);
    toastRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Popup card when a scan finds matches",
      title: "A corner card with attack, bazaar and watch buttons for each match."
    }));
    s.appendChild(toastRow);
    const stopBtn = el("button", {
      id: "tbms-stop-btn",
      class: "tbms-btn tbms-danger",
      text: "Stop"
    });
    stopBtn.disabled = true;
    stopBtn.addEventListener("click", function() {
      scan.abort = true;
      setStatus("Stopping after the current request...", "warn");
    });
    const other = el("details", {
      class: "tbms-adv"
    });
    other.appendChild(el("summary", {
      text: "Other ways to pick targets"
    }));
    const row = el("div", {
      class: "tbms-row"
    });
    const scanBtn = el("button", {
      id: "tbms-scan-btn",
      class: "tbms-btn",
      text: "Scan sellers on this page"
    });
    scanBtn.addEventListener("click", function() {
      runScan();
    });
    row.appendChild(scanBtn);
    row.appendChild(stopBtn);
    other.appendChild(row);
    const counter = el("span", {
      id: "tbms-harvest-count",
      class: "tbms-pill"
    });
    counter.textContent = String(harvestIds().length);
    const countRow = el("div", {
      class: "tbms-row"
    }, [ el("span", {
      text: "Sellers on this page:"
    }), counter ]);
    other.appendChild(countRow);
    other.appendChild(el("div", {
      class: "tbms-hint",
      text: "Comma separated player IDs."
    }));
    const manual = el("input", {
      id: "tbms-manual-input",
      class: "tbms-text",
      placeholder: "e.g. 1234567, 2345678"
    });
    other.appendChild(manual);
    const manualRow = el("div", {
      class: "tbms-row"
    });
    const manualBtn = el("button", {
      class: "tbms-btn",
      text: "Check IDs"
    });
    manualBtn.addEventListener("click", function() {
      const ids = extractIdsFromHtml(manual.value.replace(/(\d+)/g, "XID=$1"));
      const loose = (manual.value.match(/\d{3,8}/g) || []).map(Number);
      const all = Array.from(new Set(ids.concat(loose))).filter(isValidPlayerId);
      if (!all.length) {
        setStatus("No usable IDs found in that box.", "warn");
        return;
      }
      runScan(all);
    });
    manualRow.appendChild(manualBtn);
    other.appendChild(manualRow);
    s.appendChild(other);
    ensureItemTable().then(function(items) {
      if (Object.keys(items).length) {
        if (!itemInput.value && settings.scan.lastItemId) {
          const last = items[settings.scan.lastItemId];
          itemInput.value = last || String(settings.scan.lastItemId);
          if (last) itemInput.setAttribute("data-item-id", String(settings.scan.lastItemId));
        }
      } else {
        setStatus("Item names could not be loaded - type an item id (e.g. 206) instead.", "warn");
      }
    });
  }
  let itemTable = {};
  let itemTablePromise = null;
  let itemTableTriedAt = 0;
  function ensureItemTable(force) {
    if (Object.keys(itemTable).length && !force) return Promise.resolve(itemTable);
    if (!force && itemTablePromise) return itemTablePromise;
    if (!force && Date.now() - itemTableTriedAt < 5e3) {
      return Promise.resolve(itemTable);
    }
    itemTableTriedAt = Date.now();
    const pending = loadItemList(force).then(function(items) {
      if (Object.keys(items).length) itemTable = items;
      itemTablePromise = null;
      return itemTable;
    }).catch(function(e) {
      log("Item list: " + e.message, "warn");
      itemTablePromise = null;
      return itemTable;
    });
    itemTablePromise = pending;
    return itemTablePromise;
  }
  function searchItems(query, limit) {
    const rows = [];
    Object.keys(itemTable).forEach(function(id) {
      const name = itemTable[id];
      const lower = name.toLowerCase();
      let rank = -1;
      if (lower === query) rank = 0; else if (lower.indexOf(query) === 0) rank = 1; else if (lower.split(/\s+/).some(function(w) {
        return w.indexOf(query) === 0;
      })) rank = 2; else if (lower.indexOf(query) !== -1) rank = 3;
      if (rank >= 0) rows.push({
        id: toNumber(id),
        name: name,
        rank: rank
      });
    });
    rows.sort(function(a, b) {
      return a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name);
    });
    return rows.slice(0, limit || 8);
  }
  async function resolveItemId(text, pickedId) {
    if (pickedId) return toNumber(pickedId);
    const raw = String(text || "").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return toNumber(raw);
    await ensureItemTable();
    const best = searchItems(raw.toLowerCase(), 1);
    return best.length ? best[0].id : null;
  }
  async function runItemScan(itemId, opts) {
    const background = !!(opts && opts.background);
    if (scan.running) return;
    if (!settings.api.tornKey) {
      setStatus("Add your Torn API key in Setup first.", "error");
      switchTab("setup");
      return;
    }
    if (!settings.me.id) await learnOwnId();
    scan.running = true;
    setScanningUi(true);
    setStatus("Looking up bazaar sellers...", "progress");
    try {
      const found = await findBazaarSellers(itemId);
      if (!found.sellers.length) {
        scan.running = false;
        setScanningUi(false);
        const base = "No bazaar sellers found for " + itemLabel(itemId) + ".";
        if (found.problems) {
          found.problems.forEach(function(p) {
            log(p, "warn");
          });
        }
        setStatus(found.sawData && diagnostics.lastRaw ? base + " Torn answered but the format was unexpected - see Setup for the raw response." : base + " " + (found.problems || []).join(" | "), "warn");
        resetSubjects();
        scan.emptyNote = "No bazaar sellers were listed for " + itemLabel(itemId) + " by either source.";
        applyVerdicts();
        return;
      }
      const ordered = found.sellers.filter(function(row) {
        return !isSelf(row.id);
      }).sort(function(a, b) {
        return (b.price || 0) * (b.qty || 0) - (a.price || 0) * (a.qty || 0);
      });
      const name = itemTable[itemId] || "item " + itemId;
      scan.emptyNote = null;
      log(name + ": " + ordered.length + " bazaar seller(s) found via " + found.source + ".", "info");
      settings.scan.lastItemId = itemId;
      saveSettings();
      const hints = {};
      ordered.forEach(function(row) {
        if (row.name) hints[row.id] = row.name;
      });
      const listings = {};
      const unusable = [];
      ordered.forEach(function(row) {
        const price = toNumber(row.price);
        const qty = toNumber(row.qty);
        if (price === null || qty === null) {
          unusable.push(row);
          return;
        }
        listings[row.id] = {
          itemId: itemId,
          itemName: itemTable[itemId] || row.name || "item " + itemId,
          price: price,
          qty: qty,
          marketPrice: row.marketPrice !== undefined && row.marketPrice !== null ? row.marketPrice : found.marketPrice
        };
      });
      if (unusable.length) {
        rememberRaw("seller rows without price/qty from " + found.source, unusable.slice(0, 3));
        log(unusable.length + " seller(s) from " + found.source + " arrived without a price and quantity, so their value is unknown.", "warn");
      }
      const pool = ordered.slice(0, Math.max(1, settings.scan.maxCandidates || 300));
      const screened = pool;
      if (!screened.length) {
        scan.running = false;
        setScanningUi(false);
        const breakdown = (found.detail || []).join(", ");
        setStatus("No sellers on " + itemLabel(itemId) + " - the sources returned nobody (" + breakdown + ").", "info");
        return;
      }
      setStatus("Screening " + screened.length + " seller(s) on FFScouter...", "progress");
      const ff = await ffLookup(screened.map(function(row) {
        return row.id;
      }));
      scan.running = false;
      await runScan(screened.map(function(row) {
        return row.id;
      }), name + " (" + found.source + ")", hints, ff, {
        append: background,
        listings: listings,
        itemId: itemId
      });
    } catch (e) {
      scan.running = false;
      setScanningUi(false);
      if (background) {
        log("Auto-scan: " + e.message, "error");
      } else {
        setStatus("Item scan failed: " + e.message, "error");
      }
    }
  }
  function renderFiltersTab() {
    const s = section("filters");
    s.innerHTML = "";
    function addGroup(group) {
      const sec = el("div", {
        class: "tbms-sec"
      });
      sec.appendChild(el("h4", {
        text: group.title
      }));
      group.items.forEach(function(item) {
        sec.appendChild(buildControl(item));
      });
      s.appendChild(sec);
    }
    MAIN_GROUPS.forEach(addGroup);
    const adv = el("details", {
      class: "tbms-adv"
    });
    adv.appendChild(el("summary", {
      text: "Advanced filters"
    }));
    ADVANCED_GROUPS.forEach(function(group) {
      const sec = el("div", {
        class: "tbms-sec"
      });
      sec.appendChild(el("h4", {
        text: group.title
      }));
      group.items.forEach(function(item) {
        sec.appendChild(buildControl(item));
      });
      adv.appendChild(sec);
    });
    s.appendChild(adv);
    const rescan = el("div", {
      class: "tbms-row"
    });
    const btn = el("button", {
      class: "tbms-btn tbms-primary",
      text: "Re-score last scan"
    });
    btn.addEventListener("click", function() {
      if (!scan.subjects.length) {
        setStatus("Nothing scanned yet.", "warn");
        return;
      }
      const matches = applyVerdicts();
      setStatus("Re-scored " + scan.subjects.length + " seller(s) with the current filters: " + matches + " match.", matches ? "ok" : "warn");
      switchTab("results");
    });
    rescan.appendChild(btn);
    s.appendChild(rescan);
  }
  function toastHostEl() {
    const existing = document.getElementById("tbms-toasts");
    if (existing) return existing;
    const host = el("div", {
      id: "tbms-toasts"
    });
    document.body.appendChild(host);
    return host;
  }
  function dismissResultsToast() {
    const old = document.getElementById("tbms-results-toast");
    if (old) old.remove();
  }
  function toastAction(label, href, onClick, extraClass) {
    const node = href ? el("a", {
      class: "tbms-toast-btn " + (extraClass || ""),
      href: href,
      target: "_blank",
      rel: "noopener",
      text: label
    }) : el("button", {
      type: "button",
      class: "tbms-toast-btn " + (extraClass || ""),
      text: label
    });
    if (onClick) {
      node.addEventListener("click", function(e) {
        if (!href) e.preventDefault();
        if (href) e.stopPropagation();
        onClick(e);
      });
    }
    return node;
  }
  function showResultsToast() {
    if (!settings.ui.toast) return;
    const matches = scan.results.filter(function(r) {
      return r.verdict.verdict === "match";
    });
    if (!matches.length) {
      dismissResultsToast();
      return;
    }
    const signature = matches.map(function(m) {
      return m.subject.id;
    }).join(",");
    if (signature === toastSignature) return;
    toastSignature = signature;
    dismissResultsToast();
    const card = el("div", {
      id: "tbms-results-toast",
      class: "tbms-toast"
    });
    const close = el("button", {
      class: "tbms-toast-close",
      title: "Dismiss",
      text: "×"
    });
    close.addEventListener("click", function() {
      toastSignature = signature;
      dismissResultsToast();
    });
    card.appendChild(close);
    card.appendChild(el("div", {
      class: "tbms-toast-head",
      text: matches.length + (matches.length === 1 ? " match" : " matches")
    }));
    card.appendChild(el("div", {
      class: "tbms-toast-sub",
      text: scan.lastLabel ? "from " + scan.lastLabel : "ready to attack"
    }));
    const SHOWN = 4;
    matches.slice(0, SHOWN).forEach(function(m) {
      const su = m.subject;
      const row = el("div", {
        class: "tbms-toast-row"
      });
      const who = el("div", {
        class: "tbms-toast-who"
      });
      who.appendChild(el("span", {
        class: "tbms-toast-name",
        text: su.name
      }));
      const bits = [ String(m.verdict.score) ];
      if (su.ff && su.ff.fairFight !== null) bits.push("FF " + su.ff.fairFight.toFixed(2));
      bits.push(formatMoney(su.loot || 0) + " loot");
      who.appendChild(el("span", {
        class: "tbms-toast-meta",
        text: bits.join(" · ")
      }));
      row.appendChild(who);
      row.appendChild(toastAction("attack", "https://www.torn.com/loader.php?sid=attack&user2ID=" + su.id, null, "tbms-toast-attack"));
      row.appendChild(toastAction("bazaar", "https://www.torn.com/bazaar.php?userId=" + su.id, null));
      row.appendChild(toastAction("watch", null, function() {
        watchAdd(su.id, su.name, su.status, "added from the results card");
        paintWatchTab();
        setStatus(su.name + " added to the watchlist.", "ok");
      }));
      card.appendChild(row);
    });
    const foot = el("div", {
      class: "tbms-toast-foot"
    });
    if (matches.length > SHOWN) {
      foot.appendChild(el("span", {
        class: "tbms-toast-more",
        text: "+" + (matches.length - SHOWN) + " more"
      }));
    } else {
      foot.appendChild(el("span", {
        class: "tbms-toast-more"
      }));
    }
    foot.appendChild(toastAction("Open panel", null, function() {
      settings.ui.open = true;
      saveSettings();
      syncPanelVisibility();
      switchTab("results");
    }));
    card.appendChild(foot);
    toastHostEl().appendChild(card);
  }
  let toastSignature = "";
  function renderWatchTab() {
    const s = section("watch");
    if (!s) return;
    s.innerHTML = "";
    s.appendChild(el("div", {
      class: "tbms-hint",
      style: "margin-bottom:10px;",
      text: "Players who are not reachable yet but soon will be. They are re-checked as their time comes up, so they are waiting here the moment they land or are discharged."
    }));
    const ctrl = el("div", {
      class: "tbms-sec"
    });
    const autoRow = el("div", {
      class: "tbms-row"
    });
    const autoSwitch = el("label", {
      class: "tbms-switch"
    });
    const autoInput = el("input", {
      type: "checkbox"
    });
    autoInput.checked = !!settings.watch.autoAdd;
    autoInput.addEventListener("change", function() {
      settings.watch.autoAdd = autoInput.checked;
      saveSettings();
    });
    autoSwitch.appendChild(autoInput);
    autoSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    autoRow.appendChild(autoSwitch);
    autoRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Add players who will be free soon, automatically",
      title: "Anyone a scan finds who frees up within the window below goes on the list."
    }));
    ctrl.appendChild(autoRow);
    [ [ "watch.windowMin", "Watch anyone free within", "min" ], [ "watch.checkEverySec", "Check the list every", "sec" ] ].forEach(function(triple) {
      const row = el("div", {
        class: "tbms-row"
      });
      const input = el("input", {
        class: "tbms-num",
        type: "number"
      });
      input.value = getPath(triple[0]);
      input.addEventListener("change", function() {
        const v = Number(input.value);
        setPath(triple[0], isFinite(v) && v > 0 ? v : 1);
      });
      const opts = {
        class: "tbms-label",
        text: triple[1]
      };
      row.appendChild(input);
      row.appendChild(el("label", opts));
      row.appendChild(el("span", {
        class: "tbms-suffix",
        text: triple[2]
      }));
      ctrl.appendChild(row);
    });
    s.appendChild(ctrl);
    const entries = watchEntries().sort(function(a, b) {
      if (!!b.ready !== !!a.ready) return b.ready ? 1 : -1;
      return (a.until || Infinity) - (b.until || Infinity);
    });
    const head = el("div", {
      class: "tbms-row"
    });
    const ready = entries.filter(function(e) {
      return e.ready;
    }).length;
    head.appendChild(el("span", {
      class: "tbms-pill " + (ready ? "tbms-ok" : ""),
      text: entries.length + " watched"
    }));
    if (ready) {
      head.appendChild(el("span", {
        class: "tbms-pill tbms-ok",
        text: ready + " back now"
      }));
    }
    const checkBtn = el("button", {
      class: "tbms-btn",
      text: "Check now"
    });
    checkBtn.addEventListener("click", function() {
      checkBtn.disabled = true;
      runWatchCheck(true).finally(function() {
        checkBtn.disabled = false;
      });
    });
    head.appendChild(checkBtn);
    s.appendChild(head);
    if (!entries.length) {
      s.appendChild(el("div", {
        class: "tbms-empty",
        text: "Nothing on the watchlist yet. Scan an item, or use +watch on a result."
      }));
      return;
    }
    const table = el("table", {
      class: "tbms-table"
    });
    const htr = el("tr");
    [ [ "Player", "160px" ], [ "Where", "120px" ], [ "Free in", "160px" ], [ "Last known bazaar", "150px" ], [ "", "auto" ] ].forEach(function(h) {
      const th = el("th", {
        text: h[0]
      });
      th.style.width = h[1];
      htr.appendChild(th);
    });
    table.appendChild(el("thead", {}, [ htr ]));
    const tbody = el("tbody");
    entries.forEach(function(e) {
      const tr = el("tr", {
        class: e.ready ? "tbms-match" : "tbms-reject"
      });
      const nameTd = el("td", {
        class: "tbms-accent"
      });
      nameTd.appendChild(el("a", {
        class: "tbms-link",
        href: "https://www.torn.com/profiles.php?XID=" + e.id,
        target: "_blank",
        rel: "noopener",
        text: e.name || "Player " + e.id
      }));
      nameTd.appendChild(document.createElement("br"));
      nameTd.appendChild(el("span", {
        class: "tbms-hint",
        text: "#" + e.id
      }));
      tr.appendChild(nameTd);
      tr.appendChild(el("td", {}, [ el("span", {
        class: "tbms-pill " + (e.ready ? "tbms-ok" : "tbms-warn"),
        text: e.ready ? "back now" : e.state || "unknown",
        title: !e.ready && e.abroad ? "Abroad. Out of hospital abroad still means out of the country, so they are not attackable yet." : ""
      }) ]));
      const left = e.until ? e.until - Math.floor(Date.now() / 1e3) : null;
      const whenText = e.ready ? "-" : (left !== null ? formatCountdown(Math.max(0, left)) : "unknown") + (e.abroad ? " (still abroad)" : "");
      tr.appendChild(el("td", {
        text: whenText,
        title: e.until ? "Their state ends then" : "No end time given"
      }));
      tr.appendChild(el("td", {
        text: e.bazaarValue ? formatMoney(e.bazaarValue) : "-",
        title: e.error ? "Last check failed: " + e.error : ""
      }));
      const actTd = el("td");
      if (e.ready) {
        actTd.appendChild(el("a", {
          class: "tbms-link",
          href: "https://www.torn.com/loader.php?sid=attack&user2ID=" + e.id,
          target: "_blank",
          rel: "noopener",
          text: "attack"
        }));
        actTd.appendChild(document.createTextNode(" · "));
      }
      actTd.appendChild(el("a", {
        class: "tbms-link",
        href: "https://www.torn.com/bazaar.php?userId=" + e.id,
        target: "_blank",
        rel: "noopener",
        text: "bazaar"
      }));
      actTd.appendChild(document.createTextNode(" · "));
      const rm = el("a", {
        class: "tbms-link",
        href: "#",
        text: "remove"
      });
      rm.addEventListener("click", function(ev) {
        ev.preventDefault();
        watchRemove(e.id);
        setStatus(e.name + " removed from the watchlist.", "info");
      });
      actTd.appendChild(rm);
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    s.appendChild(table);
  }
  function paintWatchTab() {
    const tab = panel && panel.querySelector('.tbms-tab[data-tab="watch"]');
    if (tab) {
      const ready = watchReadyEntries().length;
      tab.textContent = ready ? "Watch · " + ready : "Watch";
      tab.classList.toggle("tbms-tab-alert", ready > 0);
    }
    if (settings.ui.tab === "watch") renderWatchTab();
  }
  let sortKey = "score";
  let sortDir = -1;
  function renderResults() {
    const s = section("results");
    if (!s) return;
    s.innerHTML = "";
    if (!scan.results.length) {
      s.appendChild(el("div", {
        class: "tbms-empty",
        text: scan.running ? "Scanning..." : scan.emptyNote || "No results yet. Pick an item on the Scan tab."
      }));
      return;
    }
    const matches = scan.results.filter(function(r) {
      return r.verdict.verdict === "match";
    }).length;
    const top = el("div", {
      class: "tbms-row"
    });
    top.appendChild(el("span", {
      class: "tbms-pill " + (matches ? "tbms-ok" : "tbms-warn"),
      text: matches + " match(es)"
    }));
    top.appendChild(el("span", {
      class: "tbms-pill",
      text: scan.results.length + " scanned"
    }));
    const onlyWrap = el("label", {
      class: "tbms-switch"
    });
    const onlyInput = el("input", {
      type: "checkbox"
    });
    onlyInput.checked = !!settings.ui.onlyMatches;
    onlyInput.addEventListener("change", function() {
      settings.ui.onlyMatches = onlyInput.checked;
      saveSettings();
      renderResults();
    });
    onlyWrap.appendChild(onlyInput);
    onlyWrap.appendChild(el("span", {
      class: "tbms-slider"
    }));
    top.appendChild(onlyWrap);
    top.appendChild(el("span", {
      class: "tbms-hint",
      text: "only show matches"
    }));
    const exportBtn = el("button", {
      class: "tbms-btn",
      text: "Copy JSON"
    });
    exportBtn.addEventListener("click", function() {
      copyToClipboard(JSON.stringify(exportResults(), null, 2));
      setStatus("Results copied to clipboard.", "ok");
    });
    top.appendChild(exportBtn);
    const csvBtn = el("button", {
      class: "tbms-btn",
      text: "Copy CSV"
    });
    csvBtn.addEventListener("click", function() {
      copyToClipboard(toCsv(exportResults()));
      setStatus("CSV copied to clipboard.", "ok");
    });
    top.appendChild(csvBtn);
    const clearBtn = el("button", {
      id: "tbms-clear-btn",
      class: "tbms-btn tbms-danger",
      text: "Clear",
      title: "Empty this list and forget the stored scan. Your watchlist is kept."
    });
    clearBtn.addEventListener("click", function() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      rawDelete(RESULTS_KEY);
      resetSubjects();
      scan.results = [];
      scan.emptyNote = null;
      scan.lastLabel = "";
      dismissResultsToast();
      updateBadge(0);
      renderResults();
      setStatus("Results cleared. Your watchlist is untouched.", "info");
    });
    top.appendChild(clearBtn);
    s.appendChild(top);
    const rows = scan.results.filter(function(r) {
      return !settings.ui.onlyMatches || r.verdict.verdict === "match";
    }).slice().sort(comparator());
    const table = el("table", {
      class: "tbms-table"
    });
    const thead = el("thead");
    const htr = el("tr");
    [ [ "score", "Score", "46px" ], [ "name", "Seller", "132px" ], [ "status", "Where", "104px" ], [ "strength", "FF / stats", "74px" ], [ "loot", "On sale", "132px" ], [ "predicted", "Net profit", "92px" ], [ "why", "Notes", "auto" ], [ "act", "", "118px" ] ].forEach(function(pair) {
      const th = el("th", {
        text: pair[1]
      });
      th.style.width = pair[2];
      th.addEventListener("click", function() {
        if (sortKey === pair[0]) sortDir = -sortDir; else {
          sortKey = pair[0];
          sortDir = -1;
        }
        renderResults();
      });
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el("tbody");
    rows.forEach(function(r) {
      tbody.appendChild(buildResultRow(r));
    });
    table.appendChild(tbody);
    s.appendChild(table);
  }
  function comparator() {
    return function(a, b) {
      const get = function(r) {
        const v = r.verdict;
        const su = r.subject;
        switch (sortKey) {
         case "name":
          return su.name.toLowerCase();

         case "status":
          return su.status.state;

         case "strength":
          return su.ff.fairFight === null && su.ff.bsEstimate === null ? -1 : (su.ff.fairFight || 0) * 1e12 + (su.ff.bsEstimate || 0);

         case "loot":
          return su.value || 0;

         case "predicted":
          return su.loot || 0;

         case "buyout":
          return su.bazaar.buyout;

         case "vault":
          return su.vault.hasVault === true ? 1 : 0;

         case "why":
          return v.reasons.length;

         case "act":
          return v.score;

         default:
          return v.score;
        }
      };
      const av = get(a);
      const bv = get(b);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    };
  }
  function buildResultRow(r) {
    const su = r.subject;
    const v = r.verdict;
    const tr = el("tr", {
      class: "tbms-" + v.verdict
    });
    tr.appendChild(el("td", {}, [ el("b", {
      text: String(v.score)
    }) ]));
    const nameTd = el("td");
    const profileLink = el("a", {
      class: "tbms-link",
      href: "https://www.torn.com/profiles.php?XID=" + su.id,
      target: "_blank",
      rel: "noopener",
      text: su.name
    });
    nameTd.appendChild(profileLink);
    nameTd.appendChild(document.createElement("br"));
    nameTd.appendChild(el("span", {
      class: "tbms-hint",
      text: "#" + su.id + (su.level ? " · lvl " + su.level : "")
    }));
    tr.appendChild(nameTd);
    const stateTd = el("td");
    const cls = su.status.available ? "tbms-ok" : su.status.inTorn ? "tbms-warn" : "tbms-bad";
    stateTd.appendChild(el("span", {
      class: "tbms-pill " + cls,
      text: su.status.state
    }));
    stateTd.appendChild(document.createElement("br"));
    const freeIn = secondsUntilFree(su.status);
    const subline = su.screenedOut ? "not checked" : !su.status.available && freeIn !== null ? (su.status.inTorn ? "out in " : "lands in ") + formatCountdown(freeIn) : su.lastActionAgo !== null ? "seen " + formatAgo(su.lastActionAgo) + " ago" : "last action unknown";
    stateTd.appendChild(el("span", {
      class: "tbms-hint",
      text: subline
    }));
    tr.appendChild(stateTd);
    const strengthTd = el("td");
    strengthTd.appendChild(el("span", {
      text: su.ff.fairFight === null || su.ff.fairFight === undefined ? "-" : su.ff.fairFight.toFixed(2)
    }));
    strengthTd.appendChild(document.createElement("br"));
    const est = su.ff.bsEstimate || su.publicBs;
    strengthTd.appendChild(el("span", {
      class: "tbms-hint",
      text: est ? formatNumber(est) : "unknown"
    }));
    if (su.ff.source) strengthTd.title = "Stat source: " + su.ff.source;
    tr.appendChild(strengthTd);
    const lootTd = el("td");
    if (su.screenedOut) {
      lootTd.appendChild(el("span", {
        class: "tbms-hint",
        text: "not checked"
      }));
      lootTd.title = "Ruled out by the strength screen, so no Torn request was spent on them.";
    } else {
      const onSale = su.listingSummary || su.itemSummary || su.bazaar;
      lootTd.appendChild(el("span", {
        text: su.valueUnknown ? su.bazaar && su.bazaar.buyout ? "bazaar " + formatMoney(su.bazaar.buyout) : "value not read" : formatMoney(su.value || 0) + " on sale"
      }));
      lootTd.appendChild(document.createElement("br"));
      const bits = [];
      if (su.listing) {
        bits.push(su.listing.qty + " x " + formatMoney(su.listing.price));
        if (su.listing.marketPrice) {
          bits.push("market " + formatMoney(su.listing.marketPrice));
        }
      } else if (su.valueUnknown) {
        bits.push(su.valueUnknownReason || "value not returned");
      } else {
        bits.push(onSale.count + " items");
      }
      lootTd.appendChild(el("span", {
        class: "tbms-hint",
        text: bits.join(" · ")
      }));
      const notes = [];
      if (su.listing) {
        notes.push("Listing: " + su.listing.itemName);
      }
      notes.push("On sale " + formatMoney(onSale.buyout));
      if (su.bazaar.buyout > 0) {
        notes.push("Their whole bazaar " + formatMoney(su.bazaar.buyout));
      }
      const econ = estimateEconomics(su, settings.econ);
      if (econ.spend > 0) {
        notes.push("A mug rolls " + formatPercent(econ.mugPercentLow) + "-" + formatPercent(econ.mugPercentHigh) + "% of " + formatMoney(econ.mugTargetCash) + ": " + formatMoney(econ.mugGrossLow) + " to " + formatMoney(econ.mugGrossHigh) + " (" + mugModifierLabel(settings.econ) + ")");
      }
      if (onSale.dealCount) notes.push(onSale.dealCount + " item(s) under market price");
      lootTd.title = notes.join("\n");
    }
    tr.appendChild(lootTd);
    const lootPayTd = el("td");
    if (su.screenedOut || su.valueUnknown) {
      lootPayTd.appendChild(el("span", {
        class: "tbms-hint",
        text: "-"
      }));
      if (su.valueUnknown) {
        lootPayTd.title = "No value to estimate from: " + (su.valueUnknownReason || "the data was not returned") + ".";
      }
    } else {
      const detail = su.lootDetail || lootBreakdown(su);
      const band = detail.mugBand || mugBand(detail.spend, settings.econ);
      const positive = detail.net >= 0;
      lootPayTd.appendChild(el("span", {
        style: positive ? "color:var(--tb-ok);font-weight:600;" : "color:var(--tb-bad);font-weight:600;",
        text: (positive ? "+" : "") + formatMoney(detail.net)
      }));
      lootPayTd.appendChild(document.createElement("br"));
      lootPayTd.appendChild(el("span", {
        class: "tbms-hint",
        text: detail.spend > 0 ? formatPercent(band.lowPct) + "-" + formatPercent(band.highPct) + "% mug" : "-",
        title: "Torn rolls the mug percentage, so the net profit is a band rather than one number."
      }));
      const title = [];
      title.push(su.listing ? su.listing.itemName : "Their stock");
      title.push("");
      title.push("You pay      " + formatMoney(detail.price) + " x " + detail.qty + " = " + formatMoney(detail.spend));
      title.push("Market value " + formatMoney(detail.marketPrice || detail.price) + " x " + detail.qty + " = " + formatMoney(detail.marketValue));
      title.push("");
      title.push("Difference   " + signedMoney(detail.unitDifference) + " per item  x " + detail.qty + " = " + signedMoney(detail.totalDifference));
      title.push("");
      title.push("Mug          " + formatPercent(band.lowPct) + "-" + formatPercent(band.highPct) + "% of the " + formatMoney(detail.spend) + " you hand over  (" + mugModifierLabel(settings.econ) + ")");
      title.push("             worst    " + signedMoney(detail.grossLow) + "   (" + formatPercent(band.lowPct) + "%)");
      title.push("             likely   " + signedMoney(detail.gross) + "   (" + formatPercent(band.likelyPct) + "%)");
      title.push("             best     " + signedMoney(detail.grossHigh) + "   (" + formatPercent(band.highPct) + "%)");
      title.push("");
      title.push("Net profit   worst    " + signedMoney(detail.netLow));
      title.push("             likely   " + signedMoney(detail.net));
      title.push("             best     " + signedMoney(detail.netHigh));
      lootPayTd.title = title.join("\n");
    }
    tr.appendChild(lootPayTd);
    const whyTd = el("td");
    whyTd.className = "tbms-wrap";
    if (su.vault && su.vault.hasVault === true) {
      whyTd.appendChild(el("span", {
        class: "tbms-pill tbms-warn",
        text: "vault" + (su.vault.vaultAmount ? " " + formatMoney(su.vault.vaultAmount) : ""),
        title: "They keep cash in a vault, out of reach of a mug."
      }));
      whyTd.appendChild(document.createTextNode(" "));
    }
    if (v.reasons.length) {
      whyTd.appendChild(el("span", {
        class: "tbms-pill tbms-bad",
        text: v.reasons.join(", ")
      }));
    } else {
      whyTd.appendChild(el("span", {
        class: "tbms-pill tbms-ok",
        text: "clear"
      }));
    }
    tr.appendChild(whyTd);
    const actTd = el("td");
    actTd.appendChild(el("a", {
      class: "tbms-link",
      href: "https://www.torn.com/bazaar.php?userId=" + su.id,
      target: "_blank",
      rel: "noopener",
      text: "bazaar"
    }));
    actTd.appendChild(document.createTextNode(" · "));
    actTd.appendChild(el("a", {
      class: "tbms-link",
      href: "https://www.torn.com/loader.php?sid=attack&user2ID=" + su.id,
      target: "_blank",
      rel: "noopener",
      text: "attack"
    }));
    actTd.appendChild(document.createTextNode(" · "));
    actTd.appendChild(document.createElement("br"));
    const watchLink = el("a", {
      class: "tbms-link",
      href: "#",
      text: "watch",
      title: "Track this player and flag them the moment they are back"
    });
    watchLink.addEventListener("click", function(ev) {
      ev.preventDefault();
      watchAdd(su.id, su.name, su.status, "added from results");
      paintWatchTab();
      setStatus(su.name + " added to the watchlist.", "ok");
    });
    actTd.appendChild(watchLink);
    tr.appendChild(actTd);
    return tr;
  }
  function exportResults() {
    return scan.results.map(function(r) {
      const su = r.subject;
      const econ = estimateEconomics(su, settings.econ);
      return {
        id: su.id,
        name: su.name,
        level: su.level,
        score: r.verdict.score,
        verdict: r.verdict.verdict,
        reasons: r.verdict.reasons,
        state: su.status.state,
        inTorn: su.status.inTorn,
        lastActionSeconds: su.lastActionAgo,
        fairFight: su.ff.fairFight,
        bsEstimate: su.ff.bsEstimate,
        publicBs: su.publicBs,
        onSaleValue: su.value || 0,
        onSaleSource: su.valueSource,
        listingItem: su.listing ? su.listing.itemName : null,
        listingPrice: su.listing ? su.listing.price : null,
        listingQuantity: su.listing ? su.listing.qty : null,
        listingMarketPrice: su.listing ? su.listing.marketPrice : null,
        bazaarBuyout: su.bazaar.buyout,
        bazaarMarketValue: su.bazaar.marketValue,
        predictedLoot: su.loot || 0,
        itemCount: su.bazaar.count,
        dealCount: su.bazaar.dealCount,
        hasVault: su.vault.hasVault,
        vaultAmount: su.vault.vaultAmount,
        estimate: econ
      };
    });
  }
  function toCsv(rows) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const head = cols.join(",");
    const body = rows.map(function(row) {
      return cols.map(function(c) {
        const v = row[c];
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(",");
    }).join("\n");
    return head + "\n" + body;
  }
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) {}
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
  }
  async function findProbeId() {
    const seen = scan.subjects.length ? scan.subjects[0].id : null;
    const candidates = [ seen ].concat([ 1, 2, 3, 4, 5, 10, 100 ]).filter(Boolean);
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      if (isSelf(id)) continue;
      const res = await tornGet("/user/" + id + "?selections=profile&key=" + KEY_URL_SAFE(settings.api.tornKey));
      if (res.ok) return id;
      if (res.code === ERR_KEY_LEVEL || res.code === ERR_BAD_KEY) return null;
    }
    return null;
  }
  function explainCode(code) {
    if (code === ERR_KEY_LEVEL) return "key level too low";
    if (code === ERR_PRIVATE) return "private for this player";
    if (code === ERR_ACCESS) return "wrong key type";
    if (code === ERR_FIELDS) return "selection not available";
    if (code === 23) return "only exists in API v2";
    if (code === 22) return "only exists in API v1";
    if (code === ERR_BAD_ID) return "test id not found";
    if (code === ERR_TOO_MANY) return "rate limited, try again";
    if (code === ERR_BAD_KEY) return "incorrect key";
    return "error " + code;
  }
  async function probeKeyCapabilities() {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const rows = [];
    rows.push({
      label: "Your own profile",
      res: await tornGet("/user/?selections=basic&key=" + key)
    });
    rows.push({
      label: "Item list (for the picker)",
      res: await tornGet("/torn/?selections=items&key=" + key)
    });
    rows.push({
      label: "Item market bazaar listings",
      res: await tornGet("/v2/market/206/bazaar?key=" + key)
    });
    const probeId = await findProbeId();
    if (probeId) {
      const probes = [ {
        label: "Another player's profile",
        path: "/user/" + probeId + "?selections=profile&key=" + key
      }, {
        label: "Another player's bazaar",
        path: "/user/" + probeId + "?selections=bazaar&key=" + key
      }, {
        label: "Another player's property (v2)",
        path: "/v2/user/" + probeId + "/property?key=" + key
      } ];
      for (let i = 0; i < probes.length; i++) {
        rows.push({
          label: probes[i].label,
          res: await tornGet(probes[i].path),
          sel: probes[i].sel
        });
      }
    } else {
      rows.push({
        label: "Other players' data (not tested)",
        res: {
          ok: false,
          code: ERR_BAD_ID,
          error: "no player available to test against"
        },
        skipped: true
      });
    }
    return rows.map(function(row) {
      const ok = row.res.ok;
      let note = "";
      if (ok) {
        const d = row.res.data || {};
        const empty = typeof d === "object" && Object.keys(d).length === 0;
        if (empty) note = "the call worked but came back empty";
      } else {
        note = explainCode(row.res.code);
      }
      return {
        label: row.label,
        ok: ok,
        note: row.skipped ? "not tested - scan or load stats first" : note,
        code: row.res.ok ? null : row.res.code
      };
    });
  }
  function makeKeyField(id, placeholder) {
    const input = el("input", {
      id: id,
      class: "tbms-text tbms-masked",
      type: "text",
      maxlength: "16",
      placeholder: placeholder,
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      autocomplete: "off",
      "data-lpignore": "true",
      "data-1p-ignore": "true",
      "data-bwignore": "true",
      "data-protonpass-ignore": "true",
      "data-form-type": "other"
    });
    return input;
  }
  function keyInputRow(input) {
    const row = el("div", {
      class: "tbms-row"
    }, [ input ]);
    const toggle = el("button", {
      type: "button",
      class: "tbms-btn",
      text: "Show",
      title: "Reveal the key you pasted"
    });
    toggle.addEventListener("click", function() {
      const nowMasked = input.classList.toggle("tbms-masked");
      toggle.textContent = nowMasked ? "Show" : "Hide";
    });
    row.appendChild(toggle);
    return row;
  }
  function renderKeyReport(rows, host) {
    if (!host) return;
    host.innerHTML = "";
    if (!rows || !rows.length) return;
    const blocked = rows.filter(function(r) {
      return !r.ok && (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS);
    });
    if (blocked.length) {
      host.appendChild(el("div", {
        class: "tbms-pill tbms-bad",
        style: "margin-bottom:6px;display:inline-block;",
        text: "Raise this key to Limited"
      }));
    } else {
      host.appendChild(el("div", {
        class: "tbms-pill tbms-ok",
        style: "margin-bottom:6px;display:inline-block;",
        text: "Key can read everything the script needs"
      }));
    }
    const table = el("table", {
      class: "tbms-table"
    });
    rows.forEach(function(r) {
      const tr = el("tr");
      tr.appendChild(el("td", {
        class: r.ok ? "" : "tbms-wrap",
        text: (r.ok ? "✓ " : "✗ ") + r.label
      }));
      const noteTd = el("td", {
        class: "tbms-wrap"
      });
      if (r.note) {
        noteTd.appendChild(el("span", {
          class: "tbms-pill " + (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS ? "tbms-bad" : r.code === ERR_PRIVATE ? "tbms-warn" : "tbms-warn"),
          text: r.note
        }));
      }
      tr.appendChild(noteTd);
      table.appendChild(tr);
    });
    host.appendChild(table);
    host.appendChild(el("div", {
      class: "tbms-hint",
      style: "margin-top:6px;",
      text: '"Private for this player" is not a key problem - that specific player keeps the datum hidden. "Returned nothing" means the call worked but Torn withheld the value.'
    }));
  }
  function renderSetupTab() {
    const s = section("setup");
    s.innerHTML = "";
    const keySec = el("div", {
      class: "tbms-sec"
    });
    keySec.appendChild(el("h4", {
      text: "API keys"
    }));
    keySec.appendChild(el("div", {
      class: "tbms-hint",
      text: "Kept in Tampermonkey storage. Sent only to api.torn.com, ffscouter.com and weav3r.dev."
    }));
    keySec.appendChild(el("div", {
      class: "tbms-hint",
      style: "margin:6px 0;border-left:2px solid #2f97a8;padding-left:8px;",
      text: 'Use a LIMITED key. Torn has four levels - Public, Minimal, Limited, Full - and this script has to read other players’ bazaars, property and battle stats, which Public and Minimal are not allowed to do. Full works too. If a selection is out of reach Torn answers "access level of this key is not high enough", and the test below will tell you exactly which ones are blocked.'
    }));
    const keyInput = makeKeyField("tbms-torn-key", "your 16-character Torn API key");
    keyInput.value = settings.api.tornKey || "";
    keyInput.addEventListener("change", function() {
      settings.api.tornKey = keyInput.value.trim();
      saveSettings();
    });
    keySec.appendChild(keyInputRow(keyInput));
    const ffKeyInput = makeKeyField("tbms-ff-key", "(optional) FFScouter key - blank reuses the Torn key");
    ffKeyInput.value = settings.api.ffKey || "";
    ffKeyInput.addEventListener("change", function() {
      settings.api.ffKey = ffKeyInput.value.trim();
      saveSettings();
    });
    keySec.appendChild(el("div", {
      class: "tbms-hint",
      style: "margin-top:8px;",
      text: "FFScouter key (optional). Leave blank to reuse the Torn key."
    }));
    keySec.appendChild(keyInputRow(ffKeyInput));
    const meritsRow = el("div", {
      class: "tbms-row"
    });
    meritsRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Masterful Looting merits (0-10)",
      title: "Each point adds 5% to what a mug takes, up to +50% at 10 points."
    }));
    const meritsInput = el("input", {
      id: "tbms-merits",
      class: "tbms-num",
      type: "number",
      min: "0",
      max: "10"
    });
    meritsInput.value = settings.econ.mugMerits || 0;
    meritsInput.addEventListener("change", function() {
      const v = Number(meritsInput.value);
      settings.econ.mugMerits = isFinite(v) ? clamp(Math.round(v), 0, 10) : 0;
      meritsInput.value = settings.econ.mugMerits;
      saveSettings();
    });
    meritsRow.appendChild(meritsInput);
    keySec.appendChild(meritsRow);
    const plunderRow = el("div", {
      class: "tbms-row"
    });
    plunderRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Plunder weapon bonus % (0-49)",
      title: "The Plunder bonus on your weapon, if it has one. Added on top of the merits."
    }));
    const plunderInput = el("input", {
      id: "tbms-plunder",
      class: "tbms-num",
      type: "number",
      min: "0",
      max: "49"
    });
    plunderInput.value = settings.econ.mugPlunder || 0;
    plunderInput.addEventListener("change", function() {
      const v = Number(plunderInput.value);
      settings.econ.mugPlunder = isFinite(v) ? clamp(Math.round(v), 0, 49) : 0;
      plunderInput.value = settings.econ.mugPlunder;
      saveSettings();
    });
    plunderRow.appendChild(plunderInput);
    plunderRow.appendChild(el("span", {
      class: "tbms-suffix",
      text: "blank or 0 if none"
    }));
    keySec.appendChild(plunderRow);
    const btnRow = el("div", {
      class: "tbms-row"
    });
    const reportHost = el("div", {
      id: "tbms-key-report",
      style: "margin-top:8px;"
    });
    const loadBtn = el("button", {
      class: "tbms-btn tbms-primary",
      text: "Test keys & load my stats"
    });
    loadBtn.addEventListener("click", async function() {
      loadBtn.disabled = true;
      setStatus("Checking keys...");
      try {
        const me = normaliseUser(await fetchSelf());
        const bs = parseBattleStats(me.stats);
        settings.me.id = me.id || settings.me.id;
        settings.me.name = me.name || settings.me.name;
        settings.me.level = me.level || settings.me.level;
        settings.me.factionId = me.factionId || 0;
        if (bs) {
          settings.me.bs = bs;
          settings.me.bsUpdated = Date.now();
        }
        saveSettings();
        renderSetupTab();
        let ffNote = "";
        try {
          const check = await ffCheckKey();
          if (check && check.is_registered === false) {
            ffNote = " FFScouter does not recognise that key yet - register it at ffscouter.com or stat estimates will come back empty.";
            setStatus(settings.me.name + ": stats loaded." + ffNote, "warn");
          } else {
            ffNote = " FFScouter: registered" + (check && check.is_premium ? " (premium)" : "") + ".";
            setStatus(settings.me.name + ": stats loaded." + ffNote, "ok");
          }
        } catch (e) {
          ffNote = " Could not reach FFScouter: " + e.message;
          setStatus(settings.me.name + ": stats loaded." + ffNote, "warn");
        }
        try {
          const report = await probeKeyCapabilities();
          renderKeyReport(report, document.getElementById("tbms-key-report"));
          const blocked = report.filter(function(r) {
            return !r.ok && (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS);
          }).length;
          if (blocked) {
            setStatus(blocked + " selection(s) are above this key’s level - raise it to Limited. See the report below.", "warn");
          }
        } catch (e) {
          log("Key probe failed: " + e.message, "warn");
        }
      } catch (e) {
        setStatus("Torn API: " + e.message, "error");
      } finally {
        loadBtn.disabled = false;
      }
    });
    btnRow.appendChild(loadBtn);
    const probeBtn = el("button", {
      class: "tbms-btn",
      text: "Re-check key level"
    });
    probeBtn.addEventListener("click", async function() {
      probeBtn.disabled = true;
      setStatus("Asking Torn what this key may read...", "progress");
      try {
        const report = await probeKeyCapabilities();
        renderKeyReport(report, reportHost);
        setStatus("Key checked - see the report below.", "ok");
      } catch (e) {
        setStatus("Key check failed: " + e.message, "error");
      } finally {
        probeBtn.disabled = false;
      }
    });
    btnRow.appendChild(probeBtn);
    const clearBtn = el("button", {
      class: "tbms-btn",
      text: "Clear cached player data"
    });
    clearBtn.addEventListener("click", function() {
      cacheFlush();
      setStatus("Cache cleared.", "ok");
    });
    btnRow.appendChild(clearBtn);
    const resetBtn = el("button", {
      class: "tbms-btn tbms-danger",
      text: "Reset all settings"
    });
    resetBtn.addEventListener("click", function() {
      if (!window.confirm("Reset every setting, including your API keys?")) return;
      settings = mergeDefaults(DEFAULT_SETTINGS, {});
      saveSettings();
      renderFiltersTab();
      renderSetupTab();
      renderScanTab();
      renderResults();
      setStatus("Settings reset.", "ok");
    });
    btnRow.appendChild(resetBtn);
    keySec.appendChild(btnRow);
    keySec.appendChild(reportHost);
    s.appendChild(keySec);
    const meSec = el("div", {
      class: "tbms-sec"
    });
    meSec.appendChild(el("h4", {
      text: "Your stats (the yardstick)"
    }));
    const meGrid = el("div", {
      class: "tbms-kv"
    });
    meGrid.appendChild(el("b", {
      text: "Name"
    }));
    meGrid.appendChild(el("span", {
      text: settings.me.name || "not loaded"
    }));
    meGrid.appendChild(el("b", {
      text: "Player ID"
    }));
    meGrid.appendChild(el("span", {
      text: settings.me.id ? String(settings.me.id) : "unknown"
    }));
    meGrid.appendChild(el("b", {
      text: "Total battle stats"
    }));
    meGrid.appendChild(el("span", {
      text: settings.me.bs ? formatNumber(settings.me.bs) : "unknown"
    }));
    meGrid.appendChild(el("b", {
      text: "Faction"
    }));
    meGrid.appendChild(el("span", {
      text: settings.me.factionId ? String(settings.me.factionId) : "none"
    }));
    meSec.appendChild(meGrid);
    meSec.appendChild(el("div", {
      class: "tbms-hint",
      text: 'Used as the yardstick for "stats at most mine x".'
    }));
    const bsManual = el("div", {
      class: "tbms-row"
    });
    bsManual.appendChild(el("label", {
      text: "Or type your total stats manually"
    }));
    const bsInput = el("input", {
      class: "tbms-num",
      type: "number"
    });
    bsInput.value = settings.me.bs || 0;
    bsInput.addEventListener("change", function() {
      settings.me.bs = Number(bsInput.value) || 0;
      saveSettings();
      renderSetupTab();
    });
    bsManual.appendChild(bsInput);
    meSec.appendChild(bsManual);
    s.appendChild(meSec);
    const advSec = el("details", {
      class: "tbms-adv"
    });
    advSec.appendChild(el("summary", {
      text: "Advanced settings"
    }));
    const diagSec = el("div", {
      class: "tbms-sec"
    });
    diagSec.appendChild(el("h4", {
      text: "Last unexpected response"
    }));
    const diagHost = el("div", {
      id: "tbms-diag",
      class: "tbms-hint"
    });
    const paintDiag = function() {
      diagHost.innerHTML = "";
      if (!diagnostics.lastRaw) {
        diagHost.textContent = "Nothing odd seen yet.";
        return;
      }
      diagHost.appendChild(el("div", {
        text: "From: " + diagnostics.lastRawLabel
      }));
      const pre = el("div", {
        style: "max-height:130px;overflow:auto;background:#0e1418;border:1px solid #33434c;" + "border-radius:6px;padding:6px;margin:6px 0;font-family:monospace;font-size:11px;" + "white-space:pre-wrap;word-break:break-all;color:#9fb4bd;"
      });
      pre.textContent = diagnostics.lastRaw;
      diagHost.appendChild(pre);
      const btn = el("button", {
        class: "tbms-btn",
        text: "Copy it"
      });
      btn.addEventListener("click", function() {
        copyToClipboard(diagnostics.lastRawLabel + "\n" + diagnostics.lastRaw);
        setStatus("Raw response copied.", "ok");
      });
      diagHost.appendChild(btn);
    };
    paintDiag();
    diagSec.appendChild(diagHost);
    advSec.appendChild(diagSec);
    const perfSec = el("div", {
      class: "tbms-sec"
    });
    perfSec.appendChild(el("h4", {
      text: "Requests & performance"
    }));
    [ [ "api.delayMs", "Gap between Torn calls (ms)", "Torn allows 100/minute. Raising this is the safest knob." ], [ "api.maxPerMinute", "Torn calls per minute cap" ], [ "api.workers", "Parallel Torn lookups" ], [ "api.cacheMinutes", "Reuse cached player data (minutes)" ], [ "api.ffChunkSize", "IDs per FFScouter request" ], [ "api.rateLimitWaitMs", "Wait after a rate limit (ms)" ], [ "scan.maxTargetsPerScan", "Maximum sellers scanned per run" ] ].forEach(function(triple) {
      const row = el("div", {
        class: "tbms-row"
      });
      row.appendChild(el("label", {
        text: triple[1]
      }));
      const input = el("input", {
        class: "tbms-num",
        type: "number"
      });
      input.value = getPath(triple[0]);
      input.addEventListener("change", function() {
        const v = Number(input.value);
        setPath(triple[0], isFinite(v) && v > 0 ? v : 1);
      });
      row.appendChild(input);
      if (triple[2]) row.appendChild(el("span", {
        class: "tbms-hint",
        text: triple[2]
      }));
      perfSec.appendChild(row);
    });
    const autoRow = el("div", {
      class: "tbms-row"
    });
    const autoSwitch = el("label", {
      class: "tbms-switch"
    });
    const autoInput = el("input", {
      type: "checkbox"
    });
    autoInput.checked = !!settings.scan.autoHarvest;
    autoInput.addEventListener("change", function() {
      settings.scan.autoHarvest = autoInput.checked;
      saveSettings();
    });
    autoSwitch.appendChild(autoInput);
    autoSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    autoRow.appendChild(autoSwitch);
    autoRow.appendChild(el("label", {
      text: "Re-count sellers as the page updates"
    }));
    perfSec.appendChild(autoRow);
    const scriptRow = el("div", {
      class: "tbms-row"
    });
    const scriptSwitch = el("label", {
      class: "tbms-switch"
    });
    const scriptInput = el("input", {
      type: "checkbox"
    });
    scriptInput.checked = !!settings.scan.scanScripts;
    scriptInput.addEventListener("change", function() {
      settings.scan.scanScripts = scriptInput.checked;
      saveSettings();
    });
    scriptSwitch.appendChild(scriptInput);
    scriptSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    scriptRow.appendChild(scriptSwitch);
    scriptRow.appendChild(el("label", {
      text: "Also read inline page scripts for seller IDs"
    }));
    scriptRow.appendChild(el("span", {
      class: "tbms-hint",
      text: "Wider net, but can pick up unrelated numbers as candidates."
    }));
    perfSec.appendChild(scriptRow);
    advSec.appendChild(perfSec);
    const srcSec = el("div", {
      class: "tbms-sec"
    });
    srcSec.appendChild(el("h4", {
      text: "Where seller lists come from"
    }));
    srcSec.appendChild(el("div", {
      class: "tbms-hint",
      text: "Torn’s own API is always tried first. It is authoritative and live, and needs no extra service."
    }));
    const wRow = el("div", {
      class: "tbms-row"
    });
    const wSwitch = el("label", {
      class: "tbms-switch"
    });
    const wInput = el("input", {
      type: "checkbox"
    });
    wInput.checked = !!settings.scan.useWeav3r;
    wInput.addEventListener("change", function() {
      settings.scan.useWeav3r = wInput.checked;
      saveSettings();
    });
    wSwitch.appendChild(wInput);
    wSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    wRow.appendChild(wSwitch);
    const wLabel = el("label", {
      class: "tbms-label",
      text: "Fall back to the weav3r.dev scanner",
      title: "A community-run bazaar scanner. Only your item ids are sent, never your API key. Turn it off to use Torn alone."
    });
    wRow.appendChild(wLabel);
    srcSec.appendChild(wRow);
    const pRow = el("div", {
      class: "tbms-row"
    });
    const pSwitch = el("label", {
      class: "tbms-switch"
    });
    const pInput = el("input", {
      type: "checkbox"
    });
    pInput.checked = !!settings.scan.fetchProperty;
    pInput.addEventListener("change", function() {
      settings.scan.fetchProperty = pInput.checked;
      saveSettings();
    });
    pSwitch.appendChild(pInput);
    pSwitch.appendChild(el("span", {
      class: "tbms-slider"
    }));
    pRow.appendChild(pSwitch);
    pRow.appendChild(el("label", {
      class: "tbms-label",
      text: "Look up where they live (v2)",
      title: "Torn only exposes property through API v2, one extra request per viable player. Also gives the vault when Torn reveals it."
    }));
    srcSec.appendChild(pRow);
    advSec.appendChild(srcSec);
    s.appendChild(advSec);
    const about = el("div", {
      class: "tbms-sec"
    });
    about.appendChild(el("div", {
      class: "tbms-hint",
      text: "Read-only recon. Never buys, attacks or mugs. Torn and FFScouter rate limits are handled automatically, including waiting out a rate limit and resuming."
    }));
    about.appendChild(el("div", {
      class: "tbms-tip",
      text: TIP_LINE
    }));
    s.appendChild(about);
  }
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;
    GM_registerMenuCommand("Open Buy-Mug Scout", function() {
      settings.ui.open = true;
      syncPanelVisibility();
    });
    GM_registerMenuCommand("Scan sellers on this page", function() {
      settings.ui.open = true;
      syncPanelVisibility();
      runScan();
    });
    GM_registerMenuCommand("Reset the opener button position", function() {
      settings.ui.fabPos = null;
      settings.ui.panelPos = null;
      settings.ui.panelSize = null;
      saveSettings();
      applyFabPos();
      applyPanelGeom();
      settings.ui.open = true;
      syncPanelVisibility();
      setStatus("Opener and panel reset to their default spot and size.", "ok");
    });
  }
  function observePage() {
    if (!settings.scan.autoHarvest) return;
    let scheduled = false;
    const mo = new MutationObserver(function() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function() {
        scheduled = false;
        scheduleHarvest();
      }, 500);
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  function watchNavigation() {
    window.addEventListener("hashchange", scheduleHarvest);
    window.addEventListener("popstate", scheduleHarvest);
    let last = location.href;
    setInterval(function() {
      if (location.href !== last) {
        last = location.href;
        scheduleHarvest();
      }
    }, 1500);
  }
  function init() {
    if (document.getElementById("tbms-root")) return;
    injectStyle();
    buildPanel();
    registerMenu();
    observePage();
    watchNavigation();
    watchFooter();
    watchRateLimitPauses();
    startAutoTicker();
    startWatchTicker();
    paintWatchTab();
    cachePrune();
    const restored = restoreResults();
    log(restored ? "Buy-Mug Scout ready - restored " + restored + " result(s) from the last scan." : "Buy-Mug Scout v" + VERSION + " ready.", "info");
    if (settings.scan.auto.on && settings.scan.auto.itemId) {
      setStatus("Resuming auto-scan after page load...", "progress");
      scheduleAutoScan(3e3);
    }
    if (!settings.api.tornKey) {
      settings.ui.open = true;
      syncPanelVisibility();
      switchTab("setup");
      setStatus("Paste your Torn API key to get started.", "warn");
    }
  }
  function watchRateLimitPauses() {
    onQueuePaused(function(until) {
      (function tick() {
        if (!scan.running) return;
        const left = Math.ceil((until - Date.now()) / 1e3);
        if (left <= 0) {
          setStatus("Rate limit window passed - resuming.", "progress");
          return;
        }
        setStatus("Rate limit reached - resuming in " + left + "s", "warn");
        setTimeout(tick, 1e3);
      })();
    });
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      toNumber: toNumber,
      clamp: clamp,
      formatNumber: formatNumber,
      readStatus: readStatus,
      detectVault: detectVault,
      summariseBazaar: summariseBazaar,
      estimateEconomics: estimateEconomics,
      evaluateTarget: evaluateTarget,
      extractIdsFromHtml: extractIdsFromHtml,
      isValidPlayerId: isValidPlayerId,
      parseBattleStats: parseBattleStats,
      normaliseUser: normaliseUser,
      toItemArray: toItemArray,
      normaliseBazaarRows: normaliseBazaarRows,
      propertyLabel: propertyLabel,
      mugPercent: mugPercent,
      mugTake: mugTake,
      mugBand: mugBand,
      mugMultiplier: mugMultiplier,
      mugModifierLabel: mugModifierLabel,
      lootBreakdown: lootBreakdown,
      predictedLoot: predictedLoot,
      MUG_BASE_LOW: MUG_BASE_LOW,
      MUG_BASE_HIGH: MUG_BASE_HIGH,
      buildSubject: buildSubject,
      buildStubSubject: buildStubSubject,
      secondsUntilFree: secondsUntilFree,
      formatCountdown: formatCountdown,
      mergeDefaults: mergeDefaults,
      DEFAULT_SETTINGS: DEFAULT_SETTINGS,
      toCsv: toCsv
    };
  }
  if (typeof document !== "undefined" && document.body) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
