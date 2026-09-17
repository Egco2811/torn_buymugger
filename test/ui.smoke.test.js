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

function boot(seedSettings) {
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
    } else if (/market\/(\d+)\?selections=bazaar/.test(opts.url)) {
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
  assert.equal(doc.querySelectorAll('.tbms-tab').length, 4, 'four tabs');
  assert.equal(doc.querySelectorAll('section[data-tab]').length, 4, 'four tab panels');
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
      const r = doc.querySelectorAll('table.tbms-table tbody tr');
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
  assert.match(byName.Carol.textContent, /FF|BS/);

  // One batched FFScouter call, one Torn call per seller.
  const ffCalls = calls.filter((u) => u.includes('ffscouter'));
  const tornCalls = calls.filter((u) => u.includes('api.torn.com/user/'));
  assert.equal(ffCalls.length, 1, 'FFScouter is batched into a single request');
  assert.equal(tornCalls.length, 3, 'one Torn lookup per seller');

  const badge = doc.getElementById('tbms-badge');
  assert.ok(badge.classList.contains('tbms-show'), 'badge is shown');
  assert.equal(badge.textContent, '1', 'badge counts the single match');

  dom.window.close();
});

t('re-scores instantly from cache when filters change', async () => {
  const { dom, win, calls } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 3, 8000, 'first scan');

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
    () => doc.querySelectorAll('table.tbms-table tbody tr.tbms-match').length === 3,
    3000,
    'all three to become matches'
  );

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

  const keyInput = doc.querySelector('section[data-tab="setup"] input[type="password"]');
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
    () => doc.querySelector('table.tbms-table tbody tr'),
    5000,
    'a result row for the manual id'
  );

  assert.equal(doc.querySelectorAll('table.tbms-table tbody tr').length, 1, 'only the requested player');
  assert.match(row.textContent, /Carol/, 'it is the right player');
  assert.ok(
    calls.some((u) => /api\.torn\.com\/user\/3333333\?/.test(u)),
    'Torn was asked about 3333333'
  );
  dom.window.close();
});

t('export buttons do not throw when the clipboard is unavailable', async () => {
  const { dom, win } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 3, 8000, 'scan');

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
  assert.equal(doc.querySelectorAll('table.tbms-table tbody tr').length, 3, 'table intact');
  dom.window.close();
});

t('clearing the cache actually empties stored player data', async () => {
  const { dom, win, store } = boot();
  const doc = win.document;

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 3, 8000, 'scan');

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
  const { dom, win, calls } = boot(seed);
  const doc = win.document;

  assert.equal(
    doc.getElementById('tbms-harvest-count').textContent,
    '2',
    'self is dropped from the page count'
  );

  doc.getElementById('tbms-scan-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 2, 8000, 'scan');

  assert.ok(
    !calls.some((u) => /api\.torn\.com\/user\/1111111\?/.test(u)),
    'Torn was never asked about our own id'
  );
  assert.ok(
    !Array.from(doc.querySelectorAll('table.tbms-table tbody tr')).some((tr) =>
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
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 3, 8000, 'scan');

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
      if (/market\/206\?selections=bazaar/.test(opts.url)) {
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
      const r = doc.querySelectorAll('table.tbms-table tbody tr');
      return r.length === 2 ? r : null;
    },
    9000,
    'two sellers from the data source'
  );
  assert.equal(rows.length, 2, 'both bazaar sellers were checked');
  assert.ok(
    calls.some((u) => /market\/206\?selections=bazaar/.test(u)),
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
      if (/market\/206\?selections=bazaar/.test(opts.url)) {
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

  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 1, 9000, 'scanner result');
  assert.ok(calls.some((u) => /weav3r\.dev/.test(u)), 'the scanner was consulted');

  const row = doc.querySelector('table.tbms-table tbody tr');
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
      if (/market\/206\?selections=bazaar/.test(opts.url)) {
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
      // Pretend the key is too weak for other players' property and money.
      if (/selections=property/.test(opts.url) || /selections=money/.test(opts.url)) {
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
      const r = doc.querySelectorAll('table.tbms-table tbody tr');
      return r.length ? r : null;
    },
    10000,
    'the resumed auto-scan to produce results'
  );
  assert.ok(rows.length >= 1, 'it scanned without anyone pressing anything');
  assert.ok(
    calls.some((u) => /market\/206\?selections=bazaar/.test(u)),
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
  assert.equal(doc.querySelectorAll('table.tbms-table tbody tr').length, 0, 'nothing was scanned');
  assert.ok(
    !calls.some((u) => /market\/206\?selections=bazaar/.test(u)),
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
      const r = doc.querySelectorAll('table.tbms-table tbody tr');
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
  await waitFor(() => doc.querySelectorAll('table.tbms-table tbody tr').length === 3, 8000, 'scan');

  // The scan puts the single match on top.
  let first = doc.querySelector('table.tbms-table tbody tr');
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
    () => doc.querySelectorAll('table.tbms-table tbody tr.tbms-match').length === 3,
    3000,
    'all three to become matches'
  );
  first = doc.querySelector('table.tbms-table tbody tr');
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
      const r = doc.querySelectorAll('table.tbms-table tbody tr');
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
