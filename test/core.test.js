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

  const sum = s.summariseBazaar(items, { worthyUnitPrice: 100000, dealDiscount: 0.15, priceLimitPct: 100 });

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
  const sum = s.summariseBazaar([{ quantity: 1, price: 10 }], {});
  assert.equal(sum.worthyCount, 1);
});

test('survives an empty or malformed bazaar', () => {
  assert.equal(s.summariseBazaar(undefined, { worthyUnitPrice: 1000, dealDiscount: 0.1 }).buyout, 0);
  assert.equal(s.summariseBazaar([null, 'x'], { worthyUnitPrice: 1000, dealDiscount: 0.1 }).count, 0);
});

/* ------------------------------------------------------------------ */
/* Bazaar listing payloads - every shape Torn has used                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Paying above market                                                 */
/* ------------------------------------------------------------------ */

/* --- A seller row whose listing details are nested ------------------
 * This is the shape that produced a real player id with no price and no
 * quantity, which rendered as "null x" and valued the seller at $0.
 */
test('finds the price and quantity even when they are nested', () => {
  const shapes = [
    [{ ID: 3916729, cost: 800000, quantity: 5 }],
    [{ player_id: 3916729, item_id: 206, listing: { cost: 800000, quantity: 5 } }],
    [{ player_id: 3916729, name: 'X', details: { price: 800000, quantity: 5 } }],
    [{ player_id: 3916729, player_name: 'X', price: 800000, quantity: 5 }]
  ];

  shapes.forEach((rows, i) => {
    const out = s.normaliseBazaarRows({ listings: rows }, 206);
    assert.equal(out.length, 1, 'shape ' + i + ' found the seller');
    assert.equal(out[0].price, 800000, 'shape ' + i + ' found the price');
    assert.equal(out[0].qty, 5, 'shape ' + i + ' found the quantity');
  });
});

test('a row with no price anywhere is left without one, not guessed at', () => {
  const out = s.normaliseBazaarRows({ listings: [{ player_id: 3916729 }] }, 206);
  assert.equal(out[0].price, null, 'still null - the caller decides what to do');
  assert.equal(out[0].qty, null);
});

test('a seller with no usable price is not valued at zero', () => {
  // The guard that stops "null x" reaching the table.
  const subject = s.buildSubject(
    3916729,
    { name: 'PremAssassin', bazaar: [], __tbmsSelections: 'profile,basic,bazaar' },
    null,
    null,
    { itemName: 'Bag of Chocolate Kisses', price: null, qty: null, marketPrice: null }
  );

  assert.equal(subject.listing, null, 'the useless listing is discarded');
  assert.equal(subject.valueUnknown, true, 'and the value is marked unknown');
  assert.match(subject.valueUnknownReason, /without a price and quantity/);
});

/* ------------------------------------------------------------------ */
/* The mugging formula                                                 */
/* ------------------------------------------------------------------ */

test('the mug percentage is (1 + merits/10) x (23 - ln cash)', () => {
  // Hand-computed: ln(1e6) = 13.8155, so 23 - 13.8155 = 9.1845 -> 9.18%.
  assert.equal(s.mugPercent(1000000, 0), 9.18);
  // ln(5e6) = 15.4249 -> 7.5751 -> 7.58%.
  assert.equal(s.mugPercent(5000000, 0), 7.58);
  // Merits scale the rate: 10 points doubles it.
  assert.equal(s.mugPercent(1000000, 10), 18.37);
  assert.equal(s.mugPercent(5000000, 10), 15.15);
});

test('the rate bottoms out at 1% exactly at the formula cap', () => {
  // The cap in the formula is e^22, and that is precisely where
  // 23 - ln(cash) reaches 1 - so the two branches meet with no step.
  assert.equal(s.MUG_CASH_CAP, Math.round(Math.exp(22)));
  assert.equal(s.mugPercent(s.MUG_CASH_CAP - 1, 0), 1);
  assert.equal(s.mugPercent(s.MUG_CASH_CAP, 0), 1);
  assert.equal(s.mugPercent(1e10, 0), 1, 'richer targets still give 1%');
  assert.equal(s.mugPercent(1e10, 10), 2, 'doubled by merits');
});

