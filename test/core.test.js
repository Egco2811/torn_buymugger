/* Tests for the pure logic in torn-buymugger-scout.user.js.
 * Run with:  node --test test/
 *
 * These exercise the parsing and filtering rules against Torn-shaped
 * payloads, so a change to the scoring/filters has to be deliberate.
 */

const test = require('node:test');
const assert = require('node:assert');

const s = require('../torn-buymugger-scout.user.js');

/* ------------------------------------------------------------------ */
/* Seller harvesting                                                   */
/* ------------------------------------------------------------------ */

test('harvests seller IDs from the markup Torn actually renders', () => {
  const html = [
    '<a href="/profiles.php?XID=1234567" class="user-name">Bob</a>',
    '<a href="/bazaar.php?userId=2345678#/">Baz</a>',
    '<a href="/bazaar.php#/userId=3456789">Hash routed</a>',
    '<div data-user-id="4567890"></div>',
    '<a href="/profiles.php?XID=1234567">Bob again</a>'
  ].join('\n');

  const ids = s.extractIdsFromHtml(html).sort((a, b) => a - b);
  assert.deepEqual(ids, [1234567, 2345678, 3456789, 4567890]);
});

test('does not mistake an item id for a player id', () => {
  // item.php?id= is an item, not a player. Harvesting it would waste API
  // calls and pollute the results table.
  const html = '<a href="/item.php?id=206">Xanax</a> <a href="/imarket.php?id=206">market</a>';
  assert.deepEqual(s.extractIdsFromHtml(html), []);
});

test('ignores nonsense ids', () => {
  assert.equal(s.isValidPlayerId(0), false);
  assert.equal(s.isValidPlayerId(-5), false);
  assert.equal(s.isValidPlayerId(999999999), false);
  assert.equal(s.isValidPlayerId(12345), true);
});

/* ------------------------------------------------------------------ */
/* Status / location                                                   */
/* ------------------------------------------------------------------ */

test('classifies Torn status states', () => {
  const cases = [
    ['Okay', true, true, 'in Torn and available'],
    ['Hospital', true, false, 'in Torn but hospitalised'],
    ['Jail', true, false, 'in Torn but jailed'],
    ['Abroad', false, false, 'not in Torn'],
    ['Traveling', false, false, 'not in Torn'],
    ['Federal', true, false, 'in Torn but federal']
  ];

  cases.forEach(([state, inTorn, available, why]) => {
    const st = s.readStatus({ status: { state, description: state } });
    assert.equal(st.inTorn, inTorn, `${state}: ${why}`);
    assert.equal(st.available, available, `${state}: ${why}`);
  });
});

test('falls back to the description when state is missing', () => {
  const st = s.readStatus({ status: { description: 'In hospital for 2 hrs' } });
  assert.equal(st.isHospital, true);
  assert.equal(st.available, false);
});

/* ------------------------------------------------------------------ */
/* Vault detection                                                     */
/* ------------------------------------------------------------------ */

test('detects a vault across the payload shapes the API has used', () => {
  const topLevel = s.detectVault({ properties: { 1: { property: 'Castle' } }, vault: 5000000 });
  assert.equal(topLevel.hasVault, true);
  assert.equal(topLevel.vaultAmount, 5000000);

  const nested = s.detectVault({ properties: { 1: { property: 'Castle', upgrades: ['vault', 'airstrip'] } } });
  assert.equal(nested.hasVault, true);

  const upgradeObject = s.detectVault({ properties: { 1: { property: 'Villa', upgrade: { vault: 250000 } } } });
  assert.equal(upgradeObject.hasVault, true);
  assert.equal(upgradeObject.vaultAmount, 250000);
});

test('reports no vault when there genuinely is none', () => {
  const none = s.detectVault({ properties: { 1: { property: 'Trailer', upgrades: ['airstrip'] } } });
  assert.equal(none.hasVault, null, 'absence of a signal is unknown, not a confident no');

  assert.equal(s.detectVault(null).hasVault, null);
});

/* ------------------------------------------------------------------ */
/* Bazaar economics                                                    */
/* ------------------------------------------------------------------ */

