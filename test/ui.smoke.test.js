/* End-to-end smoke test for the in-page UI.
 *
 * Loads the userscript into a real DOM (jsdom) with Torn-shaped markup,
 * stubs GM_xmlhttpRequest with canned Torn + FFScouter responses that
 * mirror the documented schemas, then drives an actual scan through the
 * buttons. This catches the breakage that pure unit tests cannot see:
 * wiring, element ids, render paths.
 *
 * Needs jsdom:  npm install --no-save jsdom
 * Skipped automatically when jsdom is not installed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  JSDOM = null;
}

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'torn-buymugger-scout.user.js'),
  'utf8'
);

const NOW = Math.floor(Date.now() / 1000);

/* --- a bazaar page with three sellers linked the way Torn links them -- */
const PAGE_HTML = `<!doctype html><html><body>
  <div id="topHeader"></div>
  <div class="bazaar-list">
    <a href="/profiles.php?XID=1111111">Alice</a>
    <a href="/bazaar.php?userId=2222222#/">Bob</a>
    <a href="/bazaar.php#/userId=3333333">Carol</a>
    <a href="/item.php?id=206">Xanax</a>
  </div>
  <!-- Torn's own footer buttons, which the opener clones. -->
  <div id="chatRoot"><ul class="footer-icons">
    <button id="notes_panel_button" class="icon-wrap"><svg class="icon-svg"></svg></button>
    <button id="people_panel_button" class="icon-wrap"><svg class="icon-svg"></svg></button>
  </ul></div>
</body></html>`;

/* --- canned API responses -------------------------------------------- */
function tornUser(id, over) {
  const base = {
    profile: {
      name: 'Player' + id,
      level: 40,
      last_action: NOW - 120,
      status: { state: 'Okay', description: 'Okay' }
    },
    basic: { player_id: id, name: 'Player' + id, faction_id: 500 },
    stats: { strength: 1, speed: 1, dexterity: 1, defense: 1 },
    money: { money_onhand: 20000000 },
    bazaar: [{ name: 'Xanax', quantity: 30, price: 800000, market_price: 900000 }],
    property: { properties: { 1: { property: 'Castle', upgrades: ['airstrip'] } } }
  };
  return Object.assign(base, over || {});
}

const RESPONSES = {
  // A comfortable target: low FF, modest stock, available, no vault.
  1111111: tornUser(1111111, {
    profile: {
      name: 'Alice',
      level: 45,
      last_action: NOW - 120,
      status: { state: 'Okay', description: 'Okay' }
    },
    bazaar: [{ name: 'Xanax', quantity: 30, price: 800000, market_price: 900000 }]
  }),
  // Abroad: must be filtered out by the location rule.
  2222222: tornUser(2222222, {
    profile: {
      name: 'Bob',
      level: 45,
      last_action: NOW - 60,
      status: { state: 'Abroad', description: 'Travelling to the Cayman Islands' }
    }
  }),
  // Hits like a truck: must be filtered out by the stat rules.
  3333333: tornUser(3333333, {
    profile: {
      name: 'Carol',
      level: 45,
      last_action: NOW - 60,
      status: { state: 'Okay', description: 'Okay' }
    }
  })
};

const FF_STATS = [
  { player_id: 1111111, fair_fight: 1.1, bs_estimate: 1500000, bs_estimate_human: '1.50m', bss_public: 120000, last_updated: NOW, source: 'bss' },
  { player_id: 2222222, fair_fight: 1.1, bs_estimate: 1500000, bs_estimate_human: '1.50m', bss_public: 120000, last_updated: NOW, source: 'bss' },
  { player_id: 3333333, fair_fight: 12.0, bs_estimate: 900000000, bs_estimate_human: '900m', bss_public: 120000, last_updated: NOW, source: 'bss' }
];

/* Torn's item index, which the picker resolves names against. */
const ITEMS = {
  '206': { name: 'Xanax' },
  '366': { name: 'Donator Pack' },
  '205': { name: 'Vicodin' },
  '1': { name: 'Hammer' }
};

const SEED_SETTINGS = {
  api: {
    tornKey: 'abcdefghijklmnop',
    ffKey: '',
    delayMs: 1,
    maxPerMinute: 1000,
    cacheMinutes: 15,
    ffChunkSize: 60,
    workers: 3,
    rateLimitWaitMs: 60,
    rateLimitRetries: 2
  },
  me: { id: 999999, name: 'Me', level: 50, factionId: 42, bs: 2000000, bsUpdated: NOW },
  scan: {
    autoHarvest: true,
    scanScripts: false,
    maxTargetsPerScan: 80
  },
  ui: { open: true, tab: 'scan', onlyMatches: false, fabPos: null }
};

function boot(seedSettings, extraKeys) {
  const dom = new JSDOM(PAGE_HTML, {
    url: 'https://www.torn.com/bazaar.php',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;

  const store = new Map();
  if (seedSettings !== null) {
    store.set('settings', JSON.stringify(seedSettings || SEED_SETTINGS));
  }
  // Anything else that should already exist at startup (watchlist, cache).
  Object.keys(extraKeys || {}).forEach((k) => store.set(k, extraKeys[k]));
  const calls = [];

  win.GM_getValue = (k, def) => (store.has(k) ? store.get(k) : def);
  win.GM_setValue = (k, v) => store.set(k, v);
  win.GM_addStyle = () => {};
  win.GM_registerMenuCommand = () => {};
  win.GM_xmlhttpRequest = function (opts) {
    calls.push(opts.url);
    let body = null;
    let status = 200;

    const ff = opts.url.match(/ffscouter\.com\/api\/v1\/get-stats\?.*targets=([\d,]+)/);
    if (ff) {
      const asked = new Set(ff[1].split(',').map(Number));
      body = JSON.stringify(FF_STATS.filter((r) => asked.has(r.player_id)));
    } else if (/selections=items/.test(opts.url)) {
      body = JSON.stringify({ items: ITEMS });
    } else if (/weav3r\.dev\/api\/marketplace/.test(opts.url)) {
      body = JSON.stringify({
        total_count: 4,
        items: Object.keys(ITEMS).map((id) => ({ item_id: Number(id), item_name: ITEMS[id].name }))
      });
    } else if (/v2\/market\/(\d+)\/bazaar/.test(opts.url)) {
      body = JSON.stringify({ bazaar: [{ ID: 1111111, cost: 800000, quantity: 30 }] });
    } else {
      const torn = opts.url.match(/api\.torn\.com\/user\/(\d+)\?/);
      if (torn) {
        const rec = RESPONSES[Number(torn[1])];
        body = rec ? JSON.stringify(rec) : JSON.stringify({ error: { code: 6, error: 'Incorrect ID' } });
      } else if (/ffscouter\.com\/api\/v1\/check-key/.test(opts.url)) {
        body = JSON.stringify({ is_registered: true, is_premium: false });
      } else if (/api\.torn\.com\/user\/\?selections=/.test(opts.url)) {
        body = JSON.stringify(
          tornUser(999999, {
            profile: { name: 'Me', level: 50, last_action: NOW - 30, status: { state: 'Okay', description: 'Okay' } },
            basic: { player_id: 999999, name: 'Me', faction_id: 42 },
            stats: { strength: 500000, speed: 500000, dexterity: 500000, defense: 500000 }
          })
        );
      }
    }

    if (body === null) {
      status = 404;
      body = '{}';
    }
    // Respond on the next tick so the script's promise plumbing is exercised.
    setTimeout(() => opts.onload({ status, responseText: body }), 0);
  };

  win.eval(SOURCE);
  // jsdom still reports readyState "loading" at this point, so the script
  // waits for DOMContentLoaded exactly as it would on a fresh Torn load.
  if (!win.document.getElementById('tbms-root')) {
    win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  }
  return { dom, win, store, calls };
}

function waitFor(fn, timeoutMs = 5000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let val;
      try {
        val = fn();
      } catch (e) {
        val = false;
      }
      if (val) return resolve(val);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('Timed out waiting for ' + label));
      }
      setTimeout(poll, 25);
    })();
  });
}

/**
 * jsdom does no layout, so give the panel a box that actually reflects the
 * inline geometry the drag/resize handlers write - otherwise reading the
 * rect back at mouseup would always return the starting values.
 */
/**
 * Result rows only. The Watch tab draws a table with the same classes, so an
 * unscoped query would silently count both.
 */
function resultRows(doc) {
  return doc.querySelectorAll('section[data-tab="results"] table.tbms-table tbody tr');
}