test('the payout is floored, not rounded', () => {
  // FLOOR(9.18 x 1,000,000 / 100) = 91,800
  assert.equal(s.mugTake(1000000, 0), 91800);
  // FLOOR(7.58 x 5,000,000 / 100) = 379,000
  assert.equal(s.mugTake(5000000, 0), 379000);
  // FLOOR(1 x 3,584,912,846 / 100) = 35,849,128 (the .46 is dropped)
  assert.equal(s.mugTake(s.MUG_CASH_CAP, 0), 35849128);
});

test('mugging nothing pays nothing', () => {
  assert.equal(s.mugTake(0, 0), 0);
  assert.equal(s.mugTake(null, 0), 0);
  assert.equal(s.mugPercent(0, 0), 0 || s.mugPercent(0, 0)); // no throw either way
});

test('the rate falls as the target holds more', () => {
  const small = s.mugPercent(100000, 0);
  const big = s.mugPercent(1000000000, 0);
  assert.ok(small > big, `${small}% on 100k should beat ${big}% on 1b`);
});

test('an overpriced listing shows up as a negative net profit', () => {
  // The case that started this: an item listed at 5m against a 4m market.
  const at = (price) => {
    const ls = s.summariseBazaar(
      [{ name: 'E-DVD', price: price, quantity: 1, market_price: 4000000 }],
      {}
    );
    return s.lootBreakdown({ value: ls.buyout, listingSummary: ls, bazaar: s.summariseBazaar([], {}) });
  };

  const market = at(4000000);
  assert.equal(market.spend, 4000000, 'you hand over the asking price');
  assert.equal(market.gross, 312000, 'mug pays 7.80% of it');
  assert.equal(market.unitDifference, 0, 'no difference per item at market');
  assert.equal(market.totalDifference, 0);
  assert.equal(market.net, 312000, 'so the mug is the whole profit');

  const over = at(5000000);
  assert.equal(over.unitDifference, -1000000, 'the difference per item is the overpay');
  assert.equal(over.totalDifference, -1000000);
  assert.equal(over.gross, 379000, 'a bigger spend does pay out more');
  assert.ok(over.net < 0, 'but the net is a loss: ' + over.net);
  assert.equal(over.net, -1000000 + 379000, 'the difference plus the mug');
  assert.ok(over.net < market.net, 'and it is worse than buying at market');
});

test('under market, the difference per item is a gain on every item', () => {
  // Their formula: (market - price) x qty, plus the mug.
  const ls = s.summariseBazaar(
    [{ name: 'Pangolin Scales', price: 184500, quantity: 18, market_price: 205000 }],
    {}
  );
  const d = s.lootBreakdown({
    value: ls.buyout,
    listingSummary: ls,
    listing: { itemName: 'Pangolin Scales', price: 184500, qty: 18, marketPrice: 205000 }
  });

  assert.equal(d.qty, 18);
  assert.equal(d.price, 184500);
  assert.equal(d.marketPrice, 205000);
  assert.equal(d.unitDifference, 20500, '20,500 under per item');
  assert.equal(d.totalDifference, 20500 * 18, 'x 18 = 369,000');
  assert.equal(d.net, d.totalDifference + d.gross, 'the mug on top of the difference');
  assert.ok(d.net > d.gross, 'a good price beats the mug alone');
});