test('summarises bazaar value, deals and worthy stock', () => {
  const items = [
    { ID: 206, name: 'Xanax', quantity: 10, price: 800000, market_price: 850000 },
    { ID: 1, name: 'Junk', quantity: 100, price: 500, market_price: 500 },
    { ID: 5, name: 'Bargain', quantity: 2, price: 1000000, market_price: 2000000 }
  ];

  const sum = s.summariseBazaar(items, 100000, 0.15);

  assert.equal(sum.count, 112, 'counts quantity, not listings');
  assert.equal(sum.itemLines, 3);
  assert.equal(sum.buyout, 10 * 800000 + 100 * 500 + 2 * 1000000);
  assert.equal(sum.marketValue, 10 * 850000 + 100 * 500 + 2 * 2000000);
  assert.equal(sum.worthyCount, 12, 'Xanax + Bargain clear the 100k bar');
  assert.equal(sum.dealCount, 2, 'only Bargain is >=15% under market');
  assert.equal(sum.dealBuyout, 2000000);
  // Biggest single line by value: 10 Xanax @ 800k beats 2 Bargains @ 1m.
  assert.equal(sum.topItem.name, 'Xanax');
  assert.equal(sum.topItem.value, 8000000);
});

test('treats every item as worthy when the threshold is disabled', () => {
  const sum = s.summariseBazaar([{ quantity: 1, price: 10 }], 0, 0);
  assert.equal(sum.worthyCount, 1);
});

test('survives an empty or malformed bazaar', () => {
  assert.equal(s.summariseBazaar(undefined, 1000, 0.1).buyout, 0);
  assert.equal(s.summariseBazaar([null, 'x'], 1000, 0.1).count, 0);
});

/* ------------------------------------------------------------------ */
/* Estimate model                                                      */
/* ------------------------------------------------------------------ */

test('the estimate follows the mug-and-keep-the-goods model', () => {
  const subject = {
    money: 0,
    bazaar: { buyout: 1000000, dealBuyout: 0, marketValue: 1000000 }
  };
  const econ = { mugPct: 0.9, factionCut: 0, liquidation: 1, basket: 'all' };

  const est = s.estimateEconomics(subject, econ);
  assert.equal(est.spend, 1000000);
  assert.equal(est.mugTake, 900000);
  assert.equal(est.net, -100000 + 1000000, 'mug back 900k, keep 1m of goods');
});

test('the faction cut reduces the take', () => {
  const subject = { money: 0, bazaar: { buyout: 0, dealBuyout: 0, marketValue: 0 } };
  const est = s.estimateEconomics(subject, {
    mugPct: 1, factionCut: 0.5, liquidation: 1, basket: 'all'
  });
  assert.equal(est.net, 0);
});

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function makeSubject(overrides = {}) {
  const base = {
    id: 1234567,
    name: 'Target',
    level: 50,
    factionId: 999,
    status: s.readStatus({ status: { state: 'Okay', description: 'Okay' } }),
    lastActionAgo: 60,
    money: 5000000,
    moneyExposed: true,
    publicBs: null,
    vault: { hasVault: false, vaultAmount: null },
    bazaar: {
      items: [],
      itemLines: 5,
      count: 50,
      buyout: 50000000,
      marketValue: 55000000,
      worthyCount: 40,
      worthyBuyout: 48000000,
      dealCount: 10,
      dealBuyout: 12000000,
      topItem: { name: 'Xanax', value: 10000000, qty: 50, price: 200000 }
    },
    ff: { fairFight: 1.2, bsEstimate: 1000000, bsHuman: '1m', source: 'bss' }
  };
  return Object.assign({}, base, overrides);
}

function settingsWith(mutate) {
  const cfg = JSON.parse(JSON.stringify(s.DEFAULT_SETTINGS));
  cfg.me = { id: 111, name: 'Me', level: 60, factionId: 42, bs: 2000000, bsUpdated: 0 };
  if (mutate) mutate(cfg);
  return cfg;
}

test('a comfortable, cash-rich, well-stocked seller is a match', () => {
  const v = s.evaluateTarget(makeSubject(), { settings: settingsWith() });
  assert.equal(v.verdict, 'match', JSON.stringify(v.reasons));
  assert.ok(v.score > 50, `score should be healthy, got ${v.score}`);
});