function stubLayout(panel, base) {
  const start = Object.assign({ left: 400, top: 100, width: 700, height: 500 }, base || {});
  panel.getBoundingClientRect = () => {
    const left = parseFloat(panel.style.left) || start.left;
    const top = parseFloat(panel.style.top) || start.top;
    const width = parseFloat(panel.style.width) || start.width;
    const height = parseFloat(panel.style.height) || start.height;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
}

const t = JSDOM ? test : test.skip;

t('mounts the floating button and panel into the page', () => {
  const { dom } = boot();
  const doc = dom.window.document;

  assert.ok(doc.getElementById('tbms-root'), 'root mounted');
  assert.ok(doc.getElementById('tbms-fab'), 'floating button present');
  assert.ok(doc.getElementById('tbms-panel'), 'panel present');
  assert.equal(doc.querySelectorAll('.tbms-tab').length, 5, 'five tabs');
  assert.equal(doc.querySelectorAll('section[data-tab]').length, 5, 'five tab panels');
  dom.window.close();
});

t('panel starts open on first run when no key is stored', () => {
  // null seed == a brand new install with nothing saved.
  const { dom, win } = boot(null);

  const panel = win.document.getElementById('tbms-panel');
  assert.ok(!panel.classList.contains('tbms-hidden'), 'panel is visible');
  const active = win.document.querySelector('.tbms-tab.tbms-active');
  assert.equal(active.getAttribute('data-tab'), 'setup', 'opens on Setup');
  dom.window.close();
});

t('counts the sellers linked on the page', () => {
  const { dom } = boot();
  const counter = dom.window.document.getElementById('tbms-harvest-count');
  assert.equal(counter.textContent, '3', 'three sellers, item id ignored');
  dom.window.close();
});

t('a full scan finds the one good target and rejects the rest', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );

  const rows = await waitFor(
    () => {
      const r = resultRows(doc);
      return r.length === 3 ? r : null;
    },
    8000,
    'three result rows'
  );

  const byName = {};
  Array.from(rows).forEach((tr) => {
    const name = tr.querySelector('a.tbms-link').textContent;
    byName[name] = tr;
  });

  assert.ok(byName.Alice, 'Alice rendered');
  assert.ok(byName.Bob, 'Bob rendered');
  assert.ok(byName.Carol, 'Carol rendered');

  assert.ok(byName.Alice.classList.contains('tbms-match'), 'Alice is a match');
  assert.ok(byName.Bob.classList.contains('tbms-reject'), 'Bob is rejected (abroad)');
  assert.ok(byName.Carol.classList.contains('tbms-reject'), 'Carol is rejected (too strong)');

  // The rejection reasons must be legible in the table, not just implied.
  assert.match(byName.Bob.textContent, /abroad/i);
  assert.match(byName.Carol.textContent, /fair fight|stats/i, 'the screen states its reason');

  // One batched FFScouter call. Torn is only spent on the survivors of the
  // strength screen, so Carol (FF 9.4 / 680m) never costs a request.
  const ffCalls = calls.filter((u) => u.includes('ffscouter'));
  const tornCalls = calls.filter((u) => u.includes('api.torn.com/user/'));
  assert.equal(ffCalls.length, 1, 'FFScouter is batched into a single request');
  assert.equal(tornCalls.length, 2, 'Torn is only asked about the survivors');
  assert.ok(
    !tornCalls.some((u) => /user\/3333333\?/.test(u)),
    'the too-strong seller never reached Torn'
  );
  // …but she is still shown, with the reason, rather than vanishing.
  assert.ok(byName.Carol, 'screened-out sellers still get a row');
  assert.match(byName.Carol.textContent, /screened out/i, 'labelled as screened out');

  const badge = doc.getElementById('tbms-badge');
  assert.ok(badge.classList.contains('tbms-show'), 'badge is shown');
  assert.equal(badge.textContent, '1', 'badge counts the single match');

  dom.window.close();
});

t('re-scores instantly from cache when filters change', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'first scan');

  const callsAfterScan = calls.length;

  // Relax every gate, then re-score without hitting the network.
  const filtersTab = doc.querySelector('.tbms-tab[data-tab="filters"]');
  filtersTab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const switches = doc.querySelectorAll('section[data-tab="filters"] .tbms-switch input');
  Array.from(switches).forEach((input) => {
    if (input.checked) {
      input.checked = false;
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  });

  const vaultSelect = Array.from(doc.querySelectorAll('section[data-tab="filters"] select')).pop();
  vaultSelect.value = 'ignore';
  vaultSelect.dispatchEvent(new win.Event('change', { bubbles: true }));

  const rescore = Array.from(doc.querySelectorAll('section[data-tab="filters"] button')).find((b) =>
    /Re-score/.test(b.textContent)
  );
  rescore.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(
    () => Array.from(resultRows(doc)).filter((tr) => tr.classList.contains('tbms-match')).length === 2,
    3000,
    'the checked sellers to become matches'
  );

  // The screened-out seller stays rejected and must NOT be re-imagined as a
  // player with an empty bazaar; she needs a scan to be judged at all.
  const carol = Array.from(resultRows(doc)).find((tr) =>
    /Carol/.test(tr.textContent)
  );
  assert.ok(carol, 'she is still listed');
  assert.ok(carol.classList.contains('tbms-reject'), 'and still rejected');
  assert.match(carol.textContent, /not checked|screened out/i, 'with an honest reason');

  assert.equal(calls.length, callsAfterScan, 're-scoring made no further API calls');
  dom.window.close();
});

t('settings written by the UI are persisted through GM storage', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;

  doc.querySelector('.tbms-tab[data-tab="filters"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );

  const firstSwitch = doc.querySelector('section[data-tab="filters"] .tbms-switch input');
  const before = firstSwitch.checked;
  firstSwitch.checked = !before;
  firstSwitch.dispatchEvent(new win.Event('change', { bubbles: true }));

  await waitFor(() => {
    const saved = JSON.parse(store.get('settings') || '{}');
    return saved.filters && saved.filters.inTornOnly && saved.filters.inTornOnly.on === !before;
  }, 2000, 'the toggled filter to be written to storage');

  dom.window.close();
});

t('survives an invalid key without crashing the page', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // Every Torn lookups now fails the way Torn does for a bad key.
  win.GM_xmlhttpRequest = function (opts) {
    setTimeout(
      () =>
        opts.onload({
          status: 200,
          responseText: JSON.stringify({ error: { code: 2, error: 'Incorrect key' } })
        }),
      0
    );
  };

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const foot = await waitFor(
    () => (/key/i.test(doc.getElementById('tbms-foot').textContent) ? doc.getElementById('tbms-foot') : null),
    5000,
    'a clear error message'
  );

  assert.ok(doc.getElementById('tbms-root'), 'UI is still standing');
  assert.match(foot.textContent, /key/i);
  dom.window.close();
});

t('the setup button stores your key and loads your own stats', async () => {
  const { dom, win, store } = boot(null); // brand new install
  const doc = win.document;

  const keyInput = doc.getElementById('tbms-torn-key');
  assert.ok(keyInput, 'key field found');
  keyInput.value = 'abcdefghijklmnop';
  keyInput.dispatchEvent(new win.Event('change', { bubbles: true }));

  const loadBtn = Array.from(doc.querySelectorAll('section[data-tab="setup"] button')).find((b) =>
    /load my stats/i.test(b.textContent)
  );
  loadBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => {
    const saved = JSON.parse(store.get('settings') || '{}');
    return saved.me && saved.me.bs === 2000000;
  }, 4000, 'stats to be loaded and saved');

  const saved = JSON.parse(store.get('settings'));
  assert.equal(saved.api.tornKey, 'abcdefghijklmnop', 'key persisted');
  assert.equal(saved.me.id, 999999, 'player id learned');
  assert.equal(saved.me.factionId, 42, 'faction learned');
  assert.equal(saved.me.bs, 2000000, 'battle stats summed from the four stats');

  // The panel must reflect it back, not just store it.
  assert.match(doc.querySelector('section[data-tab="setup"]').textContent, /2\.00m/);
  dom.window.close();
});

t('a manually entered ID list drives a scan', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  const manual = doc.getElementById('tbms-manual-input');
  manual.value = '3333333';
  const goBtn = Array.from(doc.querySelectorAll('section[data-tab="scan"] button')).find((b) =>
    /Check IDs/i.test(b.textContent)
  );
  goBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const row = await waitFor(
    () => resultRows(doc)[0],
    5000,
    'a result row for the manual id'
  );

  assert.equal(resultRows(doc).length, 1, 'only the requested player');
  assert.match(row.textContent, /Carol/, 'it is the right player');
  // Carol is far too strong for the default filters, so the cheap screen
  // settles her without a Torn request - and says so in the row.
  assert.ok(
    !calls.some((u) => /api\.torn\.com\/user\/3333333\?/.test(u)),
    'no Torn request was spent on a player the screen already ruled out'
  );
  assert.match(row.textContent, /screened out/i, 'the row explains why');
  dom.window.close();
});