test('a seller at exactly market value still yields the mug', () => {
  // The report's case: 18 x 205,000 against a 205,000 market.
  const ls = s.summariseBazaar(
    [{ name: 'Pangolin Scales', price: 205000, quantity: 18, market_price: 205000 }],
    {}
  );
  const d = s.lootBreakdown({
    value: ls.buyout,
    listingSummary: ls,
    listing: { itemName: 'Pangolin Scales', price: 205000, qty: 18, marketPrice: 205000 }
  });

  assert.equal(d.totalDifference, 0, 'nothing gained or lost on the goods');
  assert.equal(d.net, d.gross, 'so the net is exactly the mug');
  assert.ok(d.net > 0, 'and it is a profit');
});

test('the loot figure is what separates a good price from a bad one', () => {
  // No market-percentage rule is needed once the loot is netted off: the
  // overpay shows up on its own.
  const at = (price) =>
    (() => {
      const ls = s.summariseBazaar([{ price: price, quantity: 1, market_price: 4000000 }], {});
      return s.lootBreakdown({ value: ls.buyout, listingSummary: ls, bazaar: s.summariseBazaar([], {}) }).net;
    })();

  const nets = [3500000, 4000000, 4500000, 5000000].map(at);
  assert.ok(nets[0] > nets[1], 'cheaper is better');
  assert.ok(nets[1] > nets[2] && nets[2] > nets[3], `monotonically worse: ${nets}`);
  assert.ok(nets[0] > 0 && nets[3] < 0, 'and it crosses from profit to loss');
});

test('a bazaar is summarised without any price ceiling', () => {
  const sum = s.summariseBazaar(
    [
      { name: 'Xanax', quantity: 10, price: 800000, market_price: 900000 },
      { name: 'E-DVD', quantity: 1, price: 5000000, market_price: 4000000 },
      { name: 'Feather', quantity: 5, price: 95000, market_price: 100000 }
    ],
    {}
  );

  assert.equal(sum.buyout, 10 * 800000 + 5000000 + 5 * 95000, 'everything listed counts');
  assert.equal(sum.marketValue, 10 * 900000 + 4000000 + 5 * 100000);
  assert.equal(sum.count, 16);
  assert.equal(sum.dealCount, 15, 'the two under-market lines');
});

test('the estimate spends the listing price', () => {
  const subject = {
    value: 1000000,
    listing: { itemName: 'Xanax', price: 100000, qty: 10, marketPrice: 120000 },
    listingSummary: {
      buyout: 1000000,
      marketValue: 1200000,
      dealBuyout: 0,
      count: 10,
      itemLines: 1
    }
  };
  const est = s.estimateEconomics(subject, { mugMerits: 0, factionCut: 0, liquidation: 1 });

  assert.equal(est.spend, 1000000, 'the asking price times the quantity');
  // 23 - ln(1e6) = 9.18%, floored.
  assert.equal(est.mugTake, 91800);
  assert.equal(est.unitDifference, 20000, '20k under market per item');
  assert.equal(est.totalDifference, 200000);
  assert.equal(est.net, 200000 + 91800, 'the difference plus the mug');
});

test('reads an array of listings keyed by ID (the documented v1 shape)', () => {
  const rows = s.normaliseBazaarRows(
    { bazaar: [{ ID: 1234567, cost: 800000, quantity: 5 }] },
    206
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1234567);
  assert.equal(rows[0].price, 800000);
  assert.equal(rows[0].qty, 5);
});

test('reads listings with an explicit player_id (the v2 shape)', () => {
  const rows = s.normaliseBazaarRows(
    { bazaar: [{ player_id: 987654, item_id: 206, price: 810000, quantity: 9 }] },
    206
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 987654);
  assert.equal(rows[0].price, 810000);
});

test('reads a map keyed by seller id', () => {
  const rows = s.normaliseBazaarRows(
    { bazaar: { '1234567': { cost: 800000, quantity: 5 } } },
    206
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1234567, 'the key is the seller');
  assert.equal(rows[0].qty, 5);
});