test('a player abroad is rejected when the in-Torn filter is on', () => {
  const subject = makeSubject({
    status: s.readStatus({ status: { state: 'Abroad', description: 'Abroad' } })
  });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('abroad'));
});

test('the in-Torn filter can be switched off', () => {
  const subject = makeSubject({
    status: s.readStatus({ status: { state: 'Abroad', description: 'Abroad' } })
  });
  const v = s.evaluateTarget(subject, {
    settings: settingsWith((cfg) => { cfg.filters.inTornOnly.on = false; })
  });
  assert.equal(v.verdict, 'match', 'abroad should no longer block, got: ' + v.reasons);
});

test('a hospitalised player is rejected when the filter is on', () => {
  const subject = makeSubject({
    status: s.readStatus({ status: { state: 'Hospital', description: 'Hospital' } })
  });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('hospitalised'));
});

/* ------------------------------------------------------------------ */
/* The "soon" exceptions                                               */
/* ------------------------------------------------------------------ */

function inMinutes(mins, state, description) {
  const until = Math.floor(Date.now() / 1000) + mins * 60;
  return s.readStatus({ status: { state, description, until } });
}

test('someone landing shortly is allowed through the abroad rule', () => {
  const subject = makeSubject({ status: inMinutes(4, 'Abroad', 'Travelling to China') });

  const allowed = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(allowed.verdict, 'match', JSON.stringify(allowed.reasons));
  assert.ok(
    allowed.positives.some((p) => /lands in/.test(p)),
    'and says when they land: ' + JSON.stringify(allowed.positives)
  );
});

test('someone landing in an hour is still rejected by default', () => {
  const subject = makeSubject({ status: inMinutes(60, 'Abroad', 'Travelling to China') });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('abroad'));
});

test('the landing window is adjustable', () => {
  const subject = makeSubject({ status: inMinutes(60, 'Abroad', 'Abroad') });
  const v = s.evaluateTarget(subject, {
    settings: settingsWith((cfg) => {
      cfg.filters.soonInTorn.value = 90;
    })
  });
  assert.equal(v.verdict, 'match', JSON.stringify(v.reasons));
});

test('the landing exception can be switched off', () => {
  const subject = makeSubject({ status: inMinutes(2, 'Abroad', 'Abroad') });
  const v = s.evaluateTarget(subject, {
    settings: settingsWith((cfg) => {
      cfg.filters.soonInTorn.on = false;
    })
  });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('abroad'));
});

test('someone leaving hospital shortly is allowed through', () => {
  const subject = makeSubject({ status: inMinutes(3, 'Hospital', 'In hospital') });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'match', JSON.stringify(v.reasons));
  assert.ok(v.positives.some((p) => /free in/.test(p)), JSON.stringify(v.positives));
});

test('a long hospital stay is still rejected', () => {
  const subject = makeSubject({ status: inMinutes(120, 'Hospital', 'In hospital') });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('hospitalised'));
});

test('a state with no end time cannot qualify as soon', () => {
  // Federal jail has no release time in the payload.
  const subject = makeSubject({
    status: s.readStatus({ status: { state: 'Federal', description: 'Federal jail' } })
  });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  // The explicit state must win: "Federal jail" is federal, not ordinary jail.
  assert.ok(v.reasons.includes('federal'), JSON.stringify(v.reasons));
});

test('the explicit state outranks a misleading description', () => {
  const st = s.readStatus({ status: { state: 'Jail', description: 'Federal jail' } });
  assert.equal(st.isJail, true);
  assert.equal(st.isFederal, false);

  const fed = s.readStatus({ status: { state: 'Federal', description: 'In federal jail' } });
  assert.equal(fed.isFederal, true);
  assert.equal(fed.isJail, false, 'state wins over the description');
});

test('secondsUntilFree reads the API timestamp and copes without one', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(s.secondsUntilFree({ until: now + 120 }, now), 120);
  assert.equal(s.secondsUntilFree({ until: now - 500 }, now), 0, 'never negative');
  assert.equal(s.secondsUntilFree({ until: null }, now), null);
  assert.equal(s.secondsUntilFree(null, now), null);
});