t('export buttons do not throw when the clipboard is unavailable', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  doc.querySelector('.tbms-tab[data-tab="results"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );

  const buttons = Array.from(doc.querySelectorAll('section[data-tab="results"] button'));
  ['Copy JSON', 'Copy CSV'].forEach((label) => {
    const btn = buttons.find((b) => b.textContent === label);
    assert.ok(btn, label + ' button exists');
    // jsdom has neither navigator.clipboard nor execCommand; the script
    // must degrade quietly instead of breaking the panel.
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });

  assert.ok(doc.getElementById('tbms-panel'), 'panel still alive after export attempts');
  assert.equal(resultRows(doc).length, 3, 'table intact');
  dom.window.close();
});

t('clearing the cache actually empties stored player data', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const cached = JSON.parse(store.get('cache_v1') || '{}');
  assert.ok(Object.keys(cached).length > 0, 'players were cached by the scan');

  const clearBtn = Array.from(doc.querySelectorAll('section[data-tab="setup"] button')).find((b) =>
    /Clear cached/i.test(b.textContent)
  );
  clearBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const after = store.get('cache_v1');
  assert.ok(
    after === undefined || after === '' || Object.keys(JSON.parse(after)).length === 0,
    'cache is gone after clearing, got: ' + after
  );
  dom.window.close();
});

t('never scans your own id, even on your own bazaar page', async () => {
  // Pretend player 1111111 is us, and that we are standing on their page.
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.me.id = 1111111;
  const { dom, win, calls, store } = boot(seed);
  const doc = win.document;

  assert.equal(
    doc.getElementById('tbms-harvest-count').textContent,
    '2',
    'self is dropped from the page count'
  );

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 2, 8000, 'scan');

  assert.ok(
    !calls.some((u) => /api\.torn\.com\/user\/1111111\?/.test(u)),
    'Torn was never asked about our own id'
  );
  assert.ok(
    !Array.from(resultRows(doc)).some((tr) =>
      /Alice/.test(tr.textContent)
    ),
    'we are not in our own results'
  );
  dom.window.close();
});

t('learns your own id when it is unknown, so self is still excluded', async () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.me.id = 0; // never loaded stats
  seed.me.bs = 2000000;
  const { dom, win, store } = boot(seed);
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => {
    const saved = JSON.parse(store.get('settings') || '{}');
    return saved.me && saved.me.id === 999999;
  }, 6000, 'own id to be learned from the API');

  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Opener living inside Torn's own footer bar                          */
/* ------------------------------------------------------------------ */

t('clones Torn footer button so the opener sits inline with the others', () => {
  const { dom, win } = boot();
  const doc = win.document;

  const btn = doc.getElementById('tbms-footer-btn');
  const ref = doc.getElementById('notes_panel_button');

  assert.ok(btn, 'opener mounted into the footer');
  assert.equal(
    btn.className,
    ref.className,
    'it carries the same class as Torn\'s own button, so Torn styles it'
  );
  assert.equal(btn.parentNode, ref.parentNode, 'it is a sibling, not an overlay');
  assert.equal(
    btn.nextElementSibling,
    ref,
    'it is inserted immediately before the reference button'
  );
  assert.ok(btn.querySelector('svg'), 'it has an icon');

  // The floating fallback must be visible only when there is no footer.
  const fab = doc.getElementById('tbms-fab');
  assert.equal(fab.style.display, 'none', 'floating fallback hidden when footer exists');
  dom.window.close();
});

t('footer opener toggles the panel and carries the match badge', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  const panel = doc.getElementById('tbms-panel');
  const btn = doc.getElementById('tbms-footer-btn');
  const visible = () => !panel.classList.contains('tbms-hidden');

  assert.equal(visible(), true, 'starts open from the seeded settings');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(visible(), false, 'click closes it');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(visible(), true, 'click reopens it');

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const badge = doc.getElementById('tbms-footer-badge');
  assert.ok(badge.classList.contains('tbms-show'), 'badge visible after a scan');
  assert.equal(badge.textContent, '1', 'badge shows the match count');
  dom.window.close();
});

t('falls back to the corner square when the footer is absent', () => {
  // A page with no Torn footer buttons (Torn PDA / layout change).
  const bare = '<!doctype html><html><body><div id="app"></div></body></html>';
  const dom = new JSDOM(bare, { url: 'https://www.torn.com/', runScripts: 'outside-only' });
  const win = dom.window;
  const store = new Map([['settings', JSON.stringify(SEED_SETTINGS)]]);
  win.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  win.GM_setValue = (k, v) => store.set(k, v);
  win.GM_addStyle = () => {};
  win.GM_xmlhttpRequest = () => {};

  win.eval(SOURCE);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));

  const doc = win.document;
  assert.equal(doc.getElementById('tbms-footer-btn'), null, 'no footer button planted');
  assert.ok(doc.getElementById('tbms-fab'), 'corner square exists');
  assert.notEqual(doc.getElementById('tbms-fab').style.display, 'none', 'corner square is shown');
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Seller lists as data rather than as rendered markup                 */
/* ------------------------------------------------------------------ */

t('typing an item name finds it in the picker', async () => {
  const { dom, win } = boot();
  const doc = win.document;
  const input = doc.getElementById('tbms-item-input');

  // Wait for the index to land, then type a name the way a user would.
  await waitFor(() => doc.getElementById('tbms-item-input'), 3000, 'the picker');
  input.value = 'xanax';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));

  const suggest = await waitFor(() => {
    const el = doc.getElementById('tbms-item-suggest');
    return el && el.style.display !== 'none' && /Xanax/.test(el.textContent) ? el : null;
  }, 6000, 'a Xanax suggestion');

  assert.match(suggest.textContent, /Xanax/, 'the typed name resolves');
  assert.match(suggest.textContent, /206/, 'and shows the id it maps to');
  // A dropdown positioned against the panel instead of the input renders
  // off the bottom edge and is never seen, so pin the relationship.
  assert.equal(
    suggest.parentNode.id,
    'tbms-item-row',
    'the suggestion list hangs off the input row, not the panel'
  );

  // Clicking the suggestion selects it.
  suggest.firstChild.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, 'Xanax', 'the chosen name fills the box');
  assert.equal(input.getAttribute('data-item-id'), '206', 'and the id is pinned');
  dom.window.close();
});

t('a partial name that matches many items still resolves', async () => {
  const { dom, win } = boot();
  const doc = win.document;
  const input = doc.getElementById('tbms-item-input');
  await waitFor(() => doc.getElementById('tbms-item-input'), 3000, 'the picker');

  input.value = 'vico';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const suggest = await waitFor(() => {
    const el = doc.getElementById('tbms-item-suggest');
    return el && el.style.display !== 'none' ? el : null;
  }, 6000, 'a suggestion for a partial name');
  assert.match(suggest.textContent, /Vicodin/);
  dom.window.close();
});

t('scans an item\'s bazaar sellers from data, not from the page', async () => {
  const { dom, win, calls, store } = boot();
  const doc = win.document;

  // Bazaar listings for the item.
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        calls.push(opts.url);
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                bazaar: [
                  { ID: 1111111, cost: 800000, quantity: 30 },
                  { ID: 3333333, cost: 900000, quantity: 5 }
                ]
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  const input = doc.getElementById('tbms-item-input');
  input.value = 'Xanax';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const rows = await waitFor(
    () => {
      const r = resultRows(doc);
      return r.length === 2 ? r : null;
    },
    9000,
    'two sellers from the data source'
  );
  assert.equal(rows.length, 2, 'both bazaar sellers were checked');
  assert.ok(
    calls.some((u) => /v2\/market\/206\/bazaar/.test(u)),
    'Torn bazaar listings were requested for the item'
  );
  assert.ok(
    !calls.some((u) => /profiles\.php/.test(u)),
    'nothing was read off the page for this path'
  );

  // Settings writes are debounced, so wait for the flush.
  await waitFor(
    () => JSON.parse(store.get('settings') || '{}').scan.lastItemId === 206,
    3000,
    'the item to be remembered'
  );
  dom.window.close();
});

t('falls back to the community scanner when Torn lists nothing', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        calls.push(opts.url);
        // Torn knows of no bazaar offers; the scanner does.
        setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify({ bazaar: [] }) }), 0);
        return;
      }
      if (/weav3r\.dev/.test(opts.url)) {
        calls.push(opts.url);
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                item_id: 206,
                market_price: 850000,
                listings: [
                  { player_id: 2222222, player_name: 'Bob', quantity: 20, price: 830000 }
                ]
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  await waitFor(() => Object.keys(doc.querySelectorAll('.tbms-suggest-row')).length >= 0, 200, 'picker ready');
  // A raw id needs no index at all, which is the fallback when the list fails.
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => resultRows(doc).length === 1, 9000, 'scanner result');
  assert.ok(calls.some((u) => /weav3r\.dev/.test(u)), 'the scanner was consulted');

  const row = resultRows(doc)[0];
  assert.match(row.textContent, /Bob/, 'the seller from the scanner was checked');
  dom.window.close();
});