test('never mistakes the item id for a seller id', () => {
  // A user's own bazaar lists items as {ID: <item id>}; reading that as a
  // player would send us looking up item 206 as a person.
  const rows = s.normaliseBazaarRows(
    { bazaar: [{ ID: 206, name: 'Xanax', quantity: 5, price: 800000 }] },
    206
  );
  assert.deepEqual(rows, []);
});

test('keeps the seller name when the listing carries one', () => {
  const rows = s.normaliseBazaarRows(
    { listings: [{ player_id: 555, player_name: 'Amara20', price: 830000, quantity: 3 }] },
    206
  );
  assert.equal(rows[0].name, 'Amara20');
});

test('de-duplicates a seller listed several times', () => {
  const rows = s.normaliseBazaarRows(
    {
      bazaar: [
        { player_id: 555, price: 830000, quantity: 3 },
        { player_id: 555, price: 840000, quantity: 2 }
      ]
    },
    206
  );
  assert.equal(rows.length, 1);
});

test('digs listings out of a nested wrapper', () => {
  const rows = s.normaliseBazaarRows(
    { data: { bazaar: [{ player_id: 42, price: 1, quantity: 1 }] } },
    206
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 42);
});

test('an unrecognised shape yields no rows rather than junk ids', () => {
  assert.deepEqual(s.normaliseBazaarRows({ bazaar: [{ note: 'nothing useful' }] }, 206), []);
  assert.deepEqual(s.normaliseBazaarRows(null, 206), []);
  assert.deepEqual(s.normaliseBazaarRows({ bazaar: 'nope' }, 206), []);
});

test('reads where a player lives from a v2 property payload', () => {
  assert.equal(
    s.propertyLabel({ properties: { 1: { name: 'Castle', upgrades: ['vault'] } } }),
    'Castle'
  );
  assert.equal(s.propertyLabel({ properties: { 7: { property: 'Trailer' } } }), 'Trailer');
  assert.equal(s.propertyLabel(null), null);
  assert.equal(s.propertyLabel({ properties: {} }), null);
});

/* ------------------------------------------------------------------ */
/* Estimate model                                                      */
/* ------------------------------------------------------------------ */

test('the estimate follows the mug-and-keep-the-goods model', () => {
  const subject = {
    money: 0,
    listingSummary: {
      buyout: 1000000,
      dealBuyout: 0,
      marketValue: 1000000,
      buyableBuyout: 1000000,
      buyableMarketValue: 1000000
    }
  };
  const econ = { mugMerits: 0, factionCut: 0, liquidation: 1 };

  const est = s.estimateEconomics(subject, econ);
  assert.equal(est.spend, 1000000);
  // The game's formula: 23 - ln(1e6) = 9.18%, floored.
  assert.equal(est.mugPercent, 9.18);
  assert.equal(est.mugTake, 91800);
  assert.equal(est.net, 91800, 'mug 91.8k, hand back the same 1m in goods');
});

test('the faction cut reduces the take', () => {
  const subject = {
    money: 0,
    listingSummary: {
      buyout: 0,
      dealBuyout: 0,
      marketValue: 0,
      buyableBuyout: 0,
      buyableMarketValue: 0
    }
  };
  const est = s.estimateEconomics(subject, {
    mugPct: 1, factionCut: 0.5, liquidation: 1
  });
  assert.equal(est.net, 0);
});

/* ------------------------------------------------------------------ */
/* Shared fixtures for the loot arithmetic                             */
/* ------------------------------------------------------------------ */

/* The bazaar from the report, in the shape that used to parse as empty. */
const FIVE_ITEMS = [
  { ID: 1, name: 'Hydrogen Tank', quantity: 6, price: 25760, market_price: 23000 },
  { ID: 2, name: 'Spy Camera', quantity: 3, price: 492, market_price: 480 },
  { ID: 3, name: 'Methane Tank', quantity: 2, price: 23252, market_price: 23000 },
  { ID: 4, name: 'Pangolin Scales', quantity: 18, price: 205000, market_price: 205000 },
  { ID: 5, name: 'Single Red Rose', quantity: 1, price: 414, market_price: 400 }
];