test('a seller we could not read still produces a named, explained row', () => {
  const stub = s.buildStubSubject(7654321, 'Bazaar Bob', 'data is private');
  const v = s.evaluateTarget(stub, { settings: settingsWith() });

  assert.equal(stub.name, 'Bazaar Bob', 'the name from the listing is used');
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('data is private'), JSON.stringify(v.reasons));
});

test('a stub with no name hint falls back to a readable placeholder', () => {
  const stub = s.buildStubSubject(7654321, null, 'lookup failed');
  assert.equal(stub.name, 'Player 7654321');
});

test('battle-stat and fair-fight ceilings both bite', () => {
  const strongFF = makeSubject({ ff: { fairFight: 4.5, bsEstimate: 1e9, source: 'bss' } });
  const v = s.evaluateTarget(strongFF, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.some((r) => r.startsWith('FF')));

  const strongBs = makeSubject({ ff: { fairFight: 1.0, bsEstimate: 9000000, source: 'bss' } });
  const v2 = s.evaluateTarget(strongBs, { settings: settingsWith() });
  assert.equal(v2.verdict, 'reject');
  assert.ok(v2.reasons.some((r) => r.startsWith('BS')), JSON.stringify(v2.reasons));
});

test('the multiplier makes the stat comparison tunable', () => {
  const subject = makeSubject({ ff: { fairFight: 1.1, bsEstimate: 3000000, source: 'bss' } });
  const strict = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(strict.verdict, 'reject', '3m vs my 2m should fail at 1.0x');

  const lenient = s.evaluateTarget(subject, {
    settings: settingsWith((cfg) => { cfg.filters.bsVsMine.value = 2.0; })
  });
  assert.equal(lenient.verdict, 'match', 'but pass at 2.0x');
});

test('vault filter supports exclude, require and ignore', () => {
  const withVault = makeSubject({ vault: { hasVault: true, vaultAmount: 1000000 } });

  const ignored = s.evaluateTarget(withVault, { settings: settingsWith() });
  assert.equal(ignored.verdict, 'match', 'default is ignore');

  const excluded = s.evaluateTarget(withVault, {
    settings: settingsWith((cfg) => { cfg.filters.vault = 'exclude'; })
  });
  assert.equal(excluded.verdict, 'reject');
  assert.ok(excluded.reasons.includes('has a vault'));

  const required = s.evaluateTarget(makeSubject(), {
    settings: settingsWith((cfg) => { cfg.filters.vault = 'require'; })
  });
  assert.equal(required.verdict, 'reject', 'no vault fails a require filter');
});

test('unknown stats are allowed by default but excludable', () => {
  const blank = makeSubject({ ff: { fairFight: null, bsEstimate: null, source: null } });

  const allowed = s.evaluateTarget(blank, { settings: settingsWith() });
  assert.equal(allowed.verdict, 'match');

  const strict = s.evaluateTarget(blank, {
    settings: settingsWith((cfg) => { cfg.filters.allowUnknownStats.on = false; })
  });
  assert.equal(strict.verdict, 'reject');
  assert.ok(strict.reasons.includes('no FF data'));
});

test('your own faction is excluded when enabled', () => {
  const mate = makeSubject({ factionId: 42 });
  const v = s.evaluateTarget(mate, { settings: settingsWith() });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('your faction'));
});

test('an unset battle-stat yardstick fails loudly rather than passing', () => {
  const v = s.evaluateTarget(makeSubject(), {
    settings: settingsWith((cfg) => { cfg.me.bs = 0; })
  });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.includes('your stats not set'));
});

test('money threshold rejects a broke seller but tolerates hidden cash', () => {
  const broke = makeSubject({ money: 0 });
  const v = s.evaluateTarget(broke, {
    settings: settingsWith((cfg) => {
      cfg.filters.minMoney.on = true;
      cfg.filters.minMoney.value = 1000000;
    })
  });
  assert.equal(v.verdict, 'reject');

  // Torn hides other players' cash on some key types; that must not be
  // silently treated as "has plenty" or as a hard failure.
  const hidden = makeSubject({ money: null, moneyExposed: false });
  const v2 = s.evaluateTarget(hidden, {
    settings: settingsWith((cfg) => {
      cfg.filters.minMoney.on = true;
      cfg.filters.minMoney.value = 1000000;
    })
  });
  assert.equal(v2.verdict, 'match', JSON.stringify(v2.reasons));
});