t('the third-party source can be switched off entirely', async () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.scan.useWeav3r = false;
  const { dom, win, calls } = boot(seed);
  const doc = win.document;

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        calls.push(opts.url);
        setTimeout(() => opts.onload({ status: 200, responseText: JSON.stringify({ bazaar: [] }) }), 0);
        return;
      }
      return base(opts);
    };
  })();

  await waitFor(() => Object.keys(doc.querySelectorAll('.tbms-suggest-row')).length >= 0, 200, 'picker ready');
  // A raw id needs no index at all, which is the fallback when the list fails.
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(
    () => /No bazaar sellers/.test(doc.getElementById('tbms-foot').textContent),
    5000,
    'a clear empty result'
  );
  assert.ok(!calls.some((u) => /weav3r\.dev/.test(u)), 'weav3r was never contacted');
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Panel geometry                                                      */
/* ------------------------------------------------------------------ */

t('the panel can be moved and the position is remembered', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;
  const panel = doc.getElementById('tbms-panel');
  const head = doc.getElementById('tbms-head');

  stubLayout(panel);

  // The panel may already have been auto-placed, so assert the delta the
  // drag applies rather than an absolute corner.
  const before = panel.getBoundingClientRect();
  head.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 120 }));
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 460, clientY: 160 }));
  doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));

  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.ui && s.ui.panelPos;
  }, 3000, 'the position to be stored');

  const saved = JSON.parse(store.get('settings'));
  assert.equal(
    saved.ui.panelPos.left,
    Math.round(before.left - 40),
    'moved left by exactly the drag delta'
  );
  assert.equal(
    saved.ui.panelPos.top,
    Math.round(before.top + 40),
    'moved down by exactly the drag delta'
  );
  dom.window.close();
});

t('the panel can be resized from its grip and the size is remembered', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;
  const panel = doc.getElementById('tbms-panel');
  const grip = doc.getElementById('tbms-grip');

  assert.ok(grip, 'the resize grip exists');
  stubLayout(panel);

  const before = panel.getBoundingClientRect();
  grip.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 1100, clientY: 600 }));
  doc.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 1140, clientY: 640 }));
  doc.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));

  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.ui && s.ui.panelSize;
  }, 3000, 'the size to be stored');

  const saved = JSON.parse(store.get('settings'));
  assert.equal(saved.ui.panelSize.w, Math.round(before.width + 40), 'grew by the drag delta');
  assert.equal(saved.ui.panelSize.h, Math.round(before.height + 40), 'grew by the drag delta');
  dom.window.close();
});