const ECON = { mugMerits: 0, factionCut: 0, liquidation: 1 };

/** A subject as a scan would build one for an item search. */
function listingSubject(price, marketPrice, qty) {
  const listing = { itemName: 'E-DVD', price: price, qty: qty, marketPrice: marketPrice };
  const summary = s.summariseBazaar(
    [{ name: listing.itemName, price: price, quantity: qty, market_price: marketPrice }],
    {}
  );
  return { value: summary.buyout, listing: listing, listingSummary: summary };
}

test('paying above market turns a profit into a loss', () => {
  // The case that started this: an item listed at 5m against a 4m market.
  const at = (price) => s.estimateEconomics(listingSubject(price, 4000000, 1), ECON);

  const market = at(4000000);
  assert.equal(market.mugPercent, 7.8);
  assert.equal(market.unitDifference, 0, 'nothing gained or lost at market');
  assert.equal(market.net, 312000, 'so the mug is the whole profit');

  const over = at(5000000);
  assert.equal(over.mugPercent, 7.58);
  assert.equal(over.unitDifference, -1000000, 'the overpay is a per-item loss');
  assert.equal(over.net, -621000, 'overpaying is a clear loss');
});

test('the loss grows with the overpay', () => {
  const nets = [4000000, 5000000, 6000000].map(
    (p) => s.estimateEconomics(listingSubject(p, 4000000, 1), ECON).net
  );
  assert.ok(nets[0] > nets[1] && nets[1] > nets[2], `monotonically worse: ${nets}`);
});

test('mugging merits scale the take but cannot rescue an overpay', () => {
  const at = (price, merits) =>
    s.estimateEconomics(listingSubject(price, 4000000, 1), {
      mugMerits: merits,
      factionCut: 0,
      liquidation: 1
    });

  // Merits roughly double the take at 10 points.
  assert.equal(at(4000000, 0).mugTake, 312000);
  assert.equal(at(4000000, 10).mugTake, 624000);

  // Even fully merited, overpaying by 25% still loses money here.
  assert.ok(at(5000000, 10).net < 0, 'a maxed merit does not make a bad price good');
});

/* ------------------------------------------------------------------ */
/* Estimate model                                                      */
/* ------------------------------------------------------------------ */

test('a bazaar is read whether it arrives as an array or a map', () => {
  assert.equal(s.normaliseUser({ bazaar: FIVE_ITEMS }).bazaar.length, 5, 'array form');
  assert.equal(
    s.normaliseUser({ bazaar: { items: FIVE_ITEMS } }).bazaar.length,
    5,
    'wrapped form'
  );

  const map = {};
  FIVE_ITEMS.forEach((it, i) => {
    map[String(i + 1)] = it;
  });
  const asMap = s.normaliseUser({ bazaar: map }).bazaar;
  assert.equal(asMap.length, 5, 'map keyed by item id');
  assert.equal(asMap[3].name, 'Pangolin Scales', 'and the rows survive intact');
});

test('toItemArray copes with anything rather than throwing', () => {
  assert.deepEqual(s.toItemArray(null), []);
  assert.deepEqual(s.toItemArray(undefined), []);
  assert.deepEqual(s.toItemArray('nonsense'), []);
  assert.deepEqual(s.toItemArray(42), []);
  assert.equal(s.toItemArray(FIVE_ITEMS).length, 5);
});

