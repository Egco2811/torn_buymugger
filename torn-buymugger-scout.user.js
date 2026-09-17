// ==UserScript==
// @name         Torn Buy-Mug Scout
// @namespace    tbms
// @version      1.0.0
// @description  Flags buy-muggable bazaar & item-market sellers using FFScouter battle-stat estimates, with toggleable filters, persistent API-key storage and an in-page UI.
// @author       tbms
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

/* =====================================================================
 * Torn Buy-Mug Scout
 * ---------------------------------------------------------------------
 * WHAT THIS DOES
 *   1. Harvests seller IDs straight off the page you are looking at
 *      (bazaar, item market, item page, ...).
 *   2. Asks FFScouter (in one batched call) how strong those sellers
 *      look: fair fight score + estimated battle stats.
 *   3. Asks the Torn API what those sellers actually have: cash on hand,
 *      bazaar contents & value, and whether they own a property vault.
 *   4. Scores every seller against your saved battle stats and your
 *      filter settings, then shows you the shortlist.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It never buys, attacks, mugs or otherwise acts for you. It is a
 *   read-only recon tool. Every outbound request is a GET to
 *   api.torn.com or ffscouter.com. You keep the trigger.
 *
 * NOTE ON API KEYS
 *   Your Torn key is stored via Tampermonkey's own storage and is only
 *   ever sent to api.torn.com and (for stat estimates) ffscouter.com.
 *   FFScouter currently requires the key to be registered on their site
 *   first; the Setup tab checks this for you and tells you if it is not.
 * ===================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * 0. Constants
   * --------------------------------------------------------------- */
  const VERSION = '1.0.0';
  const STORE_PREFIX = 'tbms_';
  const TORN_BASE = 'https://api.torn.com';
  const FF_BASE = 'https://ffscouter.com/api/v1';

  // Torn's documented ceiling is 100 requests / minute / key. We stay
  // under it and treat "too many requests" as a hard back-off signal.
  const TORN_HARD_CAP = 100;

  // Torn error codes we care about.
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

  // Torn's own footer buttons. We clone one of these so our opener inherits
  // Torn's styling instead of floating on top of the bar.
  const FOOTER_REF_IDS = ['notes_panel_button', 'people_panel_button'];
  const FOOTER_BTN_ID = 'tbms-footer-btn';

  // Must match the width in #tbms-panel's CSS rule below.
  const PANEL_W = 700;

  // Community bazaar scanner used as a second source for seller lists.
  const WEAV3R_BASE = 'https://weav3r.dev/api';

  /* ---------------------------------------------------------------
   * 1. Storage layer (Tampermonkey first, localStorage fallback)
   * --------------------------------------------------------------- */
  const hasGM =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function rawGet(key) {
    try {
      if (hasGM) {
        const v = GM_getValue(key, undefined);
        if (v !== undefined) return v;
      } else {
        const v = window.localStorage.getItem(STORE_PREFIX + key);
        if (v !== null) return v;
      }
    } catch (e) {
      /* storage unavailable - fall through to default */
    }
    return undefined;
  }

  function rawSet(key, value) {
    try {
      if (hasGM) GM_setValue(key, value);
      else window.localStorage.setItem(STORE_PREFIX + key, value);
    } catch (e) {
      /* quota or privacy mode - settings simply will not persist */
    }
  }

  function rawDelete(key) {
    try {
      if (hasGM) {
        // Blanking also works if GM_deleteValue is unavailable, because
        // the loader treats an empty string as "nothing stored".
        if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else GM_setValue(key, '');
        return;
      }
      window.localStorage.removeItem(STORE_PREFIX + key);
    } catch (e) {
      /* ignore */
    }
  }

  function loadJSON(key, fallback) {
    const raw = rawGet(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    rawSet(key, JSON.stringify(value));
  }

  /* ---------------------------------------------------------------
   * 2. Settings model
   *
   * Every filter is { on: boolean, value: number } (or a plain string
   * for selects) so the UI can toggle *and* retune each one.
   * --------------------------------------------------------------- */
  const DEFAULT_SETTINGS = {
    api: {
      tornKey: '',
      // Optional: use a different key for FFScouter than for Torn.
      ffKey: '',
      delayMs: 700,          // minimum gap between Torn API calls
      maxPerMinute: 90,      // self-imposed Torn rate limit
      cacheMinutes: 15,      // reuse a player's data this long
      ffChunkSize: 60,       // IDs per FFScouter request
      workers: 3,            // concurrent Torn lookups
      rateLimitWaitMs: 60000,// pause this long when Torn says "too many requests"
      rateLimitRetries: 2    // how many times to wait-and-resume before giving up
    },
    me: {
      id: 0,
      name: '',
      level: 0,
      factionId: 0,
      bs: 0,                 // your total battle stats
      bsUpdated: 0
    },
    scan: {
      autoHarvest: true,     // re-read the page as the DOM changes
      scanScripts: false,    // also grep inline <script> text for IDs
      maxTargetsPerScan: 80,
      // Seller lists come from bazaar data, not from what is on screen.
      useWeav3r: true,       // community scanner as a second source
      lastItemId: 0,         // remembers the item you scanned last
      // Continuous background scanning. `on` is persisted, so a paused loop
      // stays paused and a running loop picks up again after a refresh.
      auto: { on: false, itemId: 0, intervalSec: 120 }
    },
    econ: {
      mugPct: 0.9,           // fraction of cash you expect to walk away with
      factionCut: 0.0,       // fraction your faction takes off the top
      liquidation: 0.95,     // what a bought item is really worth to you
      basket: 'all'          // 'all' | 'deals'
    },
    filters: {
      // --- where they are ---
      inTornOnly:        { on: true,  value: 1 },
      notHospitalised:   { on: true,  value: 1 },
      // Exceptions to the two rules above: someone who lands or is
      // discharged within this many minutes is worth queueing up for.
      soonInTorn:        { on: true,  value: 10 },
      soonOutOfHospital: { on: true,  value: 10 },
      maxLastAction:     { on: true,  value: 30 },     // minutes
      // --- what they are carrying ---
      minBazaarValue:    { on: true,  value: 1000000 },
      minMoney:          { on: false, value: 0 },
      minItemCount:      { on: false, value: 1 },
      minWorthyItems:    { on: false, value: 1 },
      worthyUnitPrice:   { on: true,  value: 100000 }, // what counts as "worthy"
      minDealCount:      { on: false, value: 1 },
      dealDiscount:      { on: true,  value: 0.15 },   // >=15% under market price
      vault:             'ignore',                     // ignore | require | exclude
      // --- how strong they are ---
      maxFairFight:      { on: true,  value: 2.0 },
      bsVsMine:          { on: true,  value: 1.0 },    // their BS <= mine * value
      maxBsEstimate:     { on: false, value: 500000000 },
      allowUnknownStats: { on: true,  value: 1 },
      minScore:          { on: false, value: 0 },
      // --- exclusions ---
      sameFaction:       { on: true,  value: 1 },
      minLevel:          { on: false, value: 1 },
      maxLevel:          { on: false, value: 100 }
    },
    ui: {
      open: false,
      tab: 'scan',
      onlyMatches: false,
      fabPos: null,          // {left, top} once the floating fallback is dragged
      panelPos: null,        // {left, top} once the panel has been dragged
      panelSize: null        // {w, h} once the panel has been resized
    }
  };

  const SETTINGS_KEY = 'settings';
  const CACHE_KEY = 'cache_v1';

  function mergeDefaults(base, incoming) {
    // Shallow-by-section deep merge so adding new settings later never
    // wipes a returning user's saved configuration.
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!incoming || typeof incoming !== 'object') return out;
    Object.keys(base).forEach(function (k) {
      const b = base[k];
      const i = incoming[k];
      if (i === undefined) return;
      if (b && typeof b === 'object' && !Array.isArray(b)) {
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
    saveTimer = setTimeout(function () {
      saveJSON(SETTINGS_KEY, settings);
    }, 150);
  }

  /* ---------------------------------------------------------------
   * 3. Result cache
   *
   * Player data goes stale slowly, API calls are rationed, so we keep
   * a per-player cache with a configurable TTL.
   * --------------------------------------------------------------- */
  let cache = loadJSON(CACHE_KEY, {});

  function cachePrune() {
    const ttl = Math.max(1, settings.api.cacheMinutes) * 60000;
    const now = Date.now();
    let changed = false;
    Object.keys(cache).forEach(function (id) {
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
    const ttl = Math.max(1, settings.api.cacheMinutes) * 60000;
    if (Date.now() - (hit.at || 0) > ttl) return null;
    return hit.data;
  }

  function cacheSet(id, data) {
    cache[id] = { at: Date.now(), data: data };
  }

  function cacheFlush() {
    cache = {};
    rawDelete(CACHE_KEY);
  }

  /* ---------------------------------------------------------------
   * 4. Networking
   * --------------------------------------------------------------- */
  const hasGMX = typeof GM_xmlhttpRequest === 'function';

  function httpGet(url) {
    return new Promise(function (resolve, reject) {
      if (hasGMX) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: 25000,
          headers: { Accept: 'application/json' },
          onload: function (res) {
            resolve({ status: res.status, text: res.responseText || '' });
          },
          onerror: function () {
            reject(new Error('Network error contacting ' + hostOf(url)));
          },
          ontimeout: function () {
            reject(new Error('Timed out contacting ' + hostOf(url)));
          }
        });
      } else {
        fetch(url, { credentials: 'omit' })
          .then(function (r) {
            return r.text().then(function (t) {
              resolve({ status: r.status, text: t });
            });
          })
          .catch(reject);
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
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /* --- Torn request queue: serialised, interval-spaced, minute-capped -- */
  const q = { chain: Promise.resolve(), stamps: [], lastAt: 0, pausedUntil: 0, waiters: [] };

  /**
   * Hitting Torn's ceiling is a normal event on a busy bazaar page, not a
   * failure. Every worker observes `pausedUntil`, so one 429 parks the
   * whole pool instead of each worker discovering the limit separately,
   * and the scan resumes by itself once the window rolls over.
   */
  function pauseTornQueue(ms, reason) {
    const until = Date.now() + ms;
    if (until <= q.pausedUntil) return;
    q.pausedUntil = until;
    (q.waiters || []).forEach(function (fn) {
      try {
        fn(until, reason);
      } catch (e) {
        /* status callback only */
      }
    });
  }

  function onQueuePaused(fn) {
    q.waiters = q.waiters || [];
    q.waiters.push(fn);
  }

  function enqueue(fn) {
    const run = q.chain.then(async function () {
      const delay = Math.max(0, settings.api.delayMs, 0);
      for (;;) {
        if (q.pausedUntil > Date.now()) {
          await sleep(Math.min(q.pausedUntil - Date.now(), 5000));
          continue;
        }
        const now = Date.now();
        const gap = q.lastAt + delay - now;
        if (gap > 0) {
          await sleep(gap);
          continue;
        }
        while (q.stamps.length && now - q.stamps[0] > 60000) q.stamps.shift();
        const cap = Math.min(
          TORN_HARD_CAP,
          Math.max(1, settings.api.maxPerMinute || 90)
        );
        if (q.stamps.length >= cap) {
          await sleep(60000 - (now - q.stamps[0]) + 120);
          continue;
        }
        break;
      }
      q.lastAt = Date.now();
      q.stamps.push(q.lastAt);
      return fn();
    });
    q.chain = run.catch(function () {});
    return run;
  }

  async function tornGet(pathAndQuery) {
    return enqueue(async function () {
      const url = TORN_BASE + pathAndQuery;
      const res = await httpGet(url);
      let data;
      try {
        data = JSON.parse(res.text);
      } catch (e) {
        return { ok: false, code: -1, error: 'Unparseable response from Torn' };
      }
      if (data && data.error) {
        return { ok: false, code: data.error.code, error: data.error.error };
      }
      return { ok: true, data: data };
    });
  }

  async function ffGet(pathAndQuery) {
    // FFScouter is IP-limited (20/min) rather than key-limited, and we
    // batch heavily, so it does not share Torn's queue.
    const res = await httpGet(FF_BASE + pathAndQuery);
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error('Unparseable response from FFScouter');
    }
    if (data && !Array.isArray(data) && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  /* ---------------------------------------------------------------
   * 5. Torn API
   * --------------------------------------------------------------- */
  const KEY_URL_SAFE = function (k) {
    return encodeURIComponent(k || '');
  };

  /**
   * Fetch a player. Torn rejects a whole request if one selection is not
   * permitted (private battle stats are the usual culprit), so we walk
   * down a ladder of narrower selections instead of failing outright.
   */
  async function fetchPlayer(id) {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const ladder = [
      'profile,basic,stats,bazaar,property,money',
      'profile,basic,bazaar,property,money',
      'profile,basic,bazaar,money',
      'profile,basic'
    ];
    let lastErr = null;

    for (let i = 0; i < ladder.length; i++) {
      const res = await tornGet(
        '/user/' + id + '?selections=' + ladder[i] + '&key=' + key
      );
      if (res.ok) return { data: res.data, selections: ladder[i] };

      // Per-minute ceiling: worth waiting out.
      if (res.code === ERR_TOO_MANY) {
        const e = new Error(res.error);
        e.rateLimit = true;
        throw e;
      }
      // Daily allowance exhausted: waiting a minute changes nothing.
      if (res.code === ERR_DAILY_LIMIT) {
        const e = new Error(res.error);
        e.fatal = true;
        e.dailyLimit = true;
        throw e;
      }
      // A bad key fails identically for every selection, so walking the
      // rest of the ladder would just burn requests.
      if (res.code === ERR_BAD_KEY || res.code === ERR_KEY_DISABLED) {
        const e = new Error(res.error);
        e.badKey = true;
        e.fatal = true; // aborts the scan rather than retrying per player
        throw e;
      }
      if (res.code === ERR_BAD_ID) {
        const e = new Error(res.error);
        e.badId = true;
        throw e;
      }
      lastErr = res;
      // ERR_ACCESS / ERR_FIELDS / strange backend hiccups -> try narrower.
      if (i === ladder.length - 1) break;
    }
    const e = new Error((lastErr && lastErr.error) || 'Lookup failed');
    e.tornCode = lastErr && lastErr.code;
    throw e;
  }

  async function fetchSelf() {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    // Keys differ in what they may read, so ask for the lot and narrow
    // down rather than failing the whole "load my stats" button.
    const ladder = [
      'profile,basic,battlestats,money',
      'profile,basic,money',
      'profile,basic'
    ];
    let lastErr = null;

    for (let i = 0; i < ladder.length; i++) {
      const res = await tornGet('/user/?selections=' + ladder[i] + '&key=' + key);
      if (res.ok) return res.data;
      lastErr = res;
      if (res.code === ERR_BAD_KEY || res.code === ERR_KEY_DISABLED) break;
    }

    const e = new Error((lastErr && lastErr.error) || 'Lookup failed');
    e.tornCode = lastErr && lastErr.code;
    throw e;
  }

  function parseBattleStats(node) {
    if (!node) return null;
    const keys = ['strength', 'speed', 'dexterity', 'defense'];
    const parts = keys.map(function (k) {
      return toNumber(node[k]);
    });
    if (parts.every(function (v) {
      return v === null;
    })) return null;
    const sum = parts.reduce(function (a, b) {
      return a + (b || 0);
    }, 0);
    if (node.total !== undefined && node.total !== null && toNumber(node.total) === null) {
      return sum || null;
    }
    return toNumber(node.total) !== null ? toNumber(node.total) : sum;
  }

  /* ---------------------------------------------------------------
   * 6. Item + bazaar data (seller discovery without reading the screen)
   *
   * Two independent sources, both of which are data rather than markup:
   *   1. Torn's own API listing every bazaar offer for an item, each row
   *      carrying the seller's player id.
   *   2. weav3r.dev, a community bazaar scanner, used when the first
   *      source is unavailable or comes back empty.
   * --------------------------------------------------------------- */

  const ITEMS_CACHE_KEY = 'items_v1';
  const ITEMS_TTL_MS = 7 * 24 * 3600 * 1000; // item tables barely change
  const NAMES_CACHE_KEY = 'names_v1';

  /**
   * Player names we have learned, so a target is never shown as
   * "Player 1234567" just because one API call came back thin.
   */
  let nameCache = loadJSON(NAMES_CACHE_KEY, {});

  function rememberName(id, name) {
    if (!id || !name || /^Player \d+$/.test(name)) return;
    if (nameCache[id] === name) return;
    nameCache[id] = name;
    const keys = Object.keys(nameCache);
    if (keys.length > 2000) delete nameCache[keys[0]];
    saveJSON(NAMES_CACHE_KEY, nameCache);
  }

  function knownName(id) {
    return nameCache[id] || null;
  }

  /** Item index from the community scanner - needs no API key at all. */
  async function weav3rItemIndex() {
    const res = await httpGet(WEAV3R_BASE + '/marketplace?limit=2000');
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error('the item index was unreadable');
    }
    const list = data && data.items;
    if (!Array.isArray(list) || !list.length) throw new Error('no items in the response');
    const out = {};
    list.forEach(function (it) {
      if (!it || it.item_id == null || it.item_id <= 0) return; // skip sets/bundles
      out[it.item_id] = it.item_name || 'Item ' + it.item_id;
    });
    return out;
  }

  /**
   * Item id -> name. Torn first because it is authoritative, the community
   * index second because it needs no key - a picker that cannot resolve a
   * name is useless, so this must have two ways to succeed.
   */
  async function loadItemList(forceRefresh) {
    const cached = loadJSON(ITEMS_CACHE_KEY, null);
    if (
      !forceRefresh &&
      cached &&
      cached.at &&
      Date.now() - cached.at < ITEMS_TTL_MS &&
      Object.keys(cached.items || {}).length
    ) {
      return cached.items;
    }

    let items = null;
    if (settings.api.tornKey) {
      try {
        const key = KEY_URL_SAFE(settings.api.tornKey);
        const res = await tornGet('/torn/?selections=items&key=' + key);
        if (res.ok) {
          const raw = (res.data && res.data.items) || {};
          const out = {};
          Object.keys(raw).forEach(function (id) {
            out[id] = (raw[id] && raw[id].name) || 'Item ' + id;
          });
          if (Object.keys(out).length) items = out;
        }
      } catch (e) {
        log('Torn item list: ' + e.message, 'warn');
      }
    }

    if (!items && settings.scan.useWeav3r) {
      try {
        items = await weav3rItemIndex();
      } catch (e) {
        log('weav3r item list: ' + e.message, 'warn');
      }
    }

    if (items && Object.keys(items).length) {
      saveJSON(ITEMS_CACHE_KEY, { at: Date.now(), items: items });
      return items;
    }
    return {};
  }

  /**
   * Normalise bazaar rows from either source into {id, name, price, qty}.
   *
   * Torn's market payload is parsed defensively: the field names are
   * `ID`/`cost`/`quantity` in the documented v1 shape, but a wrong guess
   * here would silently produce zero sellers, so we accept the plausible
   * aliases and let the per-player lookup reject anything bogus.
   */
  function normaliseBazaarRows(rows) {
    const out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      const id = toNumber(row.player_id != null ? row.player_id : row.seller_id != null ? row.seller_id : row.ID);
      if (!isValidPlayerId(id)) return;
      const price = toNumber(row.cost != null ? row.cost : row.price);
      const qty = toNumber(row.quantity != null ? row.quantity : row.amount);
      out.push({
        id: id,
        name: row.player_name || row.name || null,
        price: price,
        qty: qty
      });
    });
    return out;
  }

  /** Seller list for one item from Torn's own API. */
  async function tornBazaarSellers(itemId) {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const res = await tornGet(
      '/market/' + itemId + '?selections=bazaar&key=' + key
    );
    if (!res.ok) {
      const e = new Error(res.error);
      e.tornCode = res.code;
      throw e;
    }
    return normaliseBazaarRows(res.data && res.data.bazaar);
  }

  /** Seller list for one item from the community scanner. */
  async function weav3rBazaarSellers(itemId) {
    const res = await httpGet(WEAV3R_BASE + '/marketplace/' + itemId + '?limit=200');
    let data;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      throw new Error('weav3r returned something unreadable');
    }
    if (!data || !Array.isArray(data.listings)) {
      throw new Error('weav3r returned no listings');
    }
    return {
      marketPrice: toNumber(data.market_price),
      bazaarAverage: toNumber(data.bazaar_average),
      sellers: normaliseBazaarRows(data.listings)
    };
  }

  /**
   * Best available seller list for an item. Torn first because it is
   * authoritative and live; the scanner second because it sometimes knows
   * about listings Torn will not enumerate for a given key level.
   */
  async function findBazaarSellers(itemId) {
    let tornError = null;
    try {
      const sellers = await tornBazaarSellers(itemId);
      if (sellers.length) return { source: 'torn', sellers: sellers };
      tornError = new Error('Torn listed no bazaar offers for this item');
    } catch (e) {
      tornError = e;
    }

    if (settings.scan.useWeav3r) {
      try {
        const out = await weav3rBazaarSellers(itemId);
        if (out.sellers.length) {
          return { source: 'weav3r', sellers: out.sellers, meta: out };
        }
      } catch (e) {
        log('weav3r: ' + e.message, 'warn');
      }
    }

    if (tornError) log('Torn bazaar lookup: ' + tornError.message, 'warn');
    return { source: null, sellers: [] };
  }

  /**
   * The item the page is about, taken from the URL rather than from
   * rendered text. Torn puts it in the query or the hash on every market,
   * bazaar and item page.
   */
  function currentItemId() {
    const href = window.location.href;
    const m =
      href.match(/[?&#/]itemID=(\d+)/i) ||
      href.match(/item\.php\?id=(\d+)/i) ||
      href.match(/[?&#/]item_?id=(\d+)/i);
    return m ? toNumber(m[1]) : null;
  }

  /* ---------------------------------------------------------------
   * 6b. FFScouter
   * --------------------------------------------------------------- */

  /**
   * Batch lookup. FFScouter returns an array of
   * { player_id, fair_fight, bs_estimate, bs_estimate_human, ... }
   * and returns nulls for players it has never seen.
   */
  async function ffLookup(ids) {
    const out = {};
    if (!ids.length) return out;
    const key = KEY_URL_SAFE(settings.api.ffKey || settings.api.tornKey);
    const chunk = Math.max(1, Math.min(200, settings.api.ffChunkSize || 60));

    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      let data;
      try {
        data = await ffGet(
          '/get-stats?key=' + key + '&targets=' + slice.join(',')
        );
      } catch (e) {
        // One bad batch should not sink the whole scan.
        log('FFScouter: ' + e.message, 'warn');
        continue;
      }
      const rows = Array.isArray(data) ? data : data && data.targets ? data.targets : [];
      rows.forEach(function (row) {
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
      if (i + chunk < ids.length) await sleep(3200); // stay under 20/min
    }
    return out;
  }

  /**
   * Is the key registered with FFScouter? Their API refuses unregistered
   * keys, and the error message they return is easy to misread as a Torn
   * problem, so we surface it explicitly at setup time.
   */
  async function ffCheckKey() {
    const key = KEY_URL_SAFE(settings.api.ffKey || settings.api.tornKey);
    return ffGet('/check-key?key=' + key);
  }

  /* ---------------------------------------------------------------
   * 7. Pure helpers + analysis (unit-testable outside the browser)
   * --------------------------------------------------------------- */

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[,\s$]/g, ''));
    return isFinite(n) ? n : null;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function formatNumber(n) {
    if (n === null || n === undefined || !isFinite(n)) return '-';
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(2) + 't';
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'b';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'm';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function formatMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return '-';
    return '$' + formatNumber(n);
  }

  function formatAgo(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return '-';
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm';
    if (seconds < 86400) return (seconds / 3600).toFixed(1) + 'h';
    return (seconds / 86400).toFixed(1) + 'd';
  }

  /**
   * Torn reports non-combat states such as Abroad / Travelling, and the
   * API's `state` field is the reliable signal. We also keep a light
   * fallback on the human-readable description for older payloads.
   */
  function readStatus(profile) {
    const st = (profile && profile.status) || {};
    const state = String(st.state || '').trim();
    const description = String(st.description || '').trim();
    const hay = (state + ' ' + description).toLowerCase();

    // Trust Torn's explicit `state` and only fall back to keyword-matching
    // the description when there is no state. Otherwise a description like
    // "Federal jail" gets misread as an ordinary jail sentence.
    const has = !!state;
    const is = function (name, re) {
      return has ? state.toLowerCase() === name : re.test(hay);
    };

    const isAbroad = is('abroad', /abroad/);
    const isTravelling = has
      ? state.toLowerCase() === 'traveling' || state.toLowerCase() === 'travelling'
      : /travelling|traveling/.test(hay);
    const isHospital = is('hospital', /hospital/);
    const isJail = is('jail', /jail/);
    const isFederal = is('federal', /federal/);
    const isFallen = has
      ? state.toLowerCase() === 'fallen'
      : /dead|fallen/.test(hay);
    const okay = has ? state.toLowerCase() === 'okay' : !description;

    const available =
      okay && !isAbroad && !isTravelling && !isHospital && !isJail && !isFederal && !isFallen;

    return {
      state: state || (description ? 'unknown' : 'Okay'),
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

  /**
   * Seconds until a target stops being abroad, hospitalised, jailed, &c.
   * Torn gives an absolute timestamp; null means "no end in sight".
   */
  function secondsUntilFree(status, nowSec) {
    if (!status || !status.until) return null;
    const now = nowSec || Math.floor(Date.now() / 1000);
    const left = status.until - now;
    return left > 0 ? left : 0;
  }

  /** "4m" / "45s" / "2.3h" - the countdown shown next to a state. */
  function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined) return null;
    if (seconds <= 0) return 'now';
    return formatAgo(seconds);
  }

  /**
   * Vault detection. The Torn API has moved this field around between
   * versions, so rather than betting on one key path we inspect the
   * property payload for any vault signal at all and pull a number out
   * of it when one is exposed. `hasVault === null` means "we could not
   * tell", which the filter treats as a soft unknown, not a "no".
   */
  function detectVault(propertySelection) {
    if (!propertySelection || typeof propertySelection !== 'object') {
      return { hasVault: null, vaultAmount: null };
    }

    let hasVault = null;
    let vaultAmount = null;

    // Top-level `vault` on the property selection == vault balance.
    if (propertySelection.vault !== undefined && propertySelection.vault !== null) {
      const amt = toNumber(propertySelection.vault);
      hasVault = true;
      vaultAmount = amt;
    }

    const props = propertySelection.properties || {};
    Object.keys(props).forEach(function (pid) {
      const p = props[pid];
      if (!p || typeof p !== 'object') return;
      if (hasVault === true) return;

      const flat = safeStringify(p).toLowerCase();
      if (flat.indexOf('vault') !== -1) {
        hasVault = true;
        const nested = findKeyValue(p, 'vault');
        const amt = toNumber(nested);
        if (amt !== null && vaultAmount === null) vaultAmount = amt;
      }
    });

    return { hasVault: hasVault, vaultAmount: vaultAmount };
  }

  function safeStringify(obj) {
    try {
      return JSON.stringify(obj) || '';
    } catch (e) {
      return '';
    }
  }

  function findKeyValue(obj, needle, depth) {
    depth = depth || 0;
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.toLowerCase().indexOf(needle) !== -1) {
        const v = obj[k];
        if (typeof v === 'number' || typeof v === 'string') return v;
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v && typeof v === 'object') {
        const got = findKeyValue(v, needle, depth + 1);
        if (got !== null) return got;
      }
    }
    return null;
  }

  /**
   * Turn a raw bazaar selection into the numbers the filters care about.
   * `price` is what the seller is asking; `market_price` is the going
   * rate, which is what tells us whether the listing is actually a deal.
   */
  function summariseBazaar(items, worthyUnitPrice, dealDiscount) {
    const list = Array.isArray(items) ? items : [];
    let buyout = 0;
    let marketValue = 0;
    let count = 0;
    let worthyCount = 0;
    let worthyBuyout = 0;
    let dealCount = 0;
    let dealBuyout = 0;
    let topItem = null;

    list.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      const price = toNumber(it.price) || 0;
      const qty = toNumber(it.quantity) || 0;
      const market = toNumber(it.market_price);
      const line = price * qty;
      const name = it.name || ('item #' + (it.ID || '?'));

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
        topItem = { name: name, value: line, qty: qty, price: price };
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

  /**
   * Rough buy-mug economics. This is a model with knobs, not a promise:
   * the real return depends on the game's mugging percentage, your
   * faction's cut and how fast you can move the goods. Every assumption
   * is editable in Setup so the number matches your reality.
   */
  function estimateEconomics(subject, econ) {
    const basket = econ.basket === 'deals' ? subject.bazaar.dealBuyout : subject.bazaar.buyout;
    const itemsWorth =
      (econ.basket === 'deals' ? subject.bazaar.dealBuyout : subject.bazaar.marketValue) *
      econ.liquidation;

    const spend = basket;
    const cashAfterPurchase = (subject.money || 0) + spend;
    const mugTake = cashAfterPurchase * econ.mugPct;
    const afterCut = mugTake * (1 - econ.factionCut);
    const net = afterCut - spend + itemsWorth;

    return {
      spend: spend,
      mugTake: mugTake,
      net: net,
      itemsWorth: itemsWorth,
      roi: spend > 0 ? net / spend : 0
    };
  }

  /**
   * Score + verdict. Returns why a target passed or failed so the UI can
   * explain itself instead of just greying things out.
   */
  function evaluateTarget(subject, opts) {
    const s = opts.settings;
    const f = s.filters;
    const me = s.me;
    const fail = [];
    const pass = [];

    const status = subject.status;
    const ff = subject.ff || {};
    const vault = subject.vault || { hasVault: null, vaultAmount: null };
    const bazar = subject.bazaar;

    /* --- A thin lookup still deserves a row, with the reason shown ----- */
    if (subject.lookupError) fail.push(subject.lookupError);

    /* --- availability --------------------------------------------------
     * The two "soon" filters are exceptions rather than extra rules: a
     * player who lands or is discharged inside the window is exactly who
     * you want to be waiting for, so they pass the rule they would
     * otherwise trip and are labelled with their countdown.
     */
    const untilFree = secondsUntilFree(status);
    const soonMins = f.soonOutOfHospital.value;
    const landMins = f.soonInTorn.value;

    const lockedUp =
      status.isHospital || status.isJail || status.isFederal || status.isFallen;
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
        pass.push('lands in ' + formatCountdown(untilFree));
      } else if (f.inTornOnly.on) {
        fail.push(status.isAbroad ? 'abroad' : 'travelling');
      }
    } else if (f.inTornOnly.on) {
      pass.push('in Torn');
    }

    if (lockedUp) {
      if (soonOut) {
        pass.push('free in ' + formatCountdown(untilFree));
      } else if (f.notHospitalised.on) {
        fail.push(
          status.isHospital
            ? 'hospitalised'
            : status.isJail
            ? 'jailed'
            : status.isFederal
            ? 'federal'
            : 'fallen'
        );
      }
    }

    if (f.maxLastAction.on) {
      const mins = subject.lastActionAgo !== null ? subject.lastActionAgo / 60 : null;
      if (mins !== null && mins > f.maxLastAction.value) {
        fail.push('idle ' + formatAgo(subject.lastActionAgo));
      } else if (mins !== null) {
        pass.push('active ' + formatAgo(subject.lastActionAgo) + ' ago');
      }
    }

    /* --- goods & cash -------------------------------------------------- */
    if (f.minBazaarValue.on && bazar.buyout < f.minBazaarValue.value) {
      fail.push('bazaar ' + formatMoney(bazar.buyout));
    } else if (f.minBazaarValue.on) {
      pass.push('bazaar ' + formatMoney(bazar.buyout));
    }

    if (f.minMoney.on) {
      if (!subject.moneyExposed) {
        // Torn hides other players' cash on many key types. Filtering on a
        // number we were never given would quietly reject everyone.
        pass.push('cash hidden');
      } else if ((subject.money || 0) < f.minMoney.value) {
        fail.push('cash ' + formatMoney(subject.money));
      } else {
        pass.push('cash ' + formatMoney(subject.money));
      }
    }

    if (f.minItemCount.on && bazar.count < f.minItemCount.value) {
      fail.push(bazar.count + ' items');
    }

    if (f.minWorthyItems.on && bazar.worthyCount < f.minWorthyItems.value) {
      fail.push('worthy ' + bazar.worthyCount);
    } else if (f.minWorthyItems.on) {
      pass.push('worthy ' + bazar.worthyCount);
    }

    if (f.minDealCount.on && bazar.dealCount < f.minDealCount.value) {
      fail.push('deals ' + bazar.dealCount);
    } else if (f.minDealCount.on && bazar.dealCount > 0) {
      pass.push('deals ' + bazar.dealCount);
    }

    /* --- vault --------------------------------------------------------- */
    if (f.vault === 'require') {
      if (vault.hasVault !== true) fail.push(vault.hasVault === null ? 'vault unknown' : 'no vault');
      else pass.push('has a vault');
    } else if (f.vault === 'exclude') {
      if (vault.hasVault === true) fail.push('has a vault');
      else if (vault.hasVault === false) pass.push('no vault');
    }

    /* --- strength ------------------------------------------------------ */
    const ffScore = ff.fairFight;
    const bsEst = ff.bsEstimate;
    const hasStats = ffScore !== null && ffScore !== undefined;

    if (!hasStats && !f.allowUnknownStats.on) {
      fail.push('no FF data');
    }

    if (f.maxFairFight.on) {
      if (ffScore === null || ffScore === undefined) {
        if (!f.allowUnknownStats.on) fail.push('FF unknown');
      } else if (ffScore > f.maxFairFight.value) {
        fail.push('FF ' + ffScore.toFixed(2));
      } else {
        pass.push('FF ' + ffScore.toFixed(2));
      }
    }

    if (f.bsVsMine.on) {
      const myBs = toNumber(me.bs) || 0;
      if (bsEst === null || bsEst === undefined) {
        if (!f.allowUnknownStats.on) fail.push('BS unknown');
      } else if (myBs <= 0) {
        // Cannot compare without our own stats; do not silently pass.
        fail.push('your stats not set');
      } else if (bsEst > myBs * f.bsVsMine.value) {
        fail.push('BS ' + formatNumber(bsEst) + ' vs mine ' + formatNumber(myBs));
      } else {
        pass.push('BS ' + formatNumber(bsEst) + ' vs mine ' + formatNumber(myBs));
      }
    }

    if (f.maxBsEstimate.on) {
      if (bsEst === null || bsEst === undefined) {
        if (!f.allowUnknownStats.on) fail.push('BS unknown');
      } else if (bsEst > f.maxBsEstimate.value) {
        fail.push('BS ' + formatNumber(bsEst));
      }
    }

    /* --- exclusions ---------------------------------------------------- */
    if (f.sameFaction.on && me.factionId && subject.factionId === me.factionId) {
      fail.push('your faction');
    }

    if (f.minLevel.on && subject.level !== null && subject.level < f.minLevel.value) {
      fail.push('level ' + subject.level);
    }
    if (f.maxLevel.on && subject.level !== null && subject.level > f.maxLevel.value) {
      fail.push('level ' + subject.level);
    }

    /* --- score --------------------------------------------------------- */
    const myBs = toNumber(me.bs) || 0;
    let safety;
    if (bsEst && myBs > 0) {
      safety = clamp(1 - bsEst / (myBs * 3), 0, 1); // even match ~0.67
    } else if (hasStats) {
      safety = clamp(1 - ffScore / 5, 0, 1);
    } else {
      safety = 0.4; // unknown strength: neutral, slightly pessimistic
    }

    const cash = subject.moneyExposed ? subject.money || 0 : 0;
    const payday = clamp(Math.log10(1 + cash) / 8, 0, 1);
    const goods = clamp(Math.log10(1 + bazar.buyout) / 9, 0, 1);
    // Available now beats available shortly, which still beats unavailable.
    const ready = status.available ? 1 : soonOut || soonLand ? 0.6 : 0;

    const score =
      100 * (0.42 * safety + 0.24 * payday + 0.24 * goods + 0.1 * ready);

    if (f.minScore.on && score < f.minScore.value) {
      fail.push('score ' + score.toFixed(0));
    }

    const verdict = fail.length === 0 ? 'match' : 'reject';

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

  /**
   * Seller-ID harvesting, kept pure so it can be tested against real
   * markup. Torn uses several URL shapes for the same player, plus
   * hash-routing (`bazaar.php#/userId=123`), so we look for the query
   * keys that can only mean a player.
   */
  const ID_PATTERNS = [
    /[?&#/]XID=(\d+)/gi,
    /[?&#/]userId=(\d+)/gi,
    /[?&#/]userID=(\d+)/gi,
    /[?&#/]uid=(\d+)/gi,
    /[?&#/]seller_?id=(\d+)/gi,
    // Torn tags some elements with the owner's id instead of linking out.
    /data-user-?id\s*=\s*["']?(\d+)/gi,
    /data-player\s*=\s*["']?(\d+)/gi
  ];

  function extractIdsFromHtml(html, opts) {
    opts = opts || {};
    const found = new Set();
    const text = String(html || '');

    ID_PATTERNS.forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const id = parseInt(m[1], 10);
        if (isValidPlayerId(id)) found.add(id);
      }
    });

    // `profiles.php?123` / `/profiles.php#/123` are unambiguous.
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

  /**
   * Never scout yourself. Your own bazaar page links your own id, so this
   * comes up more often than it sounds - and mugging yourself is not a
   * plan. Relies on `me.id`, which runScan() makes sure we know.
   */
  function isSelf(id) {
    return !!settings.me.id && Number(id) === Number(settings.me.id);
  }

  /* ---------------------------------------------------------------
   * 8. Turning Torn payloads into subjects
   * --------------------------------------------------------------- */

  function buildSubject(id, torn, ff, nameHint) {
    const profile = torn.profile || {};
    const basic = torn.basic || {};
    const status = readStatus(profile);

    // Battle stats are only present when the player has made them public
    // (or when you are looking at yourself); otherwise we lean on FFScouter.
    const publicBs = parseBattleStats(torn.stats) || parseBattleStats(torn.battlestats);

    const money = toNumber(torn.money && torn.money.money_onhand);
    const bazaar = summariseBazaar(
      torn.bazaar,
      settings.filters.worthyUnitPrice.on ? settings.filters.worthyUnitPrice.value : 0,
      settings.filters.dealDiscount.on ? settings.filters.dealDiscount.value : 0
    );

    const vault = detectVault(torn.property);

    const lastAction = toNumber(profile.last_action);
    const lastActionAgo =
      lastAction !== null
        ? lastAction >= 1e12
          ? Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(lastAction / 1000))
          : Math.max(0, Math.floor(Date.now() / 1000) - lastAction)
        : null;

    const resolvedName =
      profile.name || basic.name || nameHint || knownName(id) || 'Player ' + id;
    rememberName(id, resolvedName);

    return {
      id: id,
      name: resolvedName,
      level: toNumber(profile.level) || toNumber(basic.level) || null,
      factionId: toNumber(basic.faction_id) || 0,
      status: status,
      lastActionAgo: lastActionAgo,
      money: money,
      moneyExposed: money !== null,
      publicBs: publicBs,
      vault: vault,
      bazaar: bazaar,
      ff: ff || { fairFight: null, bsEstimate: null, bsHuman: null, source: null },
      raw: torn
    };
  }

  /**
   * A row for a seller we could not fully read. Dropping them silently
   * made the results look like players had vanished; showing the name we
   * have plus the reason is far more useful.
   */
  function buildStubSubject(id, nameHint, reason) {
    return {
      id: id,
      name: nameHint || knownName(id) || 'Player ' + id,
      level: null,
      factionId: 0,
      status: readStatus(null),
      lastActionAgo: null,
      money: null,
      moneyExposed: false,
      publicBs: null,
      vault: { hasVault: null, vaultAmount: null },
      bazaar: summariseBazaar([], 0, 0),
      ff: { fairFight: null, bsEstimate: null, bsHuman: null, source: null },
      lookupError: reason || 'lookup failed',
      raw: null
    };
  }

  /* ---------------------------------------------------------------
   * 9. Scan orchestration
   * --------------------------------------------------------------- */
  const scan = {
    running: false,
    abort: false,
    errorMessage: null,
    emptyNote: null,
    subjects: [],
    results: []
  };

  /* --- continuous scanning -------------------------------------------
   * Keeps re-checking the chosen item's bazaar sellers in the background.
   * Whether it is running is part of the saved settings, so pressing pause
   * (or leaving it running) survives a page refresh.
   */
  const auto = { timer: null, nextAt: 0, ticker: null };

  function autoIntervalMs() {
    return Math.max(30, toNumber(settings.scan.auto.intervalSec) || 120) * 1000;
  }

  function scheduleAutoScan(delayMs) {
    if (auto.timer) clearTimeout(auto.timer);
    auto.nextAt = Date.now() + delayMs;
    auto.timer = setTimeout(async function () {
      auto.timer = null;
      if (!settings.scan.auto.on) return;
      const itemId = settings.scan.auto.itemId;
      if (!itemId) {
        stopAutoScan('No item selected for auto-scan.');
        return;
      }
      // A manual scan in flight wins; come back shortly.
      if (scan.running) {
        scheduleAutoScan(15000);
        return;
      }
      await runItemScan(itemId, { background: true });
      if (settings.scan.auto.on) scheduleAutoScan(autoIntervalMs());
    }, Math.max(0, delayMs));
    paintAutoButton();
  }

  function startAutoScan(itemId) {
    const chosen = toNumber(itemId) || settings.scan.lastItemId || 0;
    if (!chosen) {
      setStatus('Pick an item first - auto-scan needs something to watch.', 'warn');
      return;
    }
    settings.scan.auto.itemId = chosen;
    settings.scan.auto.on = true;
    settings.scan.lastItemId = chosen;
    saveSettings();
    scheduleAutoScan(0);
    setStatus('Auto-scan running for ' + itemLabel(chosen) + '.', 'ok');
    paintAutoButton();
  }

  function stopAutoScan(reason) {
    settings.scan.auto.on = false;
    saveSettings();
    if (auto.timer) clearTimeout(auto.timer);
    auto.timer = null;
    auto.nextAt = 0;
    paintAutoButton();
    if (reason) setStatus(reason, 'warn');
  }

  function itemLabel(id) {
    return itemTable[id] ? itemTable[id] + ' (#' + id + ')' : 'item #' + id;
  }

  /** Live countdown so a running loop is obviously alive. */
  function startAutoTicker() {
    if (auto.ticker) return;
    auto.ticker = setInterval(function () {
      if (!settings.scan.auto.on || !auto.nextAt) return;
      if (scan.running) return;
      const left = Math.ceil((auto.nextAt - Date.now()) / 1000);
      if (left > 0) {
        setStatus(
          'Auto-scan on ' + itemLabel(settings.scan.auto.itemId) + ' - next scan in ' + left + 's.',
          'progress'
        );
      }
    }, 1000);
  }

  function paintAutoButton() {
    const btn = document.getElementById('tbms-auto-btn');
    if (!btn) return;
    btn.textContent = settings.scan.auto.on ? 'Pause auto-scan' : 'Auto-scan';
    btn.classList.toggle('tbms-danger', !!settings.scan.auto.on);
    btn.classList.toggle('tbms-primary', !settings.scan.auto.on);
  }

  function log(msg, kind) {
    // Kept deliberately tiny: last message wins, plus a short ring buffer
    // that the Results tab can show for debugging.
    scan.logs = scan.logs || [];
    scan.logs.push({ at: Date.now(), msg: msg, kind: kind || 'info' });
    if (scan.logs.length > 200) scan.logs.shift();
    setStatus(msg, kind);
  }

  /**
   * Score every collected subject with the *current* settings and render.
   * Both a fresh scan and the "re-score" button go through here, so
   * re-filtering can never behave differently from a first pass.
   */
  function applyVerdicts() {
    scan.results = scan.subjects
      .map(function (subject) {
        return { subject: subject, verdict: evaluateTarget(subject, { settings: settings }) };
      })
      .sort(function (a, b) {
        // Matches first, then by score, then by what is on the table.
        if (a.verdict.verdict !== b.verdict.verdict) {
          return a.verdict.verdict === 'match' ? -1 : 1;
        }
        if (b.verdict.score !== a.verdict.score) {
          return b.verdict.score - a.verdict.score;
        }
        return b.subject.bazaar.buyout - a.subject.bazaar.buyout;
      });

    const matches = scan.results.filter(function (r) {
      return r.verdict.verdict === 'match';
    }).length;
    renderResults();
    updateBadge(matches);
    return matches;
  }

  /**
   * One cheap lookup so we know which id is ours. Without it, opening your
   * own bazaar page and hitting scan would put you in your own target list.
   */
  async function learnOwnId() {
    try {
      const me = await fetchSelf();
      const basic = (me && me.basic) || {};
      const profile = (me && me.profile) || {};
      const id = toNumber(basic.player_id);
      if (id) {
        settings.me.id = id;
        settings.me.name = profile.name || basic.name || settings.me.name;
        settings.me.factionId = toNumber(basic.faction_id) || settings.me.factionId;
        saveSettings();
      }
      return id || 0;
    } catch (e) {
      log('Could not read your own player id - you may show up in your own results.', 'warn');
      return 0;
    }
  }

  async function runScan(explicitIds, sourceLabel, nameHints) {
    if (scan.running) return;
    const s = settings;
    // Listing names win, page names fill the gaps.
    const hints = Object.assign({}, harvestNameHints(), nameHints || {});

    if (!s.api.tornKey) {
      setStatus('Add your Torn API key in Setup first.', 'error');
      switchTab('setup');
      return;
    }

    // Excluding yourself needs your own id. If we have never looked it up,
    // do it now rather than cheerfully scouting the one player you cannot
    // mug.
    if (!s.me.id) await learnOwnId();

    const ids = explicitIds && explicitIds.length ? explicitIds.slice() : harvestIds();
    const targets = ids
      .filter(function (id) {
        return !isSelf(id);
      })
      .slice(0, Math.max(1, s.scan.maxTargetsPerScan));

    if (!targets.length) {
      setStatus(
        'No seller links on this page. Bazaar listings and item pages name their sellers; anonymous item-market listings do not.',
        'warn'
      );
      return;
    }

    scan.running = true;
    scan.abort = false;
    scan.errorMessage = null;
    scan.subjects = [];
    scan.results = [];
    renderResults();
    setScanningUi(true);

    try {
      log(
        (sourceLabel ? sourceLabel + ' - checking ' : 'Checking ') +
          targets.length +
          ' seller(s).',
        'info'
      );

      /* --- step 1: FFScouter, one batched call for the whole page ------ */
      setStatus('Asking FFScouter about ' + targets.length + ' player(s)...', 'progress');
      const ff = await ffLookup(targets);
      const missing = targets.filter(function (id) {
        return !ff[id];
      });
      log(
        'FFScouter returned data for ' +
          (targets.length - missing.length) +
          '/' +
          targets.length +
          '.',
        missing.length ? 'warn' : 'info'
      );

      /* --- step 2: Torn lookups, worker pool over the rate limiter ----- */
      const queue = targets.slice();
      let done = 0;
      const retries = {};
      const workerCount = Math.max(1, Math.min(8, s.api.workers || 3));

      const workers = [];
      for (let w = 0; w < workerCount; w++) {
        workers.push(
          (async function () {
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
                  cacheSet(id, torn);
                  saveJSON(CACHE_KEY, cache);
                }
                scan.subjects.push(buildSubject(id, torn, ff[id], hints[id]));
              } catch (e) {
                if (e.rateLimit) {
                  // Hitting the ceiling is routine on a busy page: park the
                  // whole pool, then put this player back in the queue so the
                  // scan finishes on its own instead of dying here.
                  retries[id] = (retries[id] || 0) + 1;
                  const maxTries = Math.max(0, s.api.rateLimitRetries);
                  if (retries[id] > maxTries) {
                    scan.errorMessage =
                      'Torn was still rate limiting after ' +
                      maxTries +
                      ' wait(s) - stopping. Try a bigger gap between calls in Settings.';
                    log(scan.errorMessage, 'error');
                    scan.abort = true;
                    return;
                  }
                  pauseTornQueue(Math.max(1000, s.api.rateLimitWaitMs || 60000));
                  queue.push(id);
                  consumed = false;
                  continue;
                }
                if (e.fatal) {
                  scan.errorMessage = e.badKey
                    ? 'Torn rejected the API key (' + e.message + ') - check it in Setup.'
                    : 'Torn stopped the scan: ' + e.message;
                  log(scan.errorMessage, 'error');
                  scan.abort = true;
                  return;
                }
                if (e.badId || e.tornCode === ERR_BAD_ID) {
                  // Harvested a number that is not a player. Harmless.
                  continue;
                }
                // Keep the seller visible with whatever name we have.
                const why =
                  e.tornCode === ERR_PRIVATE
                    ? 'data is private'
                    : e.tornCode === ERR_KEY_LEVEL || e.tornCode === ERR_ACCESS
                    ? 'key level too low'
                    : e.message;
                scan.subjects.push(buildStubSubject(id, hints[id], why));
                log((hints[id] || id) + ': ' + why, 'warn');
              } finally {
                if (consumed) {
                  done++;
                  setStatus('Fetched ' + done + '/' + targets.length + ' players...', 'progress');
                }
              }
            }
          })()
        );
      }
      await Promise.all(workers);

      /* --- step 3: score --------------------------------------------- */
      const matches = applyVerdicts();
      if (scan.errorMessage) {
        // The scan stopped early, so the reassuring summary would just
        // bury the reason nothing was found.
        log(scan.errorMessage, 'error');
      } else {
        log(matches + ' buy-mug candidate(s) out of ' + scan.results.length + ' scanned.', 'ok');
      }
    } catch (e) {
      log('Scan failed: ' + e.message, 'error');
    } finally {
      scan.running = false;
      setScanningUi(false);
      // Leave errors and warnings on screen; only clear routine progress.
      if (currentStatusKind === 'progress' || currentStatusKind === 'info') {
        setStatus('Ready.', 'info');
      }
    }
  }

  /* ---------------------------------------------------------------
   * 10. DOM harvesting
   * --------------------------------------------------------------- */
  function harvestIds() {
    const html = collectPageText();
    let ids = extractIdsFromHtml(html);

    // The page we are on is itself a seller's bazaar sometimes.
    const self = extractIdsFromHtml(window.location.href);
    self.forEach(function (id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });

    return ids.filter(function (id) {
      return !isSelf(id);
    });
  }

  /**
   * Names read off the page's own links, keyed by player id. This is only
   * ever used as a display fallback: seller *discovery* is data-driven, but
   * if a lookup comes back thin the row should still say "Bob" rather than
   * "Player 2222222".
   */
  function harvestNameHints() {
    const hints = {};
    try {
      const anchors = document.querySelectorAll('a[href]');
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const href = a.getAttribute('href') || '';
        if (!/XID=|userId=|userID=/i.test(href)) continue;
        const ids = extractIdsFromHtml(href);
        if (ids.length !== 1) continue;
        const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 40) continue;
        if (!hints[ids[0]]) hints[ids[0]] = text;
      }
    } catch (e) {
      /* display fallback only */
    }
    return hints;
  }

  function collectPageText() {
    const parts = [];
    try {
      const anchors = document.querySelectorAll('a[href]');
      for (let i = 0; i < anchors.length; i++) {
        parts.push(anchors[i].getAttribute('href') || '');
      }
      const withData = document.querySelectorAll('[data-user-id],[data-userid],[data-player]');
      for (let i = 0; i < withData.length; i++) {
        const el = withData[i];
        // Emit them in the same shape the link patterns match so one
        // parser covers both sources.
        const uid = el.getAttribute('data-user-id') || el.getAttribute('data-userid');
        const pid = el.getAttribute('data-player');
        if (uid) parts.push('XID=' + uid);
        if (pid) parts.push('XID=' + pid);
      }
      if (settings.scan.scanScripts) {
        const scripts = document.querySelectorAll('script:not([src])');
        for (let i = 0; i < scripts.length && i < 40; i++) {
          const t = scripts[i].textContent || '';
          if (t.length < 200000) parts.push(t);
        }
      }
    } catch (e) {
      log('Harvest error: ' + e.message, 'warn');
    }
    return parts.join('\n');
  }

  let harvestTimer = null;
  function scheduleHarvest() {
    if (!settings.scan.autoHarvest) return;
    if (harvestTimer) clearTimeout(harvestTimer);
    harvestTimer = setTimeout(function () {
      const n = harvestIds().length;
      const el = document.getElementById('tbms-harvest-count');
      if (el) el.textContent = String(n);
    }, 900);
  }

  /* ---------------------------------------------------------------
   * 11. UI
   * --------------------------------------------------------------- */

  const CSS = [
    '#tbms-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;',
    "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",
    '#tbms-root *{box-sizing:border-box;}',
    /* Opener: a small square that sits in Torn's bottom icon bar alongside the
       channel buttons. Drag it once and the position is remembered. */
    '#tbms-fab{position:fixed;bottom:5px;right:8px;pointer-events:auto;cursor:pointer;',
    'width:28px;height:28px;padding:0;border-radius:3px;border:1px solid #2c3a42;',
    'background:linear-gradient(#2a3841,#1a242a);color:#8fb2bd;font-size:14px;',
    'line-height:1;display:flex;align-items:center;justify-content:center;',
    'box-shadow:0 1px 3px rgba(0,0,0,.55);}',
    '#tbms-fab:hover{background:linear-gradient(#33454f,#22313a);color:#d7f0f7;border-color:#3ba7b7;}',
    '#tbms-fab.tbms-dragging{cursor:grabbing;}',
    '#tbms-badge{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;',
    'border-radius:8px;background:#28a745;color:#fff;font-size:10px;line-height:15px;',
    'text-align:center;padding:0 5px;display:none;}',
    '#tbms-badge.tbms-show{display:block;}',
    /* Opener that lives inside Torn's own footer button bar. */
    '#tbms-footer-btn{position:relative;}',
    '#tbms-footer-btn svg{display:block;}',
    // A deliberate colour so it is findable among Torn's grey icons.
    '#tbms-footer-btn{background:linear-gradient(#2f9fb4,#17606f)!important;',
    'border-color:#3fb6cc!important;}',
    '#tbms-footer-btn:hover{background:linear-gradient(#45bdd3,#1d7a84)!important;}',
    '.tbms-footer-badge{position:absolute;top:-3px;right:-3px;min-width:11px;height:11px;',
    'border-radius:6px;background:#28a745;color:#fff;font-size:8px;line-height:11px;',
    'text-align:center;padding:0 2px;font-weight:600;display:none;pointer-events:none;',
    'box-shadow:0 0 0 1px rgba(0,0,0,.55);}',
    '.tbms-footer-badge.tbms-show{display:block;}',
    '#tbms-panel{position:fixed;width:min(700px,96vw);max-height:74vh;pointer-events:auto;',
    'display:flex;flex-direction:column;',
    'background:#141a1f;color:#d8e3e8;border:1px solid #2f3d45;border-radius:10px;',
    'box-shadow:0 18px 50px rgba(0,0,0,.6);font-size:13px;overflow:hidden;}',
    '#tbms-panel.tbms-hidden{display:none;}',
    '#tbms-head{display:flex;align-items:center;gap:10px;padding:8px 12px;',
    'background:#1b242b;border-bottom:1px solid #2f3d45;cursor:move;user-select:none;}',
    '#tbms-head .tbms-title{font-weight:600;color:#7fd8e8;}',
    '#tbms-head .tbms-ver{color:#5b6b74;font-size:11px;}',
    '#tbms-head .tbms-spacer{flex:1;}',
    '.tbms-btn{pointer-events:auto;cursor:pointer;background:#243139;color:#cfe7ee;',
    'border:1px solid #3a4a54;border-radius:5px;padding:4px 9px;font-size:12px;',
    'white-space:nowrap;}',
    '.tbms-btn:hover{background:#2c3d47;}',
    '.tbms-btn.tbms-primary{background:#1f6f7d;border-color:#2f97a8;color:#eafcff;font-weight:600;}',
    '.tbms-btn.tbms-primary:hover{background:#25808f;}',
    '.tbms-btn.tbms-danger{border-color:#7a3b3b;color:#f0b3b3;}',
    '.tbms-btn[disabled]{opacity:.45;cursor:not-allowed;}',
    '#tbms-tabs{display:flex;gap:4px;padding:6px 12px 0;background:#1b242b;}',
    '.tbms-tab{cursor:pointer;background:transparent;border:1px solid transparent;',
    'border-bottom:none;color:#93a7b1;padding:5px 11px;border-radius:6px 6px 0 0;font-size:12px;}',
    '.tbms-tab.tbms-active{background:#141a1f;color:#7fd8e8;border-color:#2f3d45;}',
    '#tbms-body{overflow:auto;padding:10px 12px;flex:1 1 auto;min-height:0;}',
    '.tbms-sec{margin-bottom:10px;}',
    '.tbms-sec h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;',
    'color:#6f8794;border-bottom:1px solid #26333b;padding-bottom:3px;}',
    '.tbms-row{display:flex;align-items:center;gap:8px;padding:3px 0;flex-wrap:nowrap;}',
    /* Only actual field labels grow; the switch label must not stretch. */
    '.tbms-row label.tbms-label{flex:1 1 auto;min-width:0;color:#c3d3db;cursor:pointer;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.tbms-hint{color:#63757f;font-size:11px;}',
    '.tbms-num{width:104px;flex:0 0 auto;background:#0e1418;border:1px solid #33434c;color:#dff0f5;',
    'border-radius:4px;padding:3px 6px;font-size:12px;}',
    '.tbms-row .tbms-suffix{flex:0 0 auto;color:#63757f;font-size:11px;}',
    '.tbms-text{width:100%;background:#0e1418;border:1px solid #33434c;color:#dff0f5;',
    'border-radius:4px;padding:5px 8px;font-size:12px;font-family:monospace;}',
    '.tbms-switch{position:relative;flex:0 0 auto;width:34px;min-width:34px;height:18px;',
    'margin:0;display:inline-block;}',
    '.tbms-switch input{opacity:0;width:0;height:0;position:absolute;}',
    '.tbms-slider{position:absolute;inset:0;background:#2b3a43;border-radius:9px;',
    'transition:.15s;cursor:pointer;}',
    '.tbms-slider:before{content:"";position:absolute;width:12px;height:12px;left:3px;top:3px;',
    'background:#8ba3ad;border-radius:50%;transition:.15s;}',
    '.tbms-switch input:checked+.tbms-slider{background:#1f6f7d;}',
    '.tbms-switch input:checked+.tbms-slider:before{transform:translateX(16px);background:#d9fbff;}',
    /* Collapsible "advanced" blocks keep the common case short. */
    'details.tbms-adv{border:1px solid #26333b;border-radius:6px;padding:0 9px;margin:0 0 10px;}',
    'details.tbms-adv>summary{cursor:pointer;padding:7px 0;color:#6f8794;font-size:11px;',
    'text-transform:uppercase;letter-spacing:.05em;list-style:none;outline:none;}',
    'details.tbms-adv>summary::-webkit-details-marker{display:none;}',
    'details.tbms-adv>summary:before{content:"\\25B8 ";color:#4d6470;}',
    'details.tbms-adv[open]>summary:before{content:"\\25BE ";}',
    'details.tbms-adv .tbms-row:last-child{margin-bottom:8px;}',
    'table.tbms-table{width:100%;border-collapse:collapse;font-size:12px;}',
    'table.tbms-table th{position:sticky;top:0;background:#1b242b;color:#7fd8e8;',
    'text-align:left;padding:5px 6px;border-bottom:1px solid #2f3d45;cursor:pointer;white-space:nowrap;}',
    'table.tbms-table td{padding:4px 6px;border-bottom:1px solid #1e282f;vertical-align:top;',
    'white-space:nowrap;}',
    'table.tbms-table td.tbms-wrap{white-space:normal;}',
    'table.tbms-table tr.tbms-match{background:rgba(40,167,69,.1);}',
    'table.tbms-table tr.tbms-reject{opacity:.55;}',
    'table.tbms-table tr:hover{background:rgba(127,216,232,.08);}',
    '.tbms-pill{display:inline-block;padding:1px 6px;border-radius:9px;font-size:10px;',
    'border:1px solid #3a4a54;color:#9fb4bd;}',
    '.tbms-pill.tbms-ok{border-color:#2c7a45;color:#8ee0a8;}',
    '.tbms-pill.tbms-bad{border-color:#7a3b3b;color:#f0a2a2;}',
    '.tbms-pill.tbms-warn{border-color:#7a6a2c;color:#e6d38a;}',
    '.tbms-link{color:#79c9e0;text-decoration:none;}',
    '.tbms-link:hover{text-decoration:underline;}',
    '#tbms-foot{border-top:1px solid #2f3d45;padding:7px 12px;background:#1b242b;',
    'font-size:11px;color:#8ea3ad;display:flex;gap:10px;align-items:center;}',
    '#tbms-foot.tbms-err{color:#f0a2a2;}',
    '#tbms-foot.tbms-warn{color:#e6d38a;}',
    '#tbms-foot.tbms-ok{color:#8ee0a8;}',
    '.tbms-empty{padding:22px;text-align:center;color:#63757f;}',
    '.tbms-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px;color:#9db2bb;}',
    '.tbms-kv b{color:#c8dbe3;font-weight:500;}'
  ].join('');

  function injectStyle() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
      return;
    }
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k]);
        } else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /* --- declarative settings controls ---------------------------------- */
  /* The seven that decide a buy-mug. Everything else lives one click away
     in the Advanced block so the common case stays short. */
  const MAIN_GROUPS = [
    {
      title: 'Where they are',
      items: [
        {
          type: 'toggle',
          path: 'filters.inTornOnly',
          label: 'In Torn, not abroad',
          hint:
            'Drops anyone shown as Abroad or Travelling. You cannot mug someone who is out of the country.'
        },
        {
          type: 'toggle',
          path: 'filters.notHospitalised',
          label: 'Not hospitalised or jailed',
          hint: 'You cannot mug someone who is already locked up.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.maxLastAction',
          label: 'Active within',
          suffix: 'min',
          hint: 'Long-idle players rarely keep mug-worthy cash on hand.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.soonInTorn',
          label: 'Or landing within',
          suffix: 'min',
          hint:
            'Abroad and travelling players are allowed through when they land inside this window - you can be waiting on the tarmac for them. 0 disables it.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.soonOutOfHospital',
          label: 'Or released within',
          suffix: 'min',
          hint:
            'Hospitalised, jailed and federal players are allowed through when they get out inside this window. 0 disables it.'
        }
      ]
    },
    {
      title: 'What they are carrying',
      items: [
        {
          type: 'toggleNumber',
          path: 'filters.minBazaarValue',
          label: 'Bazaar worth at least',
          hint:
            'Total cost to clear everything they have listed. This is the cash you push into their hands to mug back.'
        },
        {
          type: 'select',
          path: 'filters.vault',
          label: 'Property vault',
          options: [
            ['ignore', 'Ignore'],
            ['exclude', 'Skip vault owners'],
            ['require', 'Only vault owners']
          ],
          hint:
            'A vault keeps cash out of reach and usually means a more careful player. "Unknown" counts as not having one.'
        }
      ]
    },
    {
      title: 'How strong they are',
      items: [
        {
          type: 'toggleNumber',
          path: 'filters.maxFairFight',
          label: 'Fair fight at most',
          step: '0.1',
          hint: 'Lower is safer. Below 1 is usually a comfortable win.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.bsVsMine',
          label: 'Stats at most mine ×',
          step: '0.1',
          hint:
            'Their FFScouter estimate against your own stats. 1.0 means they look no stronger than you. Load your stats in Setup first.'
        }
      ]
    }
  ];

  const ADVANCED_GROUPS = [
    {
      title: 'Money & stock detail',
      items: [
        {
          type: 'toggleNumber',
          path: 'filters.minMoney',
          label: 'Cash on hand at least',
          hint: 'Only visible when Torn shows their money to your key; hidden cash passes.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.minItemCount',
          label: 'At least this many items',
          hint: 'Counts quantity, not listings.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.minWorthyItems',
          label: 'At least this many "worthy" items',
          hint: 'Items priced at or above the worthy-unit-price below.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.worthyUnitPrice',
          label: 'An item is "worthy" from',
          hint: 'Per-unit price threshold that decides what is worth buying.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.minDealCount',
          label: 'At least this many items under market',
          hint: 'Items priced below market by the discount below.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.dealDiscount',
          label: 'Discount that counts as a deal',
          step: '0.01',
          hint: '0.15 means 15% under the going rate.'
        }
      ]
    },
    {
      title: 'Strength detail',
      items: [
        {
          type: 'toggleNumber',
          path: 'filters.maxBsEstimate',
          label: 'Estimated stats at most',
          hint: 'An absolute ceiling, independent of your own stats.'
        },
        {
          type: 'toggle',
          path: 'filters.allowUnknownStats',
          label: 'Include players with no FFScouter data',
          hint: 'Turn this off for a strictly vetted shortlist.'
        },
        {
          type: 'toggleNumber',
          path: 'filters.minScore',
          label: 'Scout score at least',
          hint: 'The 0-100 blend of safety, cash and stock shown in the results.'
        }
      ]
    },
    {
      title: 'Exclusions',
      items: [
        { type: 'toggle', path: 'filters.sameFaction', label: 'Skip my own faction' },
        { type: 'toggleNumber', path: 'filters.minLevel', label: 'Level at least' },
        { type: 'toggleNumber', path: 'filters.maxLevel', label: 'Level at most' }
      ]
    }
  ];

  function getPath(path) {
    const parts = path.split('.');
    let cur = settings;
    for (let i = 0; i < parts.length; i++) cur = cur[parts[i]];
    return cur;
  }

  function setPath(path, value) {
    const parts = path.split('.');
    let cur = settings;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
    saveSettings();
  }

  function buildControl(item) {
    const wrap = el('div', { class: 'tbms-row' });
    let numInput = null;
    let switchInput = null;

    if (item.type === 'toggle' || item.type === 'toggleNumber') {
      const node = getPath(item.path);
      const switchWrap = el('label', { class: 'tbms-switch' });
      const input = el('input', { type: 'checkbox' });
      input.checked = !!node.on;
      input.addEventListener('change', function () {
        node.on = input.checked;
        saveSettings();
        if (item.type === 'toggleNumber' && numInput) numInput.disabled = !input.checked;
      });
      switchWrap.appendChild(input);
      switchWrap.appendChild(el('span', { class: 'tbms-slider' }));
      wrap.appendChild(switchWrap);
      switchInput = input;
    }

    const label = el('label', { class: 'tbms-label', text: item.label });
    // Hints live in the tooltip and the row stays one line tall.
    if (item.hint) label.title = item.hint;
    label.addEventListener('click', function (e) {
      if (!switchInput) return;
      e.preventDefault();
      switchInput.checked = !switchInput.checked;
      switchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    wrap.appendChild(label);

    if (item.type === 'toggleNumber') {
      numInput = el('input', {
        class: 'tbms-num',
        type: 'number',
        step: item.step || '1'
      });
      numInput.value = getPath(item.path).value;
      numInput.disabled = !getPath(item.path).on;
      numInput.addEventListener('change', function () {
        const v = Number(numInput.value);
        getPath(item.path).value = isFinite(v) ? v : 0;
        saveSettings();
      });
      wrap.appendChild(numInput);
      if (item.suffix) wrap.appendChild(el('span', { class: 'tbms-suffix', text: item.suffix }));
    }

    if (item.type === 'select') {
      const sel = el('select', { class: 'tbms-num' });
      sel.style.width = 'auto';
      item.options.forEach(function (pair) {
        const o = el('option', { value: pair[0], text: pair[1] });
        if (getPath(item.path) === pair[0]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        setPath(item.path, sel.value);
      });
      wrap.appendChild(sel);
    }

    return wrap;
  }

  /* --- panel scaffolding ---------------------------------------------- */
  let panel = null;

  /* --- footer opener ---------------------------------------------------
   * Torn renders its own quick buttons in the bottom bar (#notes_panel_button
   * and #people_panel_button). We build a button carrying the *same
   * className* as one of those and insert it as a sibling, so Torn's
   * stylesheet does the drawing and the opener lines up with the rest of
   * the bar instead of floating over it. When those buttons are absent
   * (Torn PDA, layout change) we fall back to the standalone corner square.
   */
  // Drawn the way Torn draws its own bar icons: a light vertical gradient,
  // bold shapes, no reliance on the inherited text colour.
  const FOOTER_ICON = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" CLASS>',
    '<defs><linearGradient id="tbms_icon_grad" x1="0.5" x2="0.5" y2="1"',
    ' gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#f2fbfd"/>',
    '<stop offset="1" stop-color="#b9dde6"/></linearGradient></defs>',
    '<g fill="url(#tbms_icon_grad)">',
    // A money bag: tied neck, fat body, and a coin slot so it reads at 16px.
    '<path d="M9.4 2.6h5.2l-.9 2.2h-3.4z"/>',
    '<path d="M12 5.4c-3.7 0-6.6 3.9-6.6 8.3 0 4.4 2.8 7.7 6.6 7.7s6.6-3.3 6.6-7.7c0-4.4-2.9-8.3-6.6-8.3Zm0 3.1a1.5 1.5 0 0 1 1.5 1.5c.9.3 1.5 1 1.5 1.9h-1.4c0-.5-.7-.9-1.6-.9s-1.6.4-1.6.9.7.8 1.6.9c1.4.2 3 .7 3 2.3 0 .9-.6 1.7-1.5 2v1h-1.5v-1c-.9-.3-1.5-1.1-1.5-2h1.4c0 .5.7 1 1.6 1s1.6-.4 1.6-.9-.7-.8-1.6-.9c-1.4-.2-3-.7-3-2.2 0-.9.6-1.7 1.5-2a1.5 1.5 0 0 1 1.1-2.6Z"/>',
    '</g>',
    '</svg>'
  ].join('');

  function findFooterRefBtn() {
    for (let i = 0; i < FOOTER_REF_IDS.length; i++) {
      const el = document.getElementById(FOOTER_REF_IDS[i]);
      if (el && el.parentNode) return el;
    }
    return null;
  }

  function buildFooterButton(refBtn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = FOOTER_BTN_ID;
    // The whole trick: inherit Torn's own styling for this bar.
    btn.className = refBtn.className || '';
    btn.title = 'Buy-Mug Scout';
    const iconClass = refBtn.querySelector('svg')
      ? refBtn.querySelector('svg').getAttribute('class') || ''
      : '';
    btn.innerHTML = FOOTER_ICON.replace('CLASS', iconClass ? 'class="' + iconClass + '"' : '');
    const badge = document.createElement('span');
    badge.id = 'tbms-footer-badge';
    badge.className = 'tbms-footer-badge';
    btn.appendChild(badge);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      settings.ui.open = !settings.ui.open;
      saveSettings();
      syncPanelVisibility();
    });
    return btn;
  }

  /**
   * Torn's SPA re-renders the footer on navigation, which drops our button.
   * Re-mount whenever the reference button comes back without us.
   */
  function mountFooterButton() {
    const refBtn = findFooterRefBtn();
    const existing = document.getElementById(FOOTER_BTN_ID);

    if (!refBtn) {
      // No footer to join - show the standalone square instead.
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
    const fab = document.getElementById('tbms-fab');
    if (fab) fab.style.display = show ? 'flex' : 'none';
  }

  function watchFooter() {
    let pending = false;
    // rAF is absent in a few embedded webviews; a timeout is a fine stand-in.
    const soon =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : function (fn) {
            setTimeout(fn, 16);
          };
    const obs = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      soon(function () {
        pending = false;
        mountFooterButton();
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* --- opener: a square that lives with Torn's bottom-bar icons ------- */
  function applyFabPos() {
    const fab = document.getElementById('tbms-fab');
    if (!fab) return;
    const pos = settings.ui.fabPos;
    if (!pos) {
      fab.style.left = '';
      fab.style.top = '';
      fab.style.right = '';
      fab.style.bottom = '';
      return;
    }
    fab.style.left = pos.left + 'px';
    fab.style.top = pos.top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  function makeDraggable(fab) {
    const SIZE = 28;
    let drag = null;

    fab.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      // A few pixels of slop so a click never registers as a tiny drag.
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      fab.classList.add('tbms-dragging');
      fab.style.left = clamp(drag.left + dx, 0, window.innerWidth - SIZE) + 'px';
      fab.style.top = clamp(drag.top + dy, 0, window.innerHeight - SIZE) + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function () {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      fab.classList.remove('tbms-dragging');

      if (!moved) {
        settings.ui.open = !settings.ui.open;
        saveSettings();
        syncPanelVisibility();
        return;
      }

      const rect = fab.getBoundingClientRect();
      settings.ui.fabPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      saveSettings();
      if (settings.ui.open) positionPanel();
    });
  }

  /** Where the opener currently is: footer button first, square second. */
  function openerRect() {
    const btn = document.getElementById(FOOTER_BTN_ID);
    const fab = document.getElementById('tbms-fab');
    const target =
      btn && btn.offsetParent !== null ? btn : fab && fab.style.display !== 'none' ? fab : null;
    return target ? target.getBoundingClientRect() : null;
  }

  /**
   * Apply the saved geometry, or place the panel above the opener the
   * first time. The user's own drag/resize always wins over the default.
   */
  function applyPanelGeom() {
    if (!panel) return;
    const size = settings.ui.panelSize;
    if (size) {
      panel.style.width = Math.max(360, size.w) + 'px';
      panel.style.height = Math.max(260, size.h) + 'px';
      panel.style.maxHeight = 'none';
    } else {
      panel.style.width = '';
      panel.style.height = '';
      panel.style.maxHeight = '';
    }
  }

  /** Open the panel next to the opener, flipping to stay on screen. */
  function positionPanel() {
    if (!panel) return;
    applyPanelGeom();

    const saved = settings.ui.panelPos;
    if (saved) {
      const w = panel.offsetWidth || 700;
      const h = panel.offsetHeight || 400;
      panel.style.left = clamp(saved.left, 0, Math.max(0, window.innerWidth - w)) + 'px';
      panel.style.top = clamp(saved.top, 0, Math.max(0, window.innerHeight - 40)) + 'px';
      return;
    }

    const r = openerRect();
    if (!r) {
      panel.style.left = Math.max(6, window.innerWidth - 706) + 'px';
      panel.style.top = '40px';
      return;
    }
    // Keep in step with #tbms-panel's CSS width.
    const w = panel.offsetWidth || Math.min(PANEL_W, window.innerWidth * 0.96);
    const h = panel.offsetHeight || 400;

    const left = clamp(r.right - w, 6, Math.max(6, window.innerWidth - w - 6));
    let top = r.top - h - 8;
    if (top < 6) top = Math.min(r.bottom + 8, Math.max(6, window.innerHeight - h - 6));

    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  /* --- move the panel by its header ----------------------------------- */
  function makePanelDraggable() {
    const head = panel.querySelector('#tbms-head');
    let drag = null;

    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      // Let the Close button (and any future header control) work normally.
      if (e.target.closest('button, a, input, select')) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      head.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const left = clamp(drag.left + (e.clientX - drag.x), -w + 80, window.innerWidth - 80);
      const top = clamp(drag.top + (e.clientY - drag.y), 0, window.innerHeight - 30);
      panel.style.left = Math.round(left) + 'px';
      panel.style.top = Math.round(top) + 'px';
      e.preventDefault();
    });

    document.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      head.style.cursor = '';
      const rect = panel.getBoundingClientRect();
      settings.ui.panelPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      saveSettings();
    });
  }

  /* --- resize the panel from its corner grip -------------------------- */
  function makePanelResizable() {
    const grip = el('div', {
      id: 'tbms-grip',
      title: 'Drag to resize',
      style: 'position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;' +
        'background:linear-gradient(135deg,transparent 45%,#4b5f6b 45%,#4b5f6b 58%,transparent 58%,' +
        'transparent 70%,#4b5f6b 70%,#4b5f6b 83%,transparent 83%);z-index:5;'
    });
    panel.appendChild(grip);

    let drag = null;
    grip.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      panel.style.width = Math.max(360, drag.w + (e.clientX - drag.x)) + 'px';
      panel.style.height = Math.max(260, drag.h + (e.clientY - drag.y)) + 'px';
      e.preventDefault();
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      const rect = panel.getBoundingClientRect();
      settings.ui.panelSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
      saveSettings();
    });
  }

  function buildPanel() {
    const root = el('div', { id: 'tbms-root' });

    const fab = el('button', {
      id: 'tbms-fab',
      title: 'Buy-Mug Scout - click to open, drag to move'
    });
    fab.appendChild(document.createTextNode('◎'));
    const badge = el('span', { id: 'tbms-badge' });
    fab.appendChild(badge);
    makeDraggable(fab);
    root.appendChild(fab);

    panel = el('div', { id: 'tbms-panel' });

    const head = el('div', { id: 'tbms-head' });
    head.appendChild(el('span', { class: 'tbms-title', text: 'Buy-Mug Scout' }));
    head.appendChild(el('span', { class: 'tbms-ver', text: 'v' + VERSION }));
    head.appendChild(el('span', { class: 'tbms-spacer' }));
    const closeBtn = el('button', { class: 'tbms-btn', text: 'Close' });
    closeBtn.addEventListener('click', function () {
      settings.ui.open = false;
      saveSettings();
      syncPanelVisibility();
    });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const tabs = el('div', { id: 'tbms-tabs' });
    [
      ['scan', 'Scan'],
      ['filters', 'Filters'],
      ['results', 'Results'],
      ['setup', 'Setup']
    ].forEach(function (pair) {
      const btn = el('button', {
        class: 'tbms-tab',
        'data-tab': pair[0],
        text: pair[1],
        onclick: function () {
          switchTab(pair[0]);
        }
      });
      tabs.appendChild(btn);
    });
    panel.appendChild(tabs);

    const body = el('div', { id: 'tbms-body' });
    ['scan', 'filters', 'results', 'setup'].forEach(function (name) {
      body.appendChild(el('section', { class: 'tbms-section', 'data-tab': name }));
    });
    panel.appendChild(body);

    panel.appendChild(el('div', { id: 'tbms-foot', text: 'Ready.' }));
    root.appendChild(panel);
    document.body.appendChild(root);

    renderScanTab();
    renderFiltersTab();
    renderResults();
    renderSetupTab();
    applyFabPos();
    mountFooterButton();
    makePanelDraggable();
    makePanelResizable();
    applyPanelGeom();
    switchTab(settings.ui.tab || 'scan');
    syncPanelVisibility();
    updateBadge(0);
  }

  function section(name) {
    return panel.querySelector('section[data-tab="' + name + '"]');
  }

  function switchTab(name) {
    settings.ui.tab = name;
    saveSettings();
    Array.prototype.forEach.call(panel.querySelectorAll('.tbms-tab'), function (t) {
      t.classList.toggle('tbms-active', t.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(panel.querySelectorAll('section[data-tab]'), function (s) {
      s.style.display = s.getAttribute('data-tab') === name ? 'block' : 'none';
    });
  }

  // Tracks how the last status message was classified so a routine
  // "Ready." at the end of a scan cannot wipe out an error the user has
  // not read yet.
  let currentStatusKind = 'info';

  function syncPanelVisibility() {
    if (!panel) return;
    panel.classList.toggle('tbms-hidden', !settings.ui.open);
    if (settings.ui.open) positionPanel();
  }

  function setStatus(msg, kind) {
    const foot = document.getElementById('tbms-foot');
    if (!foot) return;
    foot.textContent = msg;
    foot.className = kind ? 'tbms-' + kind : '';
    currentStatusKind = kind || 'info';
  }

  function updateBadge(n) {
    ['tbms-badge', 'tbms-footer-badge'].forEach(function (id) {
      const b = document.getElementById(id);
      if (!b) return;
      b.textContent = String(n);
      b.classList.toggle('tbms-show', n > 0);
    });
  }

  function setScanningUi(running) {
    const scanBtn = document.getElementById('tbms-scan-btn');
    const itemBtn = document.getElementById('tbms-item-scan-btn');
    const stopBtn = document.getElementById('tbms-stop-btn');
    if (scanBtn) scanBtn.disabled = running;
    // The item button also waits for the item list to arrive.
    if (itemBtn) itemBtn.disabled = running || !Object.keys(itemTable).length;
    if (stopBtn) stopBtn.disabled = !running;
  }

  /* --- Scan tab -------------------------------------------------------- */
  function renderScanTab() {
    const s = section('scan');
    s.innerHTML = '';

    s.appendChild(
      el('div', {
        class: 'tbms-hint',
        style: 'margin-bottom:8px;',
        text:
          'Pick an item and the script asks Torn for every bazaar seller listing it - no page reading, works from any Torn page. Read-only.'
      })
    );

    /* --- primary path: scan an item's bazaar sellers ------------------- */
    const itemRow = el('div', {
      id: 'tbms-item-row',
      class: 'tbms-row',
      style: 'position:relative;'
    });
    const itemInput = el('input', {
      class: 'tbms-text',
      id: 'tbms-item-input',
      placeholder: 'item name or id',
      autocomplete: 'off',
      spellcheck: 'false'
    });
    itemInput.style.flex = '1 1 auto';
    itemRow.appendChild(itemInput);

    const itemBtn = el('button', {
      id: 'tbms-item-scan-btn',
      class: 'tbms-btn tbms-primary',
      text: 'Scan bazaars'
    });
    itemBtn.addEventListener('click', async function () {
      const id = await resolveItemId(itemInput.value, itemInput.getAttribute('data-item-id'));
      if (!id) {
        setStatus(
          Object.keys(itemTable).length
            ? 'No item matched "' + itemInput.value.trim() + '". Pick one from the list.'
            : 'Item list not loaded yet - you can still type an item id.',
          'warn'
        );
        openItemSuggestions();
        return;
      }
      hideItemSuggestions();
      settings.scan.lastItemId = id;
      saveSettings();
      runItemScan(id);
    });
    itemRow.appendChild(itemBtn);

    const autoBtn = el('button', {
      id: 'tbms-auto-btn',
      class: 'tbms-btn tbms-primary',
      text: 'Auto-scan',
      title:
        'Keep re-checking this item\u2019s bazaar sellers in the background. The on/paused state is saved, so it survives a refresh.'
    });
    autoBtn.addEventListener('click', async function () {
      if (settings.scan.auto.on) {
        stopAutoScan('Auto-scan paused. It stays paused after a refresh.');
        return;
      }
      const id = await resolveItemId(itemInput.value, itemInput.getAttribute('data-item-id'));
      startAutoScan(id);
    });
    itemRow.appendChild(autoBtn);

    // Our own suggestion list rather than a native <datalist>: datalist
    // behaviour varies between browsers and silently shows nothing when it
    // is not supported, which reads as "the picker is broken".
    const suggestions = el('div', {
      id: 'tbms-item-suggest',
      style: 'display:none;position:absolute;top:100%;left:0;right:0;z-index:20;' +
        'max-height:190px;overflow:auto;background:#0d1216;border:1px solid #33434c;' +
        'border-radius:4px;box-shadow:0 8px 20px rgba(0,0,0,.6);'
    });
    s.appendChild(itemRow);
    // Inside the row, which is position:relative - as a sibling its
    // containing block would be the panel and it would render off the
    // bottom edge, invisible.
    itemRow.appendChild(suggestions);

    let matches = [];
    let activeIndex = -1;

    function hideItemSuggestions() {
      suggestions.style.display = 'none';
      activeIndex = -1;
    }

    function paintSuggestions() {
      suggestions.innerHTML = '';
      matches.forEach(function (row, i) {
        const opt = el('div', {
          class: 'tbms-suggest-row',
          style:
            'padding:4px 8px;cursor:pointer;font-size:12px;' +
            (i === activeIndex ? 'background:#1f6f7d;color:#eafcff;' : 'color:#c3d3db;'),
          text: row.name + '  #' + row.id
        });
        // mousedown beats the input's blur, so the click is not lost.
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          choose(row);
        });
        suggestions.appendChild(opt);
      });
      suggestions.style.display = matches.length ? 'block' : 'none';
    }

    function choose(row) {
      itemInput.value = row.name;
      itemInput.setAttribute('data-item-id', String(row.id));
      hideItemSuggestions();
      setStatus('Selected ' + row.name + ' (#' + row.id + '). Press the button to scan it.', 'info');
    }

    function updateSuggestions() {
      const q = itemInput.value.trim().toLowerCase();
      itemInput.removeAttribute('data-item-id');
      if (!q) {
        matches = [];
        hideItemSuggestions();
        return;
      }
      // First keystrokes may arrive before the index does.
      if (!Object.keys(itemTable).length) {
        ensureItemTable().then(function (items) {
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
        setStatus(
          Object.keys(itemTable).length
            ? 'No item matched that.'
            : 'Item list is still loading - you can type an item id meanwhile.',
          'warn'
        );
      }
    }

    itemInput.addEventListener('input', updateSuggestions);
    itemInput.addEventListener('focus', updateSuggestions);
    itemInput.addEventListener('blur', function () {
      setTimeout(hideItemSuggestions, 120);
    });
    itemInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!matches.length) return;
        e.preventDefault();
        activeIndex =
          e.key === 'ArrowDown'
            ? (activeIndex + 1) % matches.length
            : (activeIndex - 1 + matches.length) % matches.length;
        paintSuggestions();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (matches.length && activeIndex >= 0) choose(matches[activeIndex]);
        else itemBtn.click();
      } else if (e.key === 'Escape') {
        hideItemSuggestions();
      }
    });

    const detected = currentItemId();
    if (detected) {
      itemInput.value = String(detected);
      s.appendChild(
        el('div', {
          class: 'tbms-hint',
          style: 'margin-bottom:6px;',
          text: 'This page is about item ' + detected + ' - press the button to scan it.'
        })
      );
    }

    const stopBtn = el('button', {
      id: 'tbms-stop-btn',
      class: 'tbms-btn tbms-danger',
      text: 'Stop'
    });
    stopBtn.disabled = true;
    stopBtn.addEventListener('click', function () {
      scan.abort = true;
      setStatus('Stopping after the current request...', 'warn');
    });

    /* --- secondary path: whatever the page is showing ------------------ */
    const other = el('details', { class: 'tbms-adv' });
    other.appendChild(el('summary', { text: 'Other ways to pick targets' }));

    const row = el('div', { class: 'tbms-row' });
    const scanBtn = el('button', {
      id: 'tbms-scan-btn',
      class: 'tbms-btn',
      text: 'Scan sellers on this page'
    });
    scanBtn.addEventListener('click', function () {
      runScan();
    });
    row.appendChild(scanBtn);
    row.appendChild(stopBtn);
    other.appendChild(row);

    const counter = el('span', { id: 'tbms-harvest-count', class: 'tbms-pill' });
    counter.textContent = String(harvestIds().length);
    const countRow = el('div', { class: 'tbms-row' }, [
      el('span', { text: 'Sellers on this page:' }),
      counter
    ]);
    other.appendChild(countRow);

    other.appendChild(
      el('div', { class: 'tbms-hint', text: 'Comma separated player IDs.' })
    );

    const manual = el('input', {
      id: 'tbms-manual-input',
      class: 'tbms-text',
      placeholder: 'e.g. 1234567, 2345678'
    });
    other.appendChild(manual);

    const manualRow = el('div', { class: 'tbms-row' });
    const manualBtn = el('button', { class: 'tbms-btn', text: 'Check IDs' });
    manualBtn.addEventListener('click', function () {
      const ids = extractIdsFromHtml(manual.value.replace(/(\d+)/g, 'XID=$1'));
      const loose = (manual.value.match(/\d{3,8}/g) || []).map(Number);
      const all = Array.from(new Set(ids.concat(loose))).filter(isValidPlayerId);
      if (!all.length) {
        setStatus('No usable IDs found in that box.', 'warn');
        return;
      }
      runScan(all);
    });
    manualRow.appendChild(manualBtn);
    other.appendChild(manualRow);
    s.appendChild(other);

    // The tab renders instantly; the item index fills in behind it.
    ensureItemTable().then(function (items) {
      if (Object.keys(items).length) {
        if (!itemInput.value && settings.scan.lastItemId) {
          const last = items[settings.scan.lastItemId];
          itemInput.value = last || String(settings.scan.lastItemId);
          if (last) itemInput.setAttribute('data-item-id', String(settings.scan.lastItemId));
        }
      } else {
        setStatus(
          'Item names could not be loaded - type an item id (e.g. 206) instead.',
          'warn'
        );
      }
    });
  }

  let itemTable = {};
  let itemTablePromise = null;
  let itemTableTriedAt = 0;

  /** Load the index once per page, sharing the work between callers. */
  function ensureItemTable(force) {
    if (Object.keys(itemTable).length && !force) return Promise.resolve(itemTable);
    // Never stay stuck on an empty result: retry on later calls, but not on
    // every keystroke while a load is failing.
    if (!force && itemTablePromise) return itemTablePromise; // already in flight
    if (!force && Date.now() - itemTableTriedAt < 5000) {
      return Promise.resolve(itemTable);
    }
    itemTableTriedAt = Date.now();
    const pending = loadItemList(force)
      .then(function (items) {
        if (Object.keys(items).length) itemTable = items;
        itemTablePromise = null;
        return itemTable;
      })
      .catch(function (e) {
        log('Item list: ' + e.message, 'warn');
        itemTablePromise = null;
        return itemTable;
      });
    itemTablePromise = pending;
    return itemTablePromise;
  }

  /** Rank index entries against a lowercase query. */
  function searchItems(query, limit) {
    const rows = [];
    Object.keys(itemTable).forEach(function (id) {
      const name = itemTable[id];
      const lower = name.toLowerCase();
      let rank = -1;
      if (lower === query) rank = 0;
      else if (lower.indexOf(query) === 0) rank = 1;
      else if (lower.split(/\s+/).some(function (w) { return w.indexOf(query) === 0; })) rank = 2;
      else if (lower.indexOf(query) !== -1) rank = 3;
      if (rank >= 0) rows.push({ id: toNumber(id), name: name, rank: rank });
    });
    rows.sort(function (a, b) {
      return a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name);
    });
    return rows.slice(0, limit || 8);
  }

  /**
   * Turn what the user typed into an item id. Accepts an explicit pick from
   * the list, a raw id, an exact name, or the best-ranked name match - a
   * search box that refuses to resolve "xanax" is not a search box.
   */
  async function resolveItemId(text, pickedId) {
    if (pickedId) return toNumber(pickedId);
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return toNumber(raw);

    await ensureItemTable();
    const best = searchItems(raw.toLowerCase(), 1);
    return best.length ? best[0].id : null;
  }

  /**
   * Seller list -> player checks. Sellers are ordered by the value of the
   * listing we found them through, so the biggest stocks get checked first
   * when the per-scan cap bites.
   */
  async function runItemScan(itemId, opts) {
    const background = !!(opts && opts.background);
    if (scan.running) return;
    if (!settings.api.tornKey) {
      setStatus('Add your Torn API key in Setup first.', 'error');
      switchTab('setup');
      return;
    }
    if (!settings.me.id) await learnOwnId();

    scan.running = true;
    setScanningUi(true);
    setStatus('Looking up bazaar sellers...', 'progress');
    try {
      const found = await findBazaarSellers(itemId);
      if (!found.sellers.length) {
        scan.running = false;
        setScanningUi(false);
        setStatus(
          'No bazaar sellers found for ' + itemLabel(itemId) + '.',
          'warn'
        );
        // Nothing to show is a legitimate result, not a silent failure:
        // clear stale rows so the table matches the message.
        scan.subjects = [];
        scan.emptyNote =
          'No bazaar sellers were listed for ' +
          itemLabel(itemId) +
          ' by either source.';
        applyVerdicts();
        return;
      }

      const ordered = found.sellers
        .filter(function (row) {
          return !isSelf(row.id);
        })
        .sort(function (a, b) {
          return (b.price || 0) * (b.qty || 0) - (a.price || 0) * (a.qty || 0);
        });

      const name = itemTable[itemId] || ('item ' + itemId);
      scan.emptyNote = null;
      log(
        name +
          ': ' +
          ordered.length +
          ' bazaar seller(s) found via ' +
          found.source +
          '.',
        'info'
      );
      settings.scan.lastItemId = itemId;
      saveSettings();

      // Names from the listing mean a row still reads properly even if the
      // per-player lookup comes back thin.
      const hints = {};
      ordered.forEach(function (row) {
        if (row.name) hints[row.id] = row.name;
      });

      scan.running = false; // runScan takes over the flag
      await runScan(
        ordered.map(function (row) {
          return row.id;
        }),
        name + ' (' + found.source + ')',
        hints
      );
    } catch (e) {
      scan.running = false;
      setScanningUi(false);
      if (background) {
        log('Auto-scan: ' + e.message, 'error');
      } else {
        setStatus('Item scan failed: ' + e.message, 'error');
      }
    }
  }

  /* --- Filters tab ------------------------------------------------------ */
  function renderFiltersTab() {
    const s = section('filters');
    s.innerHTML = '';

    function addGroup(group) {
      const sec = el('div', { class: 'tbms-sec' });
      sec.appendChild(el('h4', { text: group.title }));
      group.items.forEach(function (item) {
        sec.appendChild(buildControl(item));
      });
      s.appendChild(sec);
    }

    MAIN_GROUPS.forEach(addGroup);

    // Everything else stays reachable but out of the way.
    const adv = el('details', { class: 'tbms-adv' });
    adv.appendChild(el('summary', { text: 'Advanced filters' }));
    ADVANCED_GROUPS.forEach(function (group) {
      const sec = el('div', { class: 'tbms-sec' });
      sec.appendChild(el('h4', { text: group.title }));
      group.items.forEach(function (item) {
        sec.appendChild(buildControl(item));
      });
      adv.appendChild(sec);
    });
    s.appendChild(adv);

    const rescan = el('div', { class: 'tbms-row' });
    const btn = el('button', {
      class: 'tbms-btn tbms-primary',
      text: 'Re-score last scan'
    });
    btn.addEventListener('click', function () {
      if (!scan.subjects.length) {
        setStatus('Nothing scanned yet.', 'warn');
        return;
      }
      const matches = applyVerdicts();
      setStatus(
        'Re-scored ' +
          scan.subjects.length +
          ' seller(s) with the current filters: ' +
          matches +
          ' match.',
        matches ? 'ok' : 'warn'
      );
      switchTab('results');
    });
    rescan.appendChild(btn);
    s.appendChild(rescan);
  }

  /* --- Results tab ------------------------------------------------------ */
  let sortKey = 'score';
  let sortDir = -1;

  function renderResults() {
    const s = section('results');
    if (!s) return;
    s.innerHTML = '';

    if (!scan.results.length) {
      s.appendChild(
        el('div', {
          class: 'tbms-empty',
          text: scan.running
            ? 'Scanning...'
            : scan.emptyNote || 'No results yet. Pick an item on the Scan tab.'
        })
      );
      return;
    }

    const matches = scan.results.filter(function (r) {
      return r.verdict.verdict === 'match';
    }).length;

    const top = el('div', { class: 'tbms-row' });
    top.appendChild(
      el('span', {
        class: 'tbms-pill ' + (matches ? 'tbms-ok' : 'tbms-warn'),
        text: matches + ' match(es)'
      })
    );
    top.appendChild(el('span', { class: 'tbms-pill', text: scan.results.length + ' scanned' }));

    const onlyWrap = el('label', { class: 'tbms-switch' });
    const onlyInput = el('input', { type: 'checkbox' });
    onlyInput.checked = !!settings.ui.onlyMatches;
    onlyInput.addEventListener('change', function () {
      settings.ui.onlyMatches = onlyInput.checked;
      saveSettings();
      renderResults();
    });
    onlyWrap.appendChild(onlyInput);
    onlyWrap.appendChild(el('span', { class: 'tbms-slider' }));
    top.appendChild(onlyWrap);
    top.appendChild(el('span', { class: 'tbms-hint', text: 'only show matches' }));

    const exportBtn = el('button', { class: 'tbms-btn', text: 'Copy JSON' });
    exportBtn.addEventListener('click', function () {
      copyToClipboard(JSON.stringify(exportResults(), null, 2));
      setStatus('Results copied to clipboard.', 'ok');
    });
    top.appendChild(exportBtn);

    const csvBtn = el('button', { class: 'tbms-btn', text: 'Copy CSV' });
    csvBtn.addEventListener('click', function () {
      copyToClipboard(toCsv(exportResults()));
      setStatus('CSV copied to clipboard.', 'ok');
    });
    top.appendChild(csvBtn);
    s.appendChild(top);

    const rows = scan.results
      .filter(function (r) {
        return !settings.ui.onlyMatches || r.verdict.verdict === 'match';
      })
      .slice()
      .sort(comparator());

    const table = el('table', { class: 'tbms-table' });
    const thead = el('thead');
    const htr = el('tr');
    // Fewer, wider columns. Cash and stock share one cell, and the fair
    // fight sits with the stat estimate, so nothing wraps into a ladder.
    [
      ['score', 'Score'],
      ['name', 'Seller'],
      ['status', 'Where'],
      ['strength', 'FF / stats'],
      ['loot', 'Cash / bazaar'],
      ['vault', 'Vault'],
      ['why', 'Notes'],
      ['act', '']
    ].forEach(function (pair) {
      const th = el('th', { text: pair[1] });
      th.addEventListener('click', function () {
        if (sortKey === pair[0]) sortDir = -sortDir;
        else {
          sortKey = pair[0];
          sortDir = -1;
        }
        renderResults();
      });
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.forEach(function (r) {
      tbody.appendChild(buildResultRow(r));
    });
    table.appendChild(tbody);
    s.appendChild(table);
  }

  function comparator() {
    return function (a, b) {
      const get = function (r) {
        const v = r.verdict;
        const su = r.subject;
        switch (sortKey) {
          case 'name': return su.name.toLowerCase();
          case 'status': return su.status.state;
          case 'strength':
            return su.ff.fairFight === null && su.ff.bsEstimate === null
              ? -1
              : (su.ff.fairFight || 0) * 1e12 + (su.ff.bsEstimate || 0);
          case 'loot': return su.bazaar.buyout + (su.moneyExposed ? su.money : 0);
          case 'money': return su.moneyExposed ? su.money : -1;
          case 'buyout': return su.bazaar.buyout;
          case 'vault': return su.vault.hasVault === true ? 1 : 0;
          case 'why': return v.reasons.length;
          case 'act': return v.score;
          default: return v.score;
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
    const tr = el('tr', { class: 'tbms-' + v.verdict });

    tr.appendChild(el('td', {}, [el('b', { text: String(v.score) })]));

    const nameTd = el('td');
    const profileLink = el('a', {
      class: 'tbms-link',
      href: 'https://www.torn.com/profiles.php?XID=' + su.id,
      target: '_blank',
      rel: 'noopener',
      text: su.name
    });
    nameTd.appendChild(profileLink);
    nameTd.appendChild(document.createElement('br'));
    nameTd.appendChild(
      el('span', { class: 'tbms-hint', text: '#' + su.id + (su.level ? ' · lvl ' + su.level : '') })
    );
    tr.appendChild(nameTd);

    const stateTd = el('td');
    const cls = su.status.available ? 'tbms-ok' : su.status.inTorn ? 'tbms-warn' : 'tbms-bad';
    stateTd.appendChild(el('span', { class: 'tbms-pill ' + cls, text: su.status.state }));
    stateTd.appendChild(document.createElement('br'));
    // For anyone locked up or away, when they are back is the whole point.
    const freeIn = secondsUntilFree(su.status);
    const subline =
      !su.status.available && freeIn !== null
        ? (su.status.inTorn ? 'out in ' : 'lands in ') + formatCountdown(freeIn)
        : su.lastActionAgo !== null
        ? 'seen ' + formatAgo(su.lastActionAgo) + ' ago'
        : 'last action unknown';
    stateTd.appendChild(el('span', { class: 'tbms-hint', text: subline }));
    tr.appendChild(stateTd);

    // Fair fight over stat estimate - the two numbers you judge in one glance.
    const strengthTd = el('td');
    strengthTd.appendChild(
      el('span', {
        text:
          su.ff.fairFight === null || su.ff.fairFight === undefined
            ? '-'
            : su.ff.fairFight.toFixed(2)
      })
    );
    strengthTd.appendChild(document.createElement('br'));
    const est = su.ff.bsEstimate || su.publicBs;
    strengthTd.appendChild(
      el('span', { class: 'tbms-hint', text: est ? formatNumber(est) : 'unknown' })
    );
    if (su.ff.source) strengthTd.title = 'Stat source: ' + su.ff.source;
    tr.appendChild(strengthTd);

    // Cash in hand and what is listed sit together; they are the same story.
    const lootTd = el('td');
    lootTd.appendChild(el('span', { text: formatMoney(su.bazaar.buyout) + ' bazaar' }));
    lootTd.appendChild(document.createElement('br'));
    lootTd.appendChild(
      el('span', {
        class: 'tbms-hint',
        text: (su.moneyExposed ? formatMoney(su.money) : 'cash hidden') +
          ' · ' + su.bazaar.count + ' items'
      })
    );
    if (su.bazaar.dealCount) lootTd.title = su.bazaar.dealCount + ' item(s) under market price';
    tr.appendChild(lootTd);

    const vaultTd = el('td');
    if (su.vault.hasVault === true) {
      vaultTd.appendChild(el('span', { class: 'tbms-pill tbms-warn', text: 'vault' }));
      if (su.vault.vaultAmount) {
        vaultTd.appendChild(document.createElement('br'));
        vaultTd.appendChild(el('span', { class: 'tbms-hint', text: formatMoney(su.vault.vaultAmount) }));
      }
    } else if (su.vault.hasVault === false) {
      vaultTd.appendChild(el('span', { class: 'tbms-pill tbms-ok', text: 'none' }));
    } else {
      vaultTd.appendChild(
        el('span', {
          class: 'tbms-hint',
          text: '?',
          title: 'Torn exposes no vault information for this player.'
        })
      );
    }
    tr.appendChild(vaultTd);

    const whyTd = el('td');
    whyTd.className = 'tbms-wrap';
    if (v.reasons.length) {
      whyTd.appendChild(el('span', { class: 'tbms-pill tbms-bad', text: v.reasons.join(', ') }));
    } else {
      whyTd.appendChild(el('span', { class: 'tbms-pill tbms-ok', text: 'clear' }));
    }
    tr.appendChild(whyTd);

    const actTd = el('td');
    actTd.appendChild(
      el('a', {
        class: 'tbms-link',
        href: 'https://www.torn.com/bazaar.php?userId=' + su.id,
        target: '_blank',
        rel: 'noopener',
        text: 'bazaar'
      })
    );
    actTd.appendChild(document.createTextNode(' · '));
    actTd.appendChild(
      el('a', {
        class: 'tbms-link',
        href: 'https://www.torn.com/loader.php?sid=attack&user2ID=' + su.id,
        target: '_blank',
        rel: 'noopener',
        text: 'attack'
      })
    );
    tr.appendChild(actTd);

    return tr;
  }

  function exportResults() {
    return scan.results.map(function (r) {
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
        moneyOnHand: su.moneyExposed ? su.money : null,
        bazaarBuyout: su.bazaar.buyout,
        bazaarMarketValue: su.bazaar.marketValue,
        itemCount: su.bazaar.count,
        dealCount: su.bazaar.dealCount,
        hasVault: su.vault.hasVault,
        vaultAmount: su.vault.vaultAmount,
        estimate: econ
      };
    });
  }

  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const head = cols.join(',');
    const body = rows
      .map(function (row) {
        return cols
          .map(function (c) {
            const v = row[c];
            const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            return '"' + s.replace(/"/g, '""') + '"';
          })
          .join(',');
      })
      .join('\n');
    return head + '\n' + body;
  }

  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) {
      /* fall through */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  /* --- Setup tab --------------------------------------------------------- */
  /* --- API key capability probe ---------------------------------------
   * Torn tells us precisely why a selection failed (16 = your key level is
   * too low, 7 = that datum is private, 4 = no such selection), so rather
   * than assert what a Limited key can do we ask and report the truth for
   * the key the user actually pasted.
   */
  async function findProbeId() {
    // Reuse a player we have already seen, else try the lowest ids Torn has.
    const seen = scan.subjects.length ? scan.subjects[0].id : null;
    const candidates = [seen].concat([1, 2, 3, 4, 5, 10, 100]).filter(Boolean);
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      if (isSelf(id)) continue;
      const res = await tornGet(
        '/user/' + id + '?selections=profile&key=' + KEY_URL_SAFE(settings.api.tornKey)
      );
      if (res.ok) return id;
      // A key-level problem will never resolve by trying another id.
      if (res.code === ERR_KEY_LEVEL || res.code === ERR_BAD_KEY) return null;
    }
    return null;
  }

  function explainCode(code) {
    if (code === ERR_KEY_LEVEL) return 'key level too low';
    if (code === ERR_PRIVATE) return 'private for this player';
    if (code === ERR_ACCESS) return 'wrong key type';
    if (code === ERR_FIELDS) return 'selection not available';
    if (code === ERR_BAD_ID) return 'test id not found';
    if (code === ERR_TOO_MANY) return 'rate limited, try again';
    if (code === ERR_BAD_KEY) return 'incorrect key';
    return 'error ' + code;
  }

  async function probeKeyCapabilities() {
    const key = KEY_URL_SAFE(settings.api.tornKey);
    const rows = [];

    rows.push({
      label: 'Your own profile',
      res: await tornGet('/user/?selections=basic&key=' + key)
    });
    rows.push({
      label: 'Item list (for the picker)',
      res: await tornGet('/torn/?selections=items&key=' + key)
    });
    rows.push({
      label: "Item market bazaar listings",
      res: await tornGet('/market/206?selections=bazaar&key=' + key)
    });

    const probeId = await findProbeId();
    if (probeId) {
      for (let i = 0; i < ['profile', 'bazaar', 'property', 'money'].length; i++) {
        const sel = ['profile', 'bazaar', 'property', 'money'][i];
        rows.push({
          label: "Another player's " + sel,
          res: await tornGet(
            '/user/' + probeId + '?selections=' + sel + '&key=' + key
          ),
          sel: sel
        });
      }
    } else {
      // Never quietly drop half the report: say the check did not run.
      rows.push({
        label: "Other players' data (not tested)",
        res: { ok: false, code: ERR_BAD_ID, error: 'no player available to test against' },
        skipped: true
      });
    }

    return rows.map(function (row) {
      const ok = row.res.ok;
      let note = '';
      if (ok) {
        // A 200 does not always mean the data was there: Torn omits a
        // selection it will not hand over rather than failing the call.
        const missing = row.sel && row.res.data && row.res.data[row.sel] === undefined;
        if (missing) {
          note = 'returned nothing for this player';
        }
      } else {
        note = explainCode(row.res.code);
      }
      return {
        label: row.label,
        ok: ok,
        note: row.skipped ? 'not tested - scan or load stats first' : note,
        code: row.res.ok ? null : row.res.code
      };
    });
  }

  function renderKeyReport(rows, host) {
    if (!host) return;
    host.innerHTML = '';
    if (!rows || !rows.length) return;

    const blocked = rows.filter(function (r) {
      return !r.ok && (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS);
    });

    if (blocked.length) {
      host.appendChild(
        el('div', {
          class: 'tbms-pill tbms-bad',
          style: 'margin-bottom:6px;display:inline-block;',
          text: 'Raise this key to Limited'
        })
      );
    } else {
      host.appendChild(
        el('div', {
          class: 'tbms-pill tbms-ok',
          style: 'margin-bottom:6px;display:inline-block;',
          text: 'Key can read everything the script needs'
        })
      );
    }

    const table = el('table', { class: 'tbms-table' });
    rows.forEach(function (r) {
      const tr = el('tr');
      tr.appendChild(
        el('td', {
          class: r.ok ? '' : 'tbms-wrap',
          text: (r.ok ? '\u2713 ' : '\u2717 ') + r.label
        })
      );
      const noteTd = el('td', { class: 'tbms-wrap' });
      if (r.note) {
        noteTd.appendChild(
          el('span', {
            class:
              'tbms-pill ' +
              (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS
                ? 'tbms-bad'
                : r.code === ERR_PRIVATE
                ? 'tbms-warn'
                : 'tbms-warn'),
            text: r.note
          })
        );
      }
      tr.appendChild(noteTd);
      table.appendChild(tr);
    });
    host.appendChild(table);

    host.appendChild(
      el('div', {
        class: 'tbms-hint',
        style: 'margin-top:6px;',
        text:
          '"Private for this player" is not a key problem - that specific player keeps the datum hidden. "Returned nothing" means the call worked but Torn withheld the value.'
      })
    );
  }

  function renderSetupTab() {
    const s = section('setup');
    s.innerHTML = '';

    /* --- keys --- */
    const keySec = el('div', { class: 'tbms-sec' });
    keySec.appendChild(el('h4', { text: 'API keys' }));
    keySec.appendChild(
      el('div', {
        class: 'tbms-hint',
        text:
          'Kept in Tampermonkey storage. Sent only to api.torn.com, ffscouter.com and weav3r.dev.'
      })
    );

    keySec.appendChild(
      el('div', {
        class: 'tbms-hint',
        style: 'margin:6px 0;border-left:2px solid #2f97a8;padding-left:8px;',
        text:
          'Use a LIMITED key. Torn has four levels - Public, Minimal, Limited, Full - and this script has to read other players\u2019 bazaars, property and cash, which Public and Minimal are not allowed to do. Full works too. If a selection is out of reach Torn answers "access level of this key is not high enough", and the test below will tell you exactly which ones are blocked.'
      })
    );

    const keyInput = el('input', {
      class: 'tbms-text',
      type: 'password',
      placeholder: 'your 16-character Torn API key',
      autocomplete: 'off',
      spellcheck: 'false'
    });
    keyInput.value = settings.api.tornKey || '';
    keyInput.addEventListener('change', function () {
      settings.api.tornKey = keyInput.value.trim();
      saveSettings();
    });
    keySec.appendChild(el('div', { class: 'tbms-row' }, [keyInput]));

    const ffKeyInput = el('input', {
      class: 'tbms-text',
      type: 'password',
      placeholder: '(optional) separate key for FFScouter - blank reuses the Torn key',
      autocomplete: 'off'
    });
    ffKeyInput.value = settings.api.ffKey || '';
    ffKeyInput.addEventListener('change', function () {
      settings.api.ffKey = ffKeyInput.value.trim();
      saveSettings();
    });
    const btnRow = el('div', { class: 'tbms-row' });

    const reportHost = el('div', { id: 'tbms-key-report', style: 'margin-top:8px;' });

    const loadBtn = el('button', { class: 'tbms-btn tbms-primary', text: 'Test keys & load my stats' });
    loadBtn.addEventListener('click', async function () {
      loadBtn.disabled = true;
      setStatus('Checking keys...');
      try {
        const me = await fetchSelf();
        const basic = (me && me.basic) || {};
        const profile = (me && me.profile) || {};
        const bs =
          parseBattleStats(me.stats) || parseBattleStats(me.battlestats) || null;

        settings.me.id = toNumber(basic.player_id) || settings.me.id;
        settings.me.name = profile.name || basic.name || settings.me.name;
        settings.me.level = toNumber(profile.level) || settings.me.level;
        settings.me.factionId = toNumber(basic.faction_id) || 0;
        if (bs) {
          settings.me.bs = bs;
          settings.me.bsUpdated = Date.now();
        }
        saveSettings();
        renderSetupTab();

        let ffNote = '';
        try {
          const check = await ffCheckKey();
          if (check && check.is_registered === false) {
            ffNote =
              ' FFScouter does not recognise that key yet - register it at ffscouter.com or stat estimates will come back empty.';
            setStatus(settings.me.name + ': stats loaded.' + ffNote, 'warn');
          } else {
            ffNote =
              ' FFScouter: registered' + (check && check.is_premium ? ' (premium)' : '') + '.';
            setStatus(settings.me.name + ': stats loaded.' + ffNote, 'ok');
          }
        } catch (e) {
          ffNote = ' Could not reach FFScouter: ' + e.message;
          setStatus(settings.me.name + ': stats loaded.' + ffNote, 'warn');
        }

        // Then ask Torn what this specific key is actually allowed to read.
        try {
          const report = await probeKeyCapabilities();
          // renderSetupTab() above rebuilt the tab, so find the host again
          // rather than writing into the node we just threw away.
          renderKeyReport(report, document.getElementById('tbms-key-report'));
          const blocked = report.filter(function (r) {
            return !r.ok && (r.code === ERR_KEY_LEVEL || r.code === ERR_ACCESS);
          }).length;
          if (blocked) {
            setStatus(
              blocked +
                ' selection(s) are above this key\u2019s level - raise it to Limited. See the report below.',
              'warn'
            );
          }
        } catch (e) {
          log('Key probe failed: ' + e.message, 'warn');
        }
      } catch (e) {
        setStatus('Torn API: ' + e.message, 'error');
      } finally {
        loadBtn.disabled = false;
      }
    });
    btnRow.appendChild(loadBtn);

    const probeBtn = el('button', { class: 'tbms-btn', text: 'Re-check key level' });
    probeBtn.addEventListener('click', async function () {
      probeBtn.disabled = true;
      setStatus('Asking Torn what this key may read...', 'progress');
      try {
        const report = await probeKeyCapabilities();
        renderKeyReport(report, reportHost);
        setStatus('Key checked - see the report below.', 'ok');
      } catch (e) {
        setStatus('Key check failed: ' + e.message, 'error');
      } finally {
        probeBtn.disabled = false;
      }
    });
    btnRow.appendChild(probeBtn);

    const clearBtn = el('button', { class: 'tbms-btn', text: 'Clear cached player data' });
    clearBtn.addEventListener('click', function () {
      cacheFlush();
      setStatus('Cache cleared.', 'ok');
    });
    btnRow.appendChild(clearBtn);

    const resetBtn = el('button', { class: 'tbms-btn tbms-danger', text: 'Reset all settings' });
    resetBtn.addEventListener('click', function () {
      if (!window.confirm('Reset every setting, including your API keys?')) return;
      settings = mergeDefaults(DEFAULT_SETTINGS, {});
      saveSettings();
      renderFiltersTab();
      renderSetupTab();
      renderScanTab();
      renderResults();
      setStatus('Settings reset.', 'ok');
    });
    btnRow.appendChild(resetBtn);
    keySec.appendChild(btnRow);
    keySec.appendChild(reportHost);
    s.appendChild(keySec);

    /* --- me --- */
    const meSec = el('div', { class: 'tbms-sec' });
    meSec.appendChild(el('h4', { text: 'Your stats (the yardstick)' }));
    const meGrid = el('div', { class: 'tbms-kv' });
    meGrid.appendChild(el('b', { text: 'Name' }));
    meGrid.appendChild(el('span', { text: settings.me.name || 'not loaded' }));
    meGrid.appendChild(el('b', { text: 'Player ID' }));
    meGrid.appendChild(el('span', { text: settings.me.id ? String(settings.me.id) : 'unknown' }));
    meGrid.appendChild(el('b', { text: 'Total battle stats' }));
    meGrid.appendChild(el('span', { text: settings.me.bs ? formatNumber(settings.me.bs) : 'unknown' }));
    meGrid.appendChild(el('b', { text: 'Faction' }));
    meGrid.appendChild(el('span', { text: settings.me.factionId ? String(settings.me.factionId) : 'none' }));
    meSec.appendChild(meGrid);
    meSec.appendChild(
      el('div', {
        class: 'tbms-hint',
        text: 'Used as the yardstick for "stats at most mine x".'
      })
    );

    const bsManual = el('div', { class: 'tbms-row' });
    bsManual.appendChild(el('label', { text: 'Or type your total stats manually' }));
    const bsInput = el('input', { class: 'tbms-num', type: 'number' });
    bsInput.value = settings.me.bs || 0;
    bsInput.addEventListener('change', function () {
      settings.me.bs = Number(bsInput.value) || 0;
      saveSettings();
      renderSetupTab();
    });
    bsManual.appendChild(bsInput);
    meSec.appendChild(bsManual);
    s.appendChild(meSec);

    /* --- performance --- */
    // Rate limits and estimate assumptions stay available but folded away;
    // they are not what most people came here for.
    const advSec = el('details', { class: 'tbms-adv' });
    advSec.appendChild(el('summary', { text: 'Advanced settings' }));

    const ffKeySec = el('div', { class: 'tbms-sec' });
    ffKeySec.appendChild(el('h4', { text: 'Separate FFScouter key' }));
    ffKeySec.appendChild(
      el('div', { class: 'tbms-hint', text: 'Leave blank to reuse the Torn key.' })
    );
    ffKeySec.appendChild(el('div', { class: 'tbms-row' }, [ffKeyInput]));
    advSec.appendChild(ffKeySec);

    const perfSec = el('div', { class: 'tbms-sec' });
    perfSec.appendChild(el('h4', { text: 'Requests & performance' }));
    [
      ['api.delayMs', 'Gap between Torn calls (ms)', 'Torn allows 100/minute. Raising this is the safest knob.'],
      ['api.maxPerMinute', 'Torn calls per minute cap'],
      ['api.workers', 'Parallel Torn lookups'],
      ['api.cacheMinutes', 'Reuse cached player data (minutes)'],
      ['api.ffChunkSize', 'IDs per FFScouter request'],
      ['api.rateLimitWaitMs', 'Wait after a rate limit (ms)'],
      ['scan.maxTargetsPerScan', 'Maximum sellers scanned per run']
    ].forEach(function (triple) {
      const row = el('div', { class: 'tbms-row' });
      row.appendChild(el('label', { text: triple[1] }));
      const input = el('input', { class: 'tbms-num', type: 'number' });
      input.value = getPath(triple[0]);
      input.addEventListener('change', function () {
        const v = Number(input.value);
        setPath(triple[0], isFinite(v) && v > 0 ? v : 1);
      });
      row.appendChild(input);
      if (triple[2]) row.appendChild(el('span', { class: 'tbms-hint', text: triple[2] }));
      perfSec.appendChild(row);
    });

    const autoRow = el('div', { class: 'tbms-row' });
    const autoSwitch = el('label', { class: 'tbms-switch' });
    const autoInput = el('input', { type: 'checkbox' });
    autoInput.checked = !!settings.scan.autoHarvest;
    autoInput.addEventListener('change', function () {
      settings.scan.autoHarvest = autoInput.checked;
      saveSettings();
    });
    autoSwitch.appendChild(autoInput);
    autoSwitch.appendChild(el('span', { class: 'tbms-slider' }));
    autoRow.appendChild(autoSwitch);
    autoRow.appendChild(el('label', { text: 'Re-count sellers as the page updates' }));
    perfSec.appendChild(autoRow);

    const scriptRow = el('div', { class: 'tbms-row' });
    const scriptSwitch = el('label', { class: 'tbms-switch' });
    const scriptInput = el('input', { type: 'checkbox' });
    scriptInput.checked = !!settings.scan.scanScripts;
    scriptInput.addEventListener('change', function () {
      settings.scan.scanScripts = scriptInput.checked;
      saveSettings();
    });
    scriptSwitch.appendChild(scriptInput);
    scriptSwitch.appendChild(el('span', { class: 'tbms-slider' }));
    scriptRow.appendChild(scriptSwitch);
    scriptRow.appendChild(el('label', { text: 'Also read inline page scripts for seller IDs' }));
    scriptRow.appendChild(
      el('span', {
        class: 'tbms-hint',
        text: 'Wider net, but can pick up unrelated numbers as candidates.'
      })
    );
    perfSec.appendChild(scriptRow);
    advSec.appendChild(perfSec);

    /* --- seller-list sources --- */
    const srcSec = el('div', { class: 'tbms-sec' });
    srcSec.appendChild(el('h4', { text: 'Where seller lists come from' }));
    srcSec.appendChild(
      el('div', {
        class: 'tbms-hint',
        text:
          'Torn\u2019s own API is always tried first. It is authoritative and live, and needs no extra service.'
      })
    );

    const wRow = el('div', { class: 'tbms-row' });
    const wSwitch = el('label', { class: 'tbms-switch' });
    const wInput = el('input', { type: 'checkbox' });
    wInput.checked = !!settings.scan.useWeav3r;
    wInput.addEventListener('change', function () {
      settings.scan.useWeav3r = wInput.checked;
      saveSettings();
    });
    wSwitch.appendChild(wInput);
    wSwitch.appendChild(el('span', { class: 'tbms-slider' }));
    wRow.appendChild(wSwitch);
    const wLabel = el('label', {
      class: 'tbms-label',
      text: 'Fall back to the weav3r.dev scanner',
      title:
        'A community-run bazaar scanner. Only your item ids are sent, never your API key. Turn it off to use Torn alone.'
    });
    wRow.appendChild(wLabel);
    srcSec.appendChild(wRow);
    advSec.appendChild(srcSec);

    /* --- economics --- */
    const econSec = el('div', { class: 'tbms-sec' });
    econSec.appendChild(el('h4', { text: 'Estimate assumptions' }));
    econSec.appendChild(
      el('div', {
        class: 'tbms-hint',
        text:
          'These only shape the rough profit figure. They are your assumptions, not game constants - set them to match what you actually see.'
      })
    );

    [
      ['econ.mugPct', 'Share of their cash a mug takes', '0.01'],
      ['econ.factionCut', 'Fraction your faction takes', '0.01'],
      ['econ.liquidation', 'What a bought item is really worth', '0.01']
    ].forEach(function (triple) {
      const row = el('div', { class: 'tbms-row' });
      row.appendChild(el('label', { text: triple[1] }));
      const input = el('input', { class: 'tbms-num', type: 'number', step: triple[2] });
      input.value = getPath(triple[0]);
      input.addEventListener('change', function () {
        const v = Number(input.value);
        setPath(triple[0], isFinite(v) ? clamp(v, 0, 1) : 0);
      });
      row.appendChild(input);
      econSec.appendChild(row);
    });

    const basketRow = el('div', { class: 'tbms-row' });
    basketRow.appendChild(el('label', { text: 'Basket to buy' }));
    const basketSel = el('select', { class: 'tbms-num' });
    basketSel.style.width = 'auto';
    [
      ['all', 'Everything listed'],
      ['deals', 'Only items under market price']
    ].forEach(function (pair) {
      const o = el('option', { value: pair[0], text: pair[1] });
      if (settings.econ.basket === pair[0]) o.selected = true;
      basketSel.appendChild(o);
    });
    basketSel.addEventListener('change', function () {
      settings.econ.basket = basketSel.value;
      saveSettings();
    });
    basketRow.appendChild(basketSel);
    econSec.appendChild(basketRow);
    advSec.appendChild(econSec);
    s.appendChild(advSec);

    /* --- about --- */
    const about = el('div', { class: 'tbms-sec' });
    about.appendChild(
      el('div', {
        class: 'tbms-hint',
        text:
          'Read-only recon. Never buys, attacks or mugs. Torn and FFScouter rate limits are handled automatically, including waiting out a rate limit and resuming.'
      })
    );
    s.appendChild(about);
  }

  /* ---------------------------------------------------------------
   * 12. Boot
   * --------------------------------------------------------------- */
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('Open Buy-Mug Scout', function () {
      settings.ui.open = true;
      syncPanelVisibility();
    });
    GM_registerMenuCommand('Scan sellers on this page', function () {
      settings.ui.open = true;
      syncPanelVisibility();
      runScan();
    });
    GM_registerMenuCommand('Reset the opener button position', function () {
      settings.ui.fabPos = null;
      settings.ui.panelPos = null;
      settings.ui.panelSize = null;
      saveSettings();
      applyFabPos();
      applyPanelGeom();
      settings.ui.open = true;
      syncPanelVisibility();
      setStatus('Opener and panel reset to their default spot and size.', 'ok');
    });
  }

  function observePage() {
    if (!settings.scan.autoHarvest) return;
    let scheduled = false;
    const mo = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        scheduleHarvest();
      }, 500);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function watchNavigation() {
    // Torn mixes full loads with hash routing; re-count when either happens.
    window.addEventListener('hashchange', scheduleHarvest);
    window.addEventListener('popstate', scheduleHarvest);
    let last = location.href;
    setInterval(function () {
      if (location.href !== last) {
        last = location.href;
        scheduleHarvest();
      }
    }, 1500);
  }

  function init() {
    if (document.getElementById('tbms-root')) return;
    injectStyle();
    buildPanel();
    registerMenu();
    observePage();
    watchNavigation();
    watchFooter();
    watchRateLimitPauses();
    startAutoTicker();
    cachePrune();
    log('Buy-Mug Scout v' + VERSION + ' ready.', 'info');

    // A running background scan picks up where it left off after a reload.
    if (settings.scan.auto.on && settings.scan.auto.itemId) {
      setStatus('Resuming auto-scan after page load...', 'progress');
      scheduleAutoScan(3000);
    }
    if (!settings.api.tornKey) {
      settings.ui.open = true;
      syncPanelVisibility();
      switchTab('setup');
      setStatus('Paste your Torn API key to get started.', 'warn');
    }
  }

  /** Show a live countdown so a parked scan never looks like a hang. */
  function watchRateLimitPauses() {
    onQueuePaused(function (until) {
      (function tick() {
        if (!scan.running) return;
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
          setStatus('Rate limit window passed - resuming.', 'progress');
          return;
        }
        setStatus('Rate limit reached - resuming in ' + left + 's', 'warn');
        setTimeout(tick, 1000);
      })();
    });
  }

  /* ---------------------------------------------------------------
   * 13. Test hooks
   *
   * The pure analysis functions are exposed when the file is loaded
   * outside a browser, so the filtering logic can be tested with plain
   * node instead of a live Torn session.
   * --------------------------------------------------------------- */
  if (typeof module !== 'undefined' && module.exports) {
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
      buildSubject: buildSubject,
      buildStubSubject: buildStubSubject,
      secondsUntilFree: secondsUntilFree,
      formatCountdown: formatCountdown,
      mergeDefaults: mergeDefaults,
      DEFAULT_SETTINGS: DEFAULT_SETTINGS,
      toCsv: toCsv
    };
  }

  if (typeof document !== 'undefined' && document.body) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