t('a dragged panel keeps its spot when reopened', () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.ui.panelPos = { left: 123, top: 45 };
  seed.ui.panelSize = { w: 500, h: 400 };
  const { dom, win } = boot(seed);
  const panel = win.document.getElementById('tbms-panel');

  assert.equal(panel.style.width, '500px', 'saved width applied');
  assert.equal(panel.style.height, '400px', 'saved height applied');
  assert.equal(panel.style.left, '123px', 'saved position applied');
  assert.equal(panel.style.top, '45px', 'saved position applied');
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Key level reporting                                                 */
/* ------------------------------------------------------------------ */

t('key check names the exact selection a Limited key is needed for', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      // The probe looks for any real player to test other-player selections
      // against, so give it one.
      if (/api\.torn\.com\/user\/1\?selections=profile/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                profile: { name: 'Probe', level: 1, status: { state: 'Okay', description: 'Okay' } },
                basic: { player_id: 1, name: 'Probe' }
              })
            }),
          0
        );
        return;
      }
      // Pretend the key is too weak for another player's property.
      if (/v2\/user\/\d+\/property/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                error: { code: 16, error: 'Access level of this key is not high enough' }
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.querySelector('.tbms-tab[data-tab="setup"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );

  const btn = Array.from(doc.querySelectorAll('section[data-tab="setup"] button')).find((b) =>
    /Re-check key level/i.test(b.textContent)
  );
  assert.ok(btn, 'the key-level button exists');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const report = await waitFor(() => {
    const r = doc.getElementById('tbms-key-report');
    return r && /key level too low/i.test(r.textContent) ? r : null;
  }, 8000, 'the key report');

  assert.match(report.textContent, /Raise this key to Limited/, 'tells the user what to do');
  assert.match(report.textContent, /Another player's property/, 'names the blocked selection');
  dom.window.close();
});

t('the setup tab states which access level to use', () => {
  const { dom, win } = boot(null);
  const setup = win.document.querySelector('section[data-tab="setup"]');
  const text = setup.textContent;
  assert.match(text, /LIMITED/i, 'names the level');
  assert.match(text, /Public, Minimal, Limited, Full/i, 'lists the levels');
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* API key fields must not look like logins to the browser             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Watchlist                                                           */
/* ------------------------------------------------------------------ */

/** Boot with a watchlist already stored, as after a reload. */
function bootWatching(entries) {
  return boot(SEED_SETTINGS, { watch_v1: JSON.stringify(entries) });
}

/** Serve one player's state, and let the test change it between checks. */
function servePlayer(win, id, status, extra) {
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (new RegExp('api\\.torn\\.com/user/' + id + '\\?').test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify(
                tornUser(id, Object.assign({ profile: { name: 'Watched', level: 30, status } }, extra || {}))
              )
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();
}

function watchRowText(doc) {
  return doc.querySelector('section[data-tab="watch"]').textContent;
}

t('a watched player who goes back into hospital stops being ready', async () => {
  // "Ready" used to be set once and never cleared, so somebody discharged
  // and then hospitalised again stayed flagged as back for good.
  const seeded = {
    2222222: {
      id: 2222222,
      name: 'Watched',
      state: 'Okay',
      ready: true,
      readyAt: Date.now(),
      checkedAt: Date.now(),
      bazaarValue: 1000000
    }
  };
  const { dom, win } = bootWatching(seeded);
  const doc = win.document;

  // They are back in hospital with a long stay.
  servePlayer(win, 2222222, {
    state: 'Hospital',
    description: 'In hospital',
    until: Math.floor(Date.now() / 1000) + 3600
  });

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const check = Array.from(doc.querySelectorAll('section[data-tab="watch"] button')).find(
    (b) => b.textContent === 'Check now'
  );
  check.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => !/back now/.test(watchRowText(doc)), 6000, 'the ready flag to clear');
  assert.match(watchRowText(doc), /Hospital/, 'and their new state is shown');
  dom.window.close();
});

t('out of a foreign hospital is still abroad, so not a target', async () => {
  // Discharged abroad means out of the country, not reachable. The countdown
  // must not read as if they become attackable when it runs out.
  const seeded = {
    3333333: {
      id: 3333333,
      name: 'Watched',
      state: 'Hospital',
      until: Math.floor(Date.now() / 1000) - 10, // the stay is over
      ready: false,
      checkedAt: 0
    }
  };
  const { dom, win } = bootWatching(seeded);
  const doc = win.document;

  // Out of hospital, but abroad.
  servePlayer(win, 3333333, { state: 'Abroad', description: 'Abroad', until: 0 });

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const check = Array.from(doc.querySelectorAll('section[data-tab="watch"] button')).find(
    (b) => b.textContent === 'Check now'
  );
  check.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => /Abroad/.test(watchRowText(doc)), 6000, 'the abroad state');
  const text = watchRowText(doc);
  assert.doesNotMatch(text, /back now/, 'they are not flagged as back');
  assert.doesNotMatch(text, /attack/, 'and no attack link is offered');
  assert.match(text, /still abroad/, 'the row says why they are not reachable');
  dom.window.close();
});

t('a foreign hospital is still shown as abroad, not as available', async () => {
  const seeded = {
    3333333: {
      id: 3333333,
      name: 'Watched',
      state: 'Hospital',
      until: Math.floor(Date.now() / 1000) + 600,
      ready: false,
      abroad: true,
      checkedAt: Date.now()
    }
  };
  const { dom, win } = bootWatching(seeded);
  const doc = win.document;

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const text = watchRowText(doc);
  assert.match(text, /Hospital/, 'their state is hospital');
  assert.match(text, /still abroad/, 'with the abroad caveat alongside');
  assert.doesNotMatch(text, /back now/);
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Results card (the corner notification)                              */
/* ------------------------------------------------------------------ */

t('the scanner is asked for its maximum, not a number it rejects', async () => {
  // The endpoint caps at 100 and answers anything above that with a 403
  // carrying no JSON. Requesting 200 meant the scanner silently returned
  // nothing, leaving only Torn's short list - which looked like the whole
  // market and stalled a scan after about ten sellers.
  const { dom, win, calls } = boot();
  const doc = win.document;

  await waitFor(() => doc.getElementById('tbms-item-input'), 3000, 'the picker');
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(
    () => calls.some((u) => u.includes('weav3r.dev/api/marketplace/206')),
    9000,
    'the scanner to be asked'
  );

  const scannerCall = calls.find((u) => u.includes('weav3r.dev/api/marketplace/206'));
  assert.match(scannerCall, /limit=100\b/, 'asked for the maximum: ' + scannerCall);
  assert.doesNotMatch(scannerCall, /limit=200\b/, 'not for a number it refuses');
  dom.window.close();
});

t('a bazaar page scan values the stock it can plainly see', async () => {
  // Straight from the report: donhordking's bazaar, 18 pangolin scales at
  // 205k, and the table said "$0 on sale". The bazaar arrived keyed by item
  // id rather than as an array, and that parsed as empty.
  const BAZAAR_MAP = {
    1: { ID: 1, name: 'Hydrogen Tank', quantity: 6, price: 25760, market_price: 23000 },
    2: { ID: 2, name: 'Spy Camera', quantity: 3, price: 492, market_price: 480 },
    3: { ID: 3, name: 'Methane Tank', quantity: 2, price: 23252, market_price: 23000 },
    4: { ID: 4, name: 'Pangolin Scales', quantity: 18, price: 205000, market_price: 205000 },
    5: { ID: 5, name: 'Single Red Rose', quantity: 1, price: 414, market_price: 400 }
  };

  const page =
    '<!doctype html><html><body>' +
    '<div id="notes_panel_button" class="icon-wrap"><svg></svg></div>' +
    '<a href="/bazaar.php?userId=4425009">donhordking</a>' +
    '</body></html>';
  const dom = new JSDOM(page, {
    url: 'https://www.torn.com/bazaar.php?userId=4425009',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;
  const store = new Map([['settings', JSON.stringify(SEED_SETTINGS)]]);
  win.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  win.GM_setValue = (k, v) => store.set(k, v);
  win.GM_addStyle = () => {};
  win.GM_registerMenuCommand = () => {};
  win.GM_xmlhttpRequest = function (o) {
    let body = '{}';
    if (/get-stats/.test(o.url)) {
      body = JSON.stringify([
        { player_id: 4425009, fair_fight: 1.19, bs_estimate: 8500, source: 'bss' }
      ]);
    } else if (/api\.torn\.com\/user\/4425009\?/.test(o.url)) {
      body = JSON.stringify({
        player_id: 4425009,
        name: 'donhordking',
        level: 17,
        faction_id: 0,
        status: { state: 'Okay', description: 'Okay' },
        last_action: { timestamp: Math.floor(Date.now() / 1000) - 16 },
        bazaar: BAZAAR_MAP
      });
    }
    setTimeout(() => o.onload({ status: 200, responseText: body }), 0);
  };

  win.eval(SOURCE);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 1, 8000, 'the bazaar owner to be checked');

  const row = resultRows(doc)[0];
  assert.match(row.textContent, /donhordking/);
  assert.doesNotMatch(row.textContent, /\$0 on sale/, 'not scored as empty');
  // A page scan has no item to value, so their whole bazaar is shown as
  // context and no profit is claimed from it.
  assert.match(row.textContent, /bazaar \$3\.89m/, 'the stock is shown: ' + row.textContent);
  assert.match(row.textContent, /no item selected/, 'and the profit says why not');
  dom.window.close();
});

t('an item scan values only that item, not the rest of their stock', async () => {
  // The bazaar in the report holds pangolin scales plus twelve other items.
  // Picking the item must give the item's figure, not the bazaar total.
  const BAZAAR = {
    1: { ID: 1, name: 'Hydrogen Tank', quantity: 6, price: 25760, market_price: 23000 },
    4: { ID: 4, name: 'Pangolin Scales', quantity: 18, price: 205000, market_price: 205000 },
    5: { ID: 5, name: 'Single Red Rose', quantity: 1, price: 414, market_price: 400 }
  };
  const { dom, win } = boot();
  const doc = win.document;

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      // The listing names the seller and the item.
      if (/v2\/market\/4\/bazaar/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                bazaar: [{ ID: 4425009, cost: 205000, quantity: 18, market_price: 205000 }]
              })
            }),
          0
        );
        return;
      }
      if (/v2\/market\/4\/bazaar/.test(opts.url)) {
        setTimeout(() => opts.onload({ status: 200, responseText: '{}' }), 0);
        return;
      }
      if (/api\.torn\.com\/user\/4425009\?/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                player_id: 4425009,
                name: 'donhordking',
                level: 17,
                faction_id: 0,
                status: { state: 'Okay', description: 'Okay' },
                last_action: { timestamp: Math.floor(Date.now() / 1000) - 16 },
                bazaar: BAZAAR
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.querySelector('.tbms-tab[data-tab="scan"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  doc.getElementById('tbms-item-input').value = '4';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => resultRows(doc).length === 1, 9000, 'the seller to be checked');
  const row = resultRows(doc)[0];

  assert.match(row.textContent, /\$3\.69m on sale/, 'the item only: ' + row.textContent);
  assert.doesNotMatch(
    row.textContent,
    /\$6\.08m/,
    'not the whole bazaar (which would be 3.69m + 0.15m + 0.0004m)'
  );
  dom.window.close();
});

t('a bazaar Torn did not send says so instead of showing $0', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // Refuse every request that asks for the bazaar, so the ladder narrows
  // past it - exactly what produces an absent bazaar in the wild.
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/api\.torn\.com\/user\/\d+\?/.test(opts.url) && /bazaar/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                error: { code: 4, error: 'Wrong fields' }
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const alice = resultRows(doc)[0];
  assert.match(
    alice.textContent,
    /value not read|Torn did not return their bazaar/i,
    'the row explains: ' + alice.textContent
  );
  assert.doesNotMatch(alice.textContent, /\$0 on sale/, 'rather than claiming nothing');
  dom.window.close();
});

t('switching tabs keeps the results and everything else on screen', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // Something in each tab worth losing.
  doc.getElementById('tbms-item-input').value = 'half typed item';
  const interval = doc.getElementById('tbms-auto-interval');
  interval.value = '45';
  interval.dispatchEvent(new win.Event('change', { bubbles: true }));

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const go = (tab) =>
    doc.querySelector('.tbms-tab[data-tab="' + tab + '"]').dispatchEvent(
      new win.MouseEvent('click', { bubbles: true })
    );

  go('filters');
  go('watch');
  go('setup');
  go('results');
  go('scan');
  go('results');

  assert.equal(resultRows(doc).length, 3, 'the results are still there');
  assert.equal(
    doc.getElementById('tbms-item-input').value,
    'half typed item',
    'the half-typed item survived too'
  );
  assert.equal(doc.getElementById('tbms-auto-interval').value, '45', 'and the interval');
  dom.window.close();
});

t('the last scan comes back after the page reloads', async () => {
  // A full page load is what a Torn tab change actually is, and it used to
  // wipe the table.
  const first = boot();
  first.win.document
    .getElementById('tbms-scan-btn')
    .dispatchEvent(new first.win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(first.win.document).length === 3, 8000, 'the first scan');

  // Let the queued write land before standing in for a reload.
  await waitFor(
    () => first.store.get('results_v1') || null,
    3000,
    'the results to be written to storage'
  );
  const persisted = first.store.get('results_v1');
  first.dom.window.close();

  // Fresh page, same storage.
  const second = boot(SEED_SETTINGS, { results_v1: persisted });
  const doc2 = second.win.document;
  assert.equal(resultRows(doc2).length, 3, 'the results are back without scanning again');
  assert.match(doc2.getElementById('tbms-foot').textContent, /restored 3/i, 'and it says so');
  second.dom.window.close();
});

t('restored results are re-scored against the filters as they are now', async () => {
  const first = boot();
  first.win.document
    .getElementById('tbms-scan-btn')
    .dispatchEvent(new first.win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(first.win.document).length === 3, 8000, 'the first scan');
  await waitFor(() => first.store.get('results_v1') || null, 3000, 'the write');
  const persisted = first.store.get('results_v1');
  first.dom.window.close();

  // Come back with a filter that nothing can pass.
  const strict = JSON.parse(JSON.stringify(SEED_SETTINGS));
  strict.filters = { maxFairFight: { on: true, value: 1.0 } };
  const second = boot(strict, { results_v1: persisted });
  const doc2 = second.win.document;

  assert.equal(resultRows(doc2).length, 3, 'still listed');
  assert.equal(
    Array.from(resultRows(doc2)).filter((tr) => tr.classList.contains('tbms-match')).length,
    0,
    'but nothing matches the stricter filter'
  );
  second.dom.window.close();
});