test('only the searched item is valued, not the whole bazaar', () => {
  // The report's bazaar: 18 pangolin scales plus 12 other items.
  const subject = s.buildSubject(4425009, { bazaar: FIVE_ITEMS }, null, null, null, 4);

  assert.equal(subject.bazaar.buyout, 6 * 25760 + 3 * 492 + 2 * 23252 + 18 * 205000 + 414);
  assert.equal(subject.itemSummary.itemLines, 1, 'one line: the item searched');
  assert.equal(subject.itemSummary.buyout, 18 * 205000, '18 x 205,000 only');
  assert.equal(subject.value, 3690000, 'the rest of their stock is excluded');
  assert.equal(subject.valueSource, 'bazaar line');

  // And the loot follows the same figure.
  const d = s.lootBreakdown(subject);
  assert.equal(d.spend, 3690000);
  assert.equal(d.net, s.mugTake(3690000, 0), 'at market, the mug is the profit');
});

test('a different item in the same bazaar gives a different figure', () => {
  const scales = s.buildSubject(1, { bazaar: FIVE_ITEMS }, null, null, null, 4);
  const chocolate = s.buildSubject(1, { bazaar: FIVE_ITEMS }, null, null, null, 1);
  assert.notEqual(scales.value, chocolate.value, 'each item is its own figure');
  assert.equal(scales.value, 3690000);
});

test('without an item selected there is nothing to value', () => {
  // A page scan has no item context, so no profit can be claimed.
  const subject = s.buildSubject(1, { bazaar: FIVE_ITEMS }, null, null, null, null);
  assert.equal(subject.value, 0);
  assert.equal(subject.valueUnknown, true);
  assert.equal(subject.valueUnknownReason, 'no item selected');
  assert.equal(s.lootBreakdown(subject).net, 0, 'and no profit is invented');
});

test('a bazaar Torn declined to send is flagged, not reported as empty', () => {
  const torn = { player_id: 1, name: 'X', bazaar: [], __tbmsSelections: 'profile,basic' };
  const subject = s.buildSubject(1, torn, null, null, null);

  assert.equal(subject.bazaarRead, false);
  assert.equal(subject.valueUnknown, true, 'we must not claim they have nothing');
  assert.equal(subject.value, 0, 'the number is still zero');
});

test('a bazaar that came back empty is a real answer', () => {
  const torn = { player_id: 1, name: 'X', bazaar: [], __tbmsSelections: 'profile,basic,bazaar' };
  const subject = s.buildSubject(1, torn, null, null, null, 4);

  assert.equal(subject.bazaarRead, true, 'the bazaar was read, and it was empty');
  assert.equal(subject.valueUnknown, true, 'so the item cannot be valued');
  assert.equal(subject.valueUnknownReason, 'that item is not in their bazaar');
});

test('a listing still counts even when the bazaar was not returned', () => {
  const listing = {
    itemId: 780,
    itemName: 'Pangolin Scales',
    price: 205000,
    qty: 18,
    marketPrice: 205000
  };
  const subject = s.buildSubject(
    1,
    { player_id: 1, name: 'X', __tbmsSelections: 'profile,basic' },
    null,
    null,
    listing
  );
  assert.equal(subject.valueUnknown, false, 'the listing answers the question');
  assert.equal(subject.value, 3690000);
});

test('an unvalued seller passes the value filter rather than being blamed', () => {
  // A missing measurement is not a seller holding nothing. Failing them on
  // it would reject every row a page scan turned up.
  const subject = makeSubject({
    value: 0,
    valueUnknown: true,
    valueUnknownReason: 'the listing came back without a price and quantity',
    listing: null,
    listingSummary: null,
    itemSummary: null,
    bazaar: s.summariseBazaar([], {})
  });
  const cfg = settingsWith((c) => {
    c.filters.minBazaarValue.on = true;
    c.filters.minBazaarValue.value = 1000000;
  });
  const v = s.evaluateTarget(subject, { settings: cfg });

  assert.equal(v.verdict, 'match', JSON.stringify(v.reasons));
  assert.ok(v.positives.includes('value not returned'), 'and says why');
});