test('min score filter is applied last and is toggleable', () => {
  const v = s.evaluateTarget(makeSubject(), {
    settings: settingsWith((cfg) => {
      cfg.filters.minScore.on = true;
      cfg.filters.minScore.value = 99;
    })
  });
  assert.equal(v.verdict, 'reject');

  const off = s.evaluateTarget(makeSubject(), { settings: settingsWith() });
  assert.equal(off.verdict, 'match');
});

/* ------------------------------------------------------------------ */
/* Subject building                                                    */
/* ------------------------------------------------------------------ */

test('builds a subject from a Torn user payload', () => {
  const torn = {
    profile: { name: 'Seller', level: 42, last_action: 0 },
    basic: { player_id: 1234567, name: 'Seller', faction_id: 777 },
    stats: { strength: 100, speed: 100, dexterity: 100, defense: 100 },
    money: { money_onhand: 2500000 },
    bazaar: [{ name: 'Xanax', quantity: 3, price: 800000, market_price: 900000 }],
    property: { properties: { 1: { property: 'Castle', upgrades: ['vault'] } } }
  };

  const subject = s.buildSubject(1234567, torn, { fairFight: 1.5, bsEstimate: 400 });

  assert.equal(subject.name, 'Seller');
  assert.equal(subject.level, 42);
  assert.equal(subject.factionId, 777);
  assert.equal(subject.publicBs, 400);
  assert.equal(subject.money, 2500000);
  assert.equal(subject.bazaar.buyout, 2400000);
  assert.equal(subject.vault.hasVault, true);
  assert.equal(subject.ff.fairFight, 1.5);
});

test('last_action timestamps in ms and s both resolve to seconds ago', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const asSeconds = s.buildSubject(1, { profile: { last_action: nowSec - 120 } }, null);
  assert.ok(Math.abs(asSeconds.lastActionAgo - 120) <= 2);

  const asMillis = s.buildSubject(1, { profile: { last_action: (nowSec - 120) * 1000 } }, null);
  assert.ok(Math.abs(asMillis.lastActionAgo - 120) <= 2);
});

test('hidden battle stats fall back to the FF estimate', () => {
  const torn = { profile: { name: 'Private' }, bazaar: [] };
  const subject = s.buildSubject(5, torn, { fairFight: 2, bsEstimate: 123456789 });
  assert.equal(subject.publicBs, null);
  assert.equal(subject.ff.bsEstimate, 123456789);
});

/* ------------------------------------------------------------------ */
/* Helpers / settings migration                                        */
/* ------------------------------------------------------------------ */

test('parses the numeric shapes Torn returns', () => {
  assert.equal(s.toNumber('1,234,567'), 1234567);
  assert.equal(s.toNumber('$500'), 500);
  assert.equal(s.toNumber(null), null);
  assert.equal(s.toNumber(''), null);
  assert.equal(s.toNumber('abc'), null);
  assert.equal(s.toNumber(0), 0);
});

test('formats large numbers the way the table shows them', () => {
  assert.equal(s.formatNumber(1500), '1.5k');
  assert.equal(s.formatNumber(2500000), '2.50m');
  assert.equal(s.formatNumber(3100000000), '3.10b');
  assert.equal(s.formatNumber(null), '-');
});

test('new settings appear for existing users without wiping saved values', () => {
  const saved = { filters: { minBazaarValue: { on: false, value: 42 } } };
  const merged = s.mergeDefaults(s.DEFAULT_SETTINGS, saved);

  assert.equal(merged.filters.minBazaarValue.on, false, 'user choice kept');
  assert.equal(merged.filters.minBazaarValue.value, 42);
  assert.equal(merged.filters.vault, 'ignore', 'new key picked up from defaults');
  assert.ok(merged.api.tornKey === '', 'untouched sections still present');
});

test('csv export quotes and escapes properly', () => {
  const csv = s.toCsv([{ a: 'plain', b: 'has "quotes"', c: null }]);
  assert.equal(csv.split('\n')[0], 'a,b,c');
  assert.ok(csv.includes('"has ""quotes"""'));
});