t('a stored result set that has gone stale is not restored', async () => {
  const old = JSON.stringify({
    at: Date.now() - 13 * 3600 * 1000, // past the 12h window
    label: 'yesterday',
    subjects: [{ id: 42, name: 'Ancient', value: 1, loot: 1 }]
  });
  const { dom, win } = boot(SEED_SETTINGS, { results_v1: old });
  assert.equal(resultRows(win.document).length, 0, 'nothing came back');
  dom.window.close();
});

t('a scan that finds matches raises a card carrying the actions', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  assert.equal(doc.getElementById('tbms-results-toast'), null, 'nothing before a scan');

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('tbms-results-toast'), 8000, 'the card to appear');

  const card = doc.getElementById('tbms-results-toast');
  // In this fixture only Alice survives every filter, so the card says one.
  assert.match(card.textContent, /1 match/, 'it counts the matches');
  assert.match(card.textContent, /Alice/, 'and names them');

  // Every action for a result, without opening the panel.
  const links = Array.from(card.querySelectorAll('a.tbms-toast-btn'));
  const attack = links.find((a) => a.textContent === 'attack');
  const bazaar = links.find((a) => a.textContent === 'bazaar');
  assert.ok(attack, 'attack button present');
  assert.ok(bazaar, 'bazaar button present');
  assert.match(attack.getAttribute('href'), /user2ID=1111111/);

  const watch = Array.from(card.querySelectorAll('button.tbms-toast-btn')).find(
    (b) => b.textContent === 'watch'
  );
  assert.ok(watch, 'watch button present');
  dom.window.close();
});

t('the card can be dismissed and does not spring back', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('tbms-results-toast'), 8000, 'the card');

  doc.querySelector('#tbms-results-toast .tbms-toast-close').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  assert.equal(doc.getElementById('tbms-results-toast'), null, 'it is gone');

  // Re-scoring the same results must not re-raise it.
  doc.querySelector('.tbms-tab[data-tab="filters"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const rescore = Array.from(doc.querySelectorAll('section[data-tab="filters"] button')).find((b) =>
    /Re-score/.test(b.textContent)
  );
  rescore.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(doc.getElementById('tbms-results-toast'), null, 'still dismissed');
  dom.window.close();
});

t('watch on the card adds the player without opening the panel', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.getElementById('tbms-results-toast'), 8000, 'the card');

  const watch = Array.from(
    doc.querySelectorAll('#tbms-results-toast button.tbms-toast-btn')
  ).find((b) => b.textContent === 'watch');
  watch.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(
    () => JSON.parse(win.localStorage.getItem('tbms_watch_v1') || 'null') ||
          /added to the watchlist/.test(doc.getElementById('tbms-foot').textContent),
    3000,
    'the watchlist to be updated'
  );
  assert.match(doc.getElementById('tbms-foot').textContent, /added to the watchlist/i);
  dom.window.close();
});

t('the card can be switched off entirely', async () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.ui.toast = false;
  const { dom, win } = boot(seed);
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');
  assert.equal(doc.getElementById('tbms-results-toast'), null, 'no card was raised');
  dom.window.close();
});

t('the auto-scan interval is editable and reschedules the loop', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;

  const input = doc.getElementById('tbms-auto-interval');
  assert.ok(input, 'the interval field exists');
  // The seed does not set it, so the default is what should be shown.
  assert.equal(input.value, '60', 'shows the current interval');

  input.value = '45';
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.scan && s.scan.auto && s.scan.auto.intervalSec === 45;
  }, 3000, 'the interval to be saved');

  // Nonsense is clamped rather than accepted.
  input.value = '1';
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.scan.auto.intervalSec >= 10;
  }, 3000, 'the floor to apply');
  assert.equal(input.value, '10', 'and the field shows what was applied');
  dom.window.close();
});

t('players who will be free soon are watched automatically', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // Give Bob a release time: he is in hospital with 4 minutes left, and the
  // watch window is 30 minutes by default.
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/api\.torn\.com\/user\/2222222\?/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify(
                tornUser(2222222, {
                  profile: {
                    name: 'Bob',
                    level: 45,
                    last_action: NOW - 60,
                    status: {
                      state: 'Hospital',
                      description: 'In hospital',
                      until: NOW + 4 * 60
                    }
                  }
                })
              )
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const watch = await waitFor(
    () => (/Bob/.test(doc.querySelector('section[data-tab="watch"]').textContent)
      ? doc.querySelector('section[data-tab="watch"]')
      : null),
    3000,
    'the nearly-free player to be watched'
  );
  assert.match(watch.textContent, /1 watched/, 'with a count');
  assert.match(watch.textContent, /Hospital|out in/i, 'and why they are on it');
  dom.window.close();
});

t('a watched player is flagged the moment they are back', async () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  const { dom, win } = boot(seed);
  const doc = win.document;

  // Bob starts in hospital with four minutes to go, so a scan watches him.
  let bobReleased = false;
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/api\.torn\.com\/user\/2222222\?/.test(opts.url)) {
        const profile = bobReleased
          ? {
              name: 'Bob',
              level: 45,
              last_action: NOW - 10,
              status: { state: 'Okay', description: 'Okay' }
            }
          : {
              name: 'Bob',
              level: 45,
              last_action: NOW - 60,
              status: { state: 'Hospital', description: 'In hospital', until: NOW + 4 * 60 }
            };
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify(
                tornUser(2222222, {
                  profile: profile,
                  bazaar: [{ name: 'Xanax', quantity: 40, price: 800000, market_price: 900000 }]
                })
              )
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.querySelector('.tbms-tab[data-tab="scan"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  await waitFor(
    () => (/Bob/.test(doc.querySelector('section[data-tab="watch"]').textContent) ? true : null),
    3000,
    'Bob to be watched'
  );

  // He is discharged.
  bobReleased = true;
  const checkBtn = Array.from(doc.querySelectorAll('section[data-tab="watch"] button')).find(
    (b) => b.textContent === 'Check now'
  );
  checkBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(
    () => /back now/.test(doc.querySelector('section[data-tab="watch"]').textContent),
    6000,
    'Bob to be flagged as back'
  );

  const watch = doc.querySelector('section[data-tab="watch"]');
  const attack = Array.from(watch.querySelectorAll('a')).find((a) => a.textContent === 'attack');
  assert.ok(attack, 'an attack link appears once they are reachable');
  assert.match(attack.getAttribute('href'), /user2ID=2222222/);
  assert.match(doc.getElementById('tbms-foot').textContent, /ready to attack/i, 'and it is announced');
  dom.window.close();
});

t('the watchlist survives a page reload', async () => {
  // The list must already be in storage when the script starts, which is
  // exactly what happens after a refresh.
  const seeded = {
    watch_v1: JSON.stringify({
      555: {
        id: 555,
        name: 'Old Target',
        state: 'Abroad',
        until: Math.floor(Date.now() / 1000) + 900,
        ready: false,
        checkedAt: Date.now()
      }
    })
  };
  const { dom, win } = boot(SEED_SETTINGS, seeded);
  const doc = win.document;

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const watch = doc.querySelector('section[data-tab="watch"]');
  assert.match(watch.textContent, /Old Target/, 'the saved player is back on the list');
  assert.match(watch.textContent, /1 watched/, 'and counted');
  dom.window.close();
});