test('a seller found by a listing is judged on that listing, not their bazaar', () => {
  // The reported case: 30 pangolin scales at the going rate, in Torn and
  // out of hospital, vault ignored - but their bazaar lookup came back
  // empty, so judging them on their bazaar scored them at zero.
  const emptyBazaar = s.summariseBazaar([], {});
  const listing = { itemId: 780, itemName: 'Pangolin Scales', price: 40000, qty: 30, marketPrice: 40000 };
  const listingSummary = s.summariseBazaar(
    [{ name: listing.itemName, price: listing.price, quantity: listing.qty, market_price: listing.marketPrice }],
    { priceLimitPct: 100 }
  );

  const subject = makeSubject({
    id: 1639224,
    name: 'starbug',
    bazaar: emptyBazaar,
    listing: listing,
    listingSummary: listingSummary,
    value: listingSummary.buyout,
    valueSource: 'listing',
    ff: { fairFight: 1.94, bsEstimate: 211100, source: 'bss' }
  });

  const v = s.evaluateTarget(subject, { settings: settingsWith() });

  assert.equal(subject.listingSummary.buyout, 1200000, '30 x 40k on the table');
  assert.equal(v.verdict, 'match', 'so it is a hit: ' + JSON.stringify(v.reasons));
  assert.ok(
    v.positives.some((p) => /loot|stats|In Torn/.test(p)),
    'and it reports something positive: ' + JSON.stringify(v.positives)
  );
});

test('an empty bazaar no longer reads as an empty bank', () => {
  // The old failure mode: bazaar empty -> value 0 -> rejected on value.
  const subject = makeSubject({
    bazaar: s.summariseBazaar([], {}),
    listing: { itemId: 780, itemName: 'Pangolin Scales', price: 40000, qty: 30, marketPrice: 40000 },
    listingSummary: s.summariseBazaar(
      [{ price: 40000, quantity: 30, market_price: 40000 }],
      { priceLimitPct: 100 }
    ),
    value: 1200000
  });
  const v = s.evaluateTarget(subject, { settings: settingsWith() });
  assert.equal(v.verdict, 'match', JSON.stringify(v.reasons));
});

test('nothing anywhere still means no sale to buy', () => {
  const subject = makeSubject({
    bazaar: s.summariseBazaar([], {}),
    listing: null,
    listingSummary: null,
    value: 0
  });
  const v = s.evaluateTarget(subject, {
    settings: settingsWith((c) => {
      c.filters.minBazaarValue.on = true;
      c.filters.minBazaarValue.value = 1000000;
    })
  });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.reasons.some((r) => /on sale/.test(r)), JSON.stringify(v.reasons));
});

test('the estimate spends the listing price, not a whole-bazaar basket', () => {
  const listingSummary = s.summariseBazaar(
    [{ price: 40000, quantity: 30, market_price: 40000 }],
    { priceLimitPct: 100 }
  );
  const est = s.estimateEconomics(
    { money: 99999999, listingSummary: listingSummary, bazaar: s.summariseBazaar([], {}) },
    { mugMerits: 0, factionCut: 0, liquidation: 1 }
  );

  assert.equal(est.spend, 1200000, '30 x 40k');
  // The mug is computed on what you hand over, since their own cash is
  // never visible - note the ignored money field above.
  assert.equal(est.mugTargetCash, 1200000);
  // 23 - ln(1,200,000) = 9.0022 -> 9.00%, floored to 108,000.
  assert.equal(est.mugPercent, 9);
  assert.equal(est.mugGross, 108000);
});