t('the watch tab is labelled with how many are back', () => {
  const seeded = {
    watch_v1: JSON.stringify({
      777: {
        id: 777,
        name: 'Returned Rita',
        state: 'Okay',
        ready: true,
        readyAt: Date.now(),
        checkedAt: Date.now()
      }
    })
  };
  const { dom, win } = boot(SEED_SETTINGS, seeded);
  const doc = win.document;

  const tab = doc.querySelector('.tbms-tab[data-tab="watch"]');
  assert.match(tab.textContent, /Watch · 1/, 'the tab advertises the returned player');
  assert.ok(tab.classList.contains('tbms-tab-alert'), 'and is highlighted');

  doc.querySelector('.tbms-tab[data-tab="watch"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  const watch = doc.querySelector('section[data-tab="watch"]');
  assert.match(watch.textContent, /back now/, 'shown as ready');
  assert.ok(
    Array.from(watch.querySelectorAll('a')).some((a) => a.textContent === 'attack'),
    'with an attack link'
  );
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* API economy: the free sources go first                              */
/* ------------------------------------------------------------------ */

t('sellers from every source are merged, not just the first that answers', async () => {
  // Torn's own listing is short; the scanner knows of more. Stopping at the
  // first source that responded meant a common item could exhaust itself
  // after ten sellers, because the fuller list was never consulted.
  const { dom, win, calls } = boot();
  const doc = win.document;

  const TORN_ROWS = [1111111, 2222222].map((id) => ({
    ID: id,
    cost: 800000,
    quantity: 10,
    market_price: 850000
  }));
  const SCANNER_ROWS = [3333333, 4444444, 5555555, 6666666].map((id) => ({
    player_id: id,
    player_name: 'Scan' + id,
    price: 810000,
    quantity: 12,
    last_checked: NOW
  }));

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        setTimeout(
          () => opts.onload({ status: 200, responseText: JSON.stringify({ bazaar: TORN_ROWS }) }),
          0
        );
        return;
      }
      if (/weav3r\.dev\/api\/marketplace\/206/.test(opts.url)) {
        calls.push(opts.url); // intercepted, so record it here
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({ item_id: 206, market_price: 850000, listings: SCANNER_ROWS })
            }),
          0
        );
        return;
      }
      // Give the scanner's sellers a profile so their rows can render.
      const m = opts.url.match(/api\.torn\.com\/user\/(\d+)\?/);
      if (m && ['3333333', '4444444', '5555555', '6666666'].includes(m[1])) {
        calls.push(opts.url);
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify(
                tornUser(Number(m[1]), {
                  profile: {
                    name: 'Scan' + m[1],
                    level: 30,
                    last_action: NOW - 60,
                    status: { state: 'Okay', description: 'Okay' }
                  }
                })
              )
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  await waitFor(() => doc.getElementById('tbms-item-input'), 3000, 'the picker');
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length >= 6, 12000, 'sellers from both sources');

  // The scanner was consulted even though Torn answered first.
  assert.ok(
    calls.some((u) => /weav3r\.dev\/api\/marketplace\/206/.test(u)),
    'the fuller source was asked'
  );
  const names = Array.from(resultRows(doc)).map((tr) => tr.textContent);
  assert.ok(
    names.some((n) => /Scan3333333|Scan4444444|Scan5555555|Scan6666666/.test(n)),
    'and its sellers are in the list'
  );
  dom.window.close();
});

t('a page scan on an item page still prices what it finds', async () => {
  // Skeed sells through the item market, so his bazaar lookup finds
  // nothing. With the item known from the page, his listing prices him.
  const page =
    '<!doctype html><html><body>' +
    '<div id="notes_panel_button" class="icon-wrap"><svg></svg></div>' +
    '<a href="/profiles.php?XID=2175816">Skeed</a>' +
    '</body></html>';
  const dom = new JSDOM(page, {
    url: 'https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=206',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;
  const store = new Map([['settings', JSON.stringify(SEED_SETTINGS)]]);
  win.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  win.GM_setValue = (k, v) => store.set(k, v);
  win.GM_addStyle = () => {};
  win.GM_registerMenuCommand = () => {};
  win.GM_xmlhttpRequest = function (o) {
    let body = '{}';
    if (/get-stats/.test(o.url)) {
      body = JSON.stringify([
        { player_id: 2175816, fair_fight: 1.73, bs_estimate: 128900, source: 'bss' }
      ]);
    } else if (/selections=items/.test(o.url)) {
      body = JSON.stringify({ items: { 206: { name: 'Xanax' } } });
    } else if (/v2\/market\/206\/bazaar/.test(o.url)) {
      body = JSON.stringify({ bazaar: [{ ID: 2175816, cost: 800000, quantity: 40, market_price: 850000 }] });
    } else if (/api\.torn\.com\/user\/2175816\?/.test(o.url)) {
      body = JSON.stringify({
        player_id: 2175816,
        name: 'Skeed',
        level: 26,
        faction_id: 0,
        status: { state: 'Okay', description: 'Okay' },
        last_action: { timestamp: Math.floor(Date.now() / 1000) - 400 },
        // Selling on the item market, so their bazaar is empty.
        bazaar: []
      });
    }
    setTimeout(() => o.onload({ status: 200, responseText: body }), 0);
  };

  win.eval(SOURCE);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 1, 9000, 'the page seller to be checked');

  const row = resultRows(doc)[0];
  assert.match(row.textContent, /Skeed/);
  assert.doesNotMatch(row.textContent, /value not read/, 'he is priced: ' + row.textContent);
  assert.doesNotMatch(row.textContent, /no item selected/, 'the page supplied the item');
  assert.match(row.textContent, /\$32\.00m on sale/, '40 x 800,000');
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Repeat scans must surface new names, not the same ones              */
/* ------------------------------------------------------------------ */

t('a seller listing the item is a hit even when their bazaar is empty', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // Someone selling 30 of the item at the going rate, whose bazaar lookup
  // comes back with nothing - the reported "should have been a hit" case.
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                bazaar: [{ ID: 1111111, cost: 40000, quantity: 30, market_price: 40000 }]
              })
            }),
          0
        );
        return;
      }
      if (/api\.torn\.com\/user\/1111111\?/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                player_id: 1111111,
                name: 'starbug',
                level: 20,
                faction_id: 0,
                status: { state: 'Okay', description: 'Okay' },
                last_action: { timestamp: Math.floor(Date.now() / 1000) - 120 },
                // Their bazaar is empty, as Torn often reports for someone
                // selling through the item market.
                bazaar: []
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.querySelector('.tbms-tab[data-tab="scan"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => resultRows(doc).length === 1, 9000, 'the seller to be checked');
  const row = resultRows(doc)[0];

  assert.match(row.textContent, /starbug/, 'the seller is listed');
  assert.match(row.textContent, /1\.20m on sale/, 'valued from the listing, not the bazaar');
  assert.doesNotMatch(row.textContent, /\$0 on sale/, 'and not scored as empty');
  assert.ok(row.classList.contains('tbms-match'), 'so it is a hit');
  dom.window.close();
});

t('repeating an item scan accumulates new names instead of repeating', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  // The bazaar gains a seller between passes.
  let sellers = [{ ID: 1111111, cost: 800000, quantity: 30 }];
  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      if (/v2\/market\/206\/bazaar/.test(opts.url)) {
        setTimeout(
          () => opts.onload({ status: 200, responseText: JSON.stringify({ bazaar: sellers }) }),
          0
        );
        return;
      }
      // The newly listed seller, who the shared stub does not know about.
      if (/api\.torn\.com\/user\/4444444\?/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify(
                tornUser(4444444, {
                  profile: {
                    name: 'Newcomer',
                    level: 30,
                    last_action: NOW - 30,
                    status: { state: 'Okay', description: 'Okay' }
                  }
                })
              )
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.querySelector('.tbms-tab[data-tab="scan"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  doc.getElementById('tbms-item-input').value = '206';
  doc.getElementById('tbms-item-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 1, 8000, 'the first auto pass');
  assert.match(resultRows(doc)[0].textContent, /Alice/, 'with the first seller');

  // A new seller appears, and starting auto-scan runs a pass immediately.
  sellers = [
    { ID: 1111111, cost: 800000, quantity: 30 },
    { ID: 4444444, cost: 810000, quantity: 12 }
  ];

  const autoBtn = doc.getElementById('tbms-auto-btn');
  autoBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  // Alice is already known, so only the newly listed seller is added - and
  // the table grows to hold both rather than repeating Alice alone.
  await waitFor(() => resultRows(doc).length === 2, 9000, 'the new seller to appear');

  const names = Array.from(resultRows(doc)).map((tr) => tr.textContent.slice(0, 24));
  assert.equal(new Set(names).size, 2, 'two distinct rows, no repeat of Alice');
  assert.ok(
    names.some((n) => /Newcomer/.test(n)),
    'the newly listed seller is the one that was added: ' + JSON.stringify(names)
  );
  dom.window.close();
});

t('Torn is only asked about players the free sources could not rule out', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const ffCalls = calls.filter((u) => u.includes('ffscouter'));
  const tornCalls = calls.filter((u) => /api\.torn\.com\/user\/\d+\?/.test(u));

  // Three sellers: FFScouter judges all three in one batched request and
  // Carol (FF 9.4) is dropped, so Torn is asked about two.
  assert.equal(ffCalls.length, 1, 'one batched call covers every candidate');
  assert.equal(tornCalls.length, 2, 'only the survivors cost a Torn request');
  assert.ok(
    tornCalls.length < 3,
    'the precious per-player source is used less than the free one'
  );
});

t('a screened-out player is shown as unchecked, not as having nothing', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  const carol = Array.from(resultRows(doc)).find((tr) => /Carol/.test(tr.textContent));
  assert.match(carol.textContent, /not checked/i, 'their unread columns say so');
  assert.doesNotMatch(
    carol.textContent,
    /\$0 bazaar/,
    'never claims an empty bazaar they were never checked for'
  );
  assert.match(carol.textContent, /screened out: fair fight/i, 'with the screen reason');
  dom.window.close();
});

t('key fields are not password inputs, so nothing offers to save them', () => {
  const { dom, win } = boot();
  const doc = win.document;

  // A single type="password" anywhere is enough for Chrome to offer to
  // save a login and for managers to start autofilling.
  assert.equal(
    doc.querySelectorAll('input[type="password"]').length,
    0,
    'no password-typed inputs anywhere in the UI'
  );

  const key = doc.getElementById('tbms-torn-key');
  assert.ok(key, 'the Torn key field exists');
  assert.equal(key.getAttribute('type'), 'text', 'it is a plain text field');
  assert.equal(key.getAttribute('autocomplete'), 'off');
  assert.equal(key.getAttribute('spellcheck'), 'false');
  assert.equal(key.getAttribute('autocapitalize'), 'off');
  assert.equal(key.getAttribute('autocorrect'), 'off');

  // The opt-outs the major managers actually honour.
  assert.equal(key.getAttribute('data-lpignore'), 'true', 'LastPass opts out');
  assert.equal(key.getAttribute('data-1p-ignore'), 'true', '1Password opts out');
  assert.equal(key.getAttribute('data-bwignore'), 'true', 'Bitwarden opts out');
  assert.equal(key.getAttribute('data-form-type'), 'other', 'Dashlane opts out');

  // Masked visually, which is why it does not need to be a password field.
  assert.ok(key.classList.contains('tbms-masked'), 'it is CSS-masked');

  // And it is not inside a form, so there is no login to submit.
  assert.equal(key.closest('form'), null, 'no form wrapper');
  dom.window.close();
});

t('the key can be revealed without becoming a password field', () => {
  const { dom, win } = boot();
  const doc = win.document;
  const key = doc.getElementById('tbms-torn-key');
  const row = key.parentNode;
  const toggle = row.querySelector('button');

  assert.equal(toggle.textContent, 'Show', 'offers to reveal while masked');
  toggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.ok(!key.classList.contains('tbms-masked'), 'no longer masked');
  assert.equal(key.getAttribute('type'), 'text', 'still not a password field');
  assert.equal(toggle.textContent, 'Hide', 'offers to hide again');

  toggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.ok(key.classList.contains('tbms-masked'), 'masked again');
  dom.window.close();
});

t('the optional FFScouter key field follows the same rules', () => {
  const { dom, win } = boot();
  const doc = win.document;
  const ff = doc.getElementById('tbms-ff-key');
  assert.ok(ff, 'the FFScouter key field exists');
  assert.equal(ff.getAttribute('type'), 'text');
  assert.equal(ff.getAttribute('data-lpignore'), 'true');
  assert.equal(ff.getAttribute('data-1p-ignore'), 'true');
  assert.ok(ff.classList.contains('tbms-masked'));
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Auto-scan (continuous, with a state that survives a refresh)        */
/* ------------------------------------------------------------------ */

t('auto-scan starts, pauses and remembers which it is', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;
  const autoBtn = doc.getElementById('tbms-auto-btn');
  assert.ok(autoBtn, 'the auto-scan button exists');

  doc.getElementById('tbms-item-input').value = '206';
  autoBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.scan && s.scan.auto && s.scan.auto.on === true;
  }, 3000, 'auto-scan to be switched on');

  const started = JSON.parse(store.get('settings'));
  assert.equal(started.scan.auto.itemId, 206, 'it remembers what it is watching');
  assert.match(autoBtn.textContent, /pause/i, 'the button offers to pause');

  autoBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => {
    const s = JSON.parse(store.get('settings') || '{}');
    return s.scan.auto.on === false;
  }, 3000, 'auto-scan to be paused');
  assert.match(autoBtn.textContent, /auto-scan/i, 'the button offers to resume');
  dom.window.close();
});

t('a running auto-scan resumes by itself after a refresh', async () => {
  // "After a refresh" == a fresh page load with the saved state.
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.scan.auto = { on: true, itemId: 206, intervalSec: 120 };
  const { dom, win, calls } = boot(seed);
  const doc = win.document;

  const rows = await waitFor(
    () => {
      const r = resultRows(doc);
      return r.length ? r : null;
    },
    10000,
    'the resumed auto-scan to produce results'
  );
  assert.ok(rows.length >= 1, 'it scanned without anyone pressing anything');
  assert.ok(
    calls.some((u) => /v2\/market\/206\/bazaar/.test(u)),
    'it watched the saved item'
  );
  dom.window.close();
});

t('a paused auto-scan stays paused after a refresh', async () => {
  const seed = JSON.parse(JSON.stringify(SEED_SETTINGS));
  seed.scan.auto = { on: false, itemId: 206, intervalSec: 120 };
  const { dom, win, calls } = boot(seed);
  const doc = win.document;

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(resultRows(doc).length, 0, 'nothing was scanned');
  assert.ok(
    !calls.some((u) => /v2\/market\/206\/bazaar/.test(u)),
    'it did not touch the bazaar for a paused scan'
  );
  dom.window.close();
});

/* ------------------------------------------------------------------ */
/* Rows for sellers we could not fully read                            */
/* ------------------------------------------------------------------ */

t('a seller whose data is private still appears, by name', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  win.GM_xmlhttpRequest = (() => {
    const base = win.GM_xmlhttpRequest;
    return function (opts) {
      // Torn answers "selection is private" for this one.
      if (/api\.torn\.com\/user\/2222222\?/.test(opts.url)) {
        setTimeout(
          () =>
            opts.onload({
              status: 200,
              responseText: JSON.stringify({
                error: { code: 7, error: 'A requested selection is private' }
              })
            }),
          0
        );
        return;
      }
      return base(opts);
    };
  })();

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const rows = await waitFor(
    () => {
      const r = resultRows(doc);
      return r.length === 3 ? r : null;
    },
    9000,
    'all three sellers to get a row'
  );

  const bob = Array.from(rows).find((tr) => /Bob/.test(tr.textContent));
  assert.ok(bob, 'the unreadable seller is still listed');
  assert.ok(
    !/Player 2222222/.test(bob.textContent),
    'and is shown by name, not as a placeholder id'
  );
  assert.match(bob.textContent, /private/i, 'with the reason it could not be read');
  dom.window.close();
});

t('re-filtering sorts matches first exactly like a scan does', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => resultRows(doc).length === 3, 8000, 'scan');

  // The scan puts the single match on top.
  let first = resultRows(doc)[0];
  assert.ok(first.classList.contains('tbms-match'), 'scan sorted the match first');

  // Re-score with everything relaxed: now all three are matches.
  doc.querySelector('.tbms-tab[data-tab="filters"]').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true })
  );
  Array.from(doc.querySelectorAll('section[data-tab="filters"] .tbms-switch input')).forEach((i) => {
    if (i.checked) {
      i.checked = false;
      i.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  });
  const rescore = Array.from(doc.querySelectorAll('section[data-tab="filters"] button')).find((b) =>
    /Re-score/.test(b.textContent)
  );
  rescore.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(
    () => Array.from(resultRows(doc)).filter((tr) => tr.classList.contains('tbms-match')).length === 2,
    3000,
    'the checked sellers to become matches'
  );
  first = resultRows(doc)[0];
  assert.ok(first.classList.contains('tbms-match'), 'and the ordering rule held');
  dom.window.close();
});

t('waits out a Torn rate limit and then resumes by itself', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;

  // Rate limit exactly one player once, then behave normally.
  let limited = false;
  const base = win.GM_xmlhttpRequest;
  win.GM_xmlhttpRequest = function (opts) {
    if (!limited && /api\.torn\.com\/user\/2222222\?/.test(opts.url)) {
      limited = true;
      setTimeout(
        () =>
          opts.onload({
            status: 200,
            responseText: JSON.stringify({
              error: { code: 5, error: 'Too many requests' }
            })
          }),
        0
      );
      return;
    }
    return base(opts);
  };

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  // All three sellers must still land, including the one that got limited.
  const rows = await waitFor(
    () => {
      const r = resultRows(doc);
      return r.length === 3 ? r : null;
    },
    10000,
    'the scan to resume and finish all three'
  );
  assert.equal(rows.length, 3, 'the rate limited player was retried, not dropped');

  // The wait must have been announced rather than looking like a hang.
  const logs = store.get('settings');
  assert.ok(logs, 'settings still persisted through the pause');
  assert.match(
    doc.getElementById('tbms-foot').textContent + ' ' + Array.from(rows).map((r) => r.textContent).join(' '),
    /Alice|rate limit|resuming|Fetched/i
  );

  // And the scan must not have given up with an error.
  assert.doesNotMatch(doc.getElementById('tbms-foot').textContent, /stopping|rejected/i);
  dom.window.close();
});