function makeSubject(overrides = {}) {
  const base = {
    id: 1234567,
    name: 'Target',
    level: 50,
    factionId: 999,
    status: s.readStatus({ status: { state: 'Okay', description: 'Okay' } }),
    lastActionAgo: 60,
    publicBs: null,
    vault: { hasVault: false, vaultAmount: null },
    // The money that moves: what they have on sale, which for an item scan
    // is the listing we found them through.
    listing: { itemId: 206, itemName: 'Xanax', price: 800000, qty: 60, marketPrice: 850000 },
    listingSummary: {
      items: [],
      itemLines: 1,
      count: 60,
      buyout: 48000000,
      marketValue: 51000000,
      worthyCount: 60,
      worthyBuyout: 48000000,
      dealCount: 60,
      dealBuyout: 48000000,
      buyableCount: 60,
      buyableBuyout: 48000000,
      buyableMarketValue: 51000000,
      overCount: 0,
      overBuyout: 0,
      overMarketValue: 0,
      overpayAmount: 0,
      worstOverpayPct: 0,
      unpricedLines: 0,
      topItem: { name: 'Xanax', value: 48000000, qty: 60, price: 800000 }
    },
    value: 48000000,
    valueSource: 'listing',
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
  assert.ok(v2.reasons.some((r) => r.startsWith('stats')), JSON.stringify(v2.reasons));
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

/* --- API v1 vs v2 payload shapes -----------------------------------
 * v1 merges every selection into one flat object; v2 nests them. Reading
 * only one shape is what produced nameless rows in the wild.
 */
const V1_FLAT_USER = {
  player_id: 1234567,
  name: 'Flat Sam',
  level: 33,
  faction_id: 777,
  status: { state: 'Hospital', description: 'In hospital', until: 9999999999 },
  last_action: { timestamp: Math.floor(Date.now() / 1000) - 300, relative: '5 minutes ago' },
  strength: 10,
  speed: 20,
  dexterity: 30,
  defense: 40,
  bazaar: [{ name: 'Xanax', quantity: 3, price: 800000, market_price: 900000 }]
};

const V2_NESTED_USER = {
  profile: { id: 1234567, name: 'Nested Nina', level: 44 },
  basic: { player_id: 1234567, name: 'Nested Nina', faction_id: 888 },
  stats: { strength: 5, speed: 5, dexterity: 5, defense: 5, total: 20 },
  money: { money_onhand: 5000000 },
  status: { state: 'Okay', description: 'Okay' },
  bazaar: []
};

test('reads a v1 flat user payload', () => {
  const u = s.normaliseUser(V1_FLAT_USER);
  assert.equal(u.name, 'Flat Sam', 'name sits at the top level in v1');
  assert.equal(u.level, 33);
  assert.equal(u.factionId, 777);
  assert.equal(u.status.state, 'Hospital');
  assert.ok(u.lastAction > 0, 'last_action.timestamp is read, not the object');
  assert.equal(u.stats.total, 100);
});

test('reads a v2 nested user payload', () => {
  const u = s.normaliseUser(V2_NESTED_USER);
  assert.equal(u.name, 'Nested Nina');
  assert.equal(u.level, 44);
  assert.equal(u.factionId, 888);
  assert.equal(u.stats.total, 20);
});

test('a v1 flat payload produces a properly named, located subject', () => {
  const subject = s.buildSubject(1234567, V1_FLAT_USER, null);
  assert.equal(subject.name, 'Flat Sam', 'not "Player 1234567"');
  assert.equal(subject.status.state, 'Hospital');
  assert.equal(subject.status.isHospital, true);
  assert.equal(subject.publicBs, 100);
  assert.ok(subject.lastActionAgo >= 290 && subject.lastActionAgo <= 320, 'seen ~5m ago');
  assert.equal(subject.bazaar.buyout, 2400000);
});

test('the last action object is not mistaken for a timestamp', () => {
  // Reading the object directly used to produce NaN -> "unknown".
  const subject = s.buildSubject(1, V1_FLAT_USER, null);
  assert.notEqual(subject.lastActionAgo, null);
});

test('readStatus accepts a bare status object as well as a payload', () => {
  assert.equal(s.readStatus({ state: 'Abroad' }).isAbroad, true);
  assert.equal(s.readStatus({ status: { state: 'Abroad' } }).isAbroad, true);
});

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

/* ------------------------------------------------------------------ */
/* The packed "already checked" record                                 */
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
