# Torn Buy-Mug Scout

Made by **Egco [2598210]**. If you enjoy it, send a Xanax.

**Licence: AGPL-3.0-or-later** - free software, no charge, no warranty. See
[LICENSE](LICENSE) for the full text.

A Tampermonkey userscript that reads the bazaar and item-market pages you
are already looking at, works out which sellers are worth buy-mugging, and
shows you a shortlist. Everything it checks is a toggle you can turn off or
a number you can retune, and your API key is stored in the script's own
storage rather than in the page.

The script is read-only: it never buys, attacks or mugs. It fetches data
and lays it out. You keep the trigger.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the Tampermonkey dashboard, go to **Utilities**, and either
   * drag `torn-buymugger-scout.user.js` onto the page, or
   * paste the file's contents into a new script.
3. Save. Loading `torn.com` will now mount the scout.

## First run

The panel opens on the **Setup** tab automatically.

1. Paste a Torn API key. **Use a Limited key.**

   Torn keys come in four levels: Public, Minimal, Limited and Full. The
   script has to read *other players'* bazaars, property and cash, which
   Public and Minimal keys are not allowed to do. Full works too.

   If a key is too weak, Torn answers "access level of this key is not high
   enough" (error 16) rather than failing silently. **Test keys & load my
   stats** asks Torn what your key can actually read and prints a report
   naming each selection that is blocked, so you never have to guess.

   Two things no key level will get you, and the checker says so plainly:
   another player's **cash** is never exposed, and their **vault** is only
   visible when Torn chooses to reveal it. Where they *live* is public and
   comes from API v2.

   The key fields are plain text inputs that are masked with CSS, not
   `type="password"` ones, and they carry the opt-out hints that LastPass,
   1Password, Bitwarden and Dashlane honour. Your browser will not offer to
   save them as a login and password managers will not autofill them. Press
   **Show** if you want to check what you pasted.
2. Press **Test keys & load my stats**. This pulls your own player ID,
   faction and total battle stats, which become the yardstick every
   comparison is measured against.
3. If FFScouter has not seen your key before, the status line says so.
   FFScouter requires the key to be registered on
   [ffscouter.com](https://ffscouter.com) before it will return
   estimates; register it once and the warning goes away.

## Using it

Type an item name (or id) into the Scan tab and press **Scan item bazaars**.
The seller list comes from bazaar *data*, not from anything rendered on
screen, so it works from any Torn page. The script then:

1. batches every seller into a single FFScouter request,
2. looks each one up on the Torn API (rate limited, cached, a few at a time),
3. scores them and shows the ones that survived your filters.

Start typing and pick from the dropdown - "xanax" finds Xanax. The item
index comes from Torn, and falls back to the community index if Torn will
not serve it, so the picker works even before your key is set up right. It
is cached for a week, and a raw item id always works with no index at all.
Sellers are ordered by the value of the listing the script found them
through, so when the per-scan cap bites you get the biggest stocks first.

### Auto-scan

**Auto-scan** re-checks the chosen item's bazaar sellers in the background,
over and over, so a shortlist is waiting for you rather than something you
have to ask for. Press the button again to pause it. Whether it is running
is saved with your settings, so a running loop resumes after a refresh and
a paused one stays paused. The status bar counts down to the next pass, and
**Auto-scan every N sec** sets the interval (minimum 10) - changing it
re-arms the loop immediately rather than waiting for the current gap.

Repeats are cheap: the per-player data is cached, so only the bazaar
listing is re-fetched each round unless a player's cache has expired.

### The results card

When a scan finds matches, a card appears in the bottom-right corner with
the actions for each one - **attack**, **bazaar** and **watch** - plus a
count and where they came from. The card is a port of the Bounty Hunter
toaster idea: the common case (see a target, attack it) never needs the
panel opened. **Open panel** jumps to the full table if you want it.

It stays until you dismiss it or the match list changes, so it will not
re-announce the same people on every background pass, and there is a switch
on the Scan tab to turn it off.

### Nothing is lost when you move around

Switching between the panel's own tabs only shows and hides them, so the
results, the item you were typing and the auto-scan interval all stay put.

Torn reloads the page when you move between *its* tabs, though, and that
used to take the whole result list with it. The last scan is now saved, so
going to the market and coming back still shows your shortlist - it is even
announced in the status bar. Stored results are **re-scored on the way back
in**, so what you see always reflects the filters you have now rather than
the ones that were set when the scan ran.

Only the totals are kept, not the raw API payloads or the item lists, which
works out at well under a kilobyte per seller. The store is capped at 200
sellers and expires after 12 hours.

#### Nothing is skipped for having been seen

There is deliberately **no "already checked" list**. Remembering who had
been looked at was meant to keep repeat scans fresh, but it turned a finite
seller list into a dead end: once the hundred-odd names the sources know
about had been through, every later scan refused to do anything and
reported "all N have been checked" as though that were the whole market.
FFScouter screens the candidates anyway, and Torn's responses are cached,
so re-examining the same list costs very little.

The list of sellers a scan works from is whatever the sources return right
now. To narrow the results, use the filters - the strength screen and the
profit floor are the ones that matter.

### Auto-scan

**Auto-scan** re-checks the chosen item's bazaar sellers in the background,
over and over, so a shortlist is waiting for you rather than something you
have to ask for. Press the button again to pause it. Whether it is running
is saved with your settings, so a running loop resumes after a refresh and
a paused one stays paused. The status bar counts down to the next pass, and
**Auto-scan every N sec** sets the interval (minimum 10) - changing it
re-arms the loop immediately rather than waiting for the current gap.

Repeats are cheap: the per-player data is cached, so only the bazaar
listing is re-fetched each round unless a player's cache has expired.

### The results card

When a scan finds matches, a card appears in the bottom-right corner with
the actions for each one - **attack**, **bazaar** and **watch** - plus a
count and where they came from. The card is a port of the Bounty Hunter
toaster idea: the common case (see a target, attack it) never needs the
panel opened. **Open panel** jumps to the full table if you want it.

It stays until you dismiss it or the match list changes, so it will not
re-announce the same people on every background pass, and there is a switch
on the Scan tab to turn it off.

### Nothing is lost when you move around

Switching between the panel's own tabs only shows and hides them, so the
results, the item you were typing and the auto-scan interval all stay put.

Torn reloads the page when you move between *its* tabs, though, and that
used to take the whole result list with it. The last scan is now saved, so
going to the market and coming back still shows your shortlist - it is even
announced in the status bar. Stored results are **re-scored on the way back
in**, so what you see always reflects the filters you have now rather than
the ones that were set when the scan ran.

Only the totals are kept, not the raw API payloads or the item lists, which
works out at well under a kilobyte per seller. The store is capped at 200
sellers and expires after 12 hours.

#### It only ever shows you new names

A repeating scan is only useful if it surfaces people you have not seen.
Every seller a scan looks at is recorded, and **the next pass skips them
completely** - no FFScouter call, no Torn request, no row. So a pass over an
item you have been watching returns only the sellers who have appeared
since, and the results table accumulates those new names rather than
repeating the same ten.

Only the players a pass actually **dealt with** are recorded as checked -
those it looked up, and those the strength screen rejected. Anyone who
passed the screen but did not fit in that pass's lookup budget stays unseen,
so the next pass picks up where the last one left off. Marking the whole
candidate list as checked is what used to stall a scan: the screen would
pass a hundred sellers, a handful would get looked up, and the rest were
recorded as "already searched" without ever being looked at.

If a pass finds nothing new it says so and leaves your existing results on
screen instead of blanking the table. The memory expires after
**Re-check a player after (days)** (7 by default) so the list cannot grow
forever and you still see a player again eventually, and **Forget checked
players (N)** in the Scan tab clears it on demand when you want a full pass.

The record for each player is one packed string - fair fight, battle stats
estimate and the day it was seen, each in base36:

```
"c.h6.ri"   fair fight 1.2 · stats ~1.5m · seen 1,020 days in
```

That is **7 characters per player against 57** for the equivalent
`{fairFight, bsEstimate, at}` object, so a few thousand players cost tens of
kilobytes rather than a few hundred. Stats are stored as magnitude to about
1%, which is fine for a threshold comparison but not so coarse that it could
flip one.

Under **Other ways to pick targets** you can still scan the sellers linked
on the current page, or paste specific player IDs. You can also re-score
the last scan instantly from cache after changing a filter.

### Where the seller list comes from

Two sources, both data rather than markup:

1. **Torn's own API** (`market/{item}`, `selections=bazaar`) is always tried
   first. It is authoritative, live, and needs no third party.
2. **weav3r.dev**, a community bazaar scanner, is used when Torn lists
   nothing. Only the item id is sent - never your API key. It can be
   switched off entirely in **Advanced settings**, and then the script uses
   Torn alone.

### Spending the API budget sensibly

The three sources are not equally expensive, and the order they are used in
matters more than anything else for how many players you can actually check:

| source | cost | answers |
| --- | --- | --- |
| weav3r | free, no key | who is selling, price, quantity, names |
| FFScouter | one call per ~60 players, 20/minute | how strong each one is |
| Torn | **one call per player, 100/minute** | everything else |

**Every source is asked and the answers are merged.** The community
scanner's endpoint accepts a maximum of 100 listings; asking for more is
refused outright with a 403 and no data. That request used to fail quietly,
so every scan fell back to Torn's own short list - around ten sellers for a
common item - and gave up with "all 10 have been checked" as though that
were the whole market. It now asks for 100 (ten times the list you were
getting) and a refusal is reported rather than swallowed.

The scanner's `limit` is the one request parameter to be careful with: it
accepts a maximum of 100 and refuses anything larger, so a mistake here
means the scanner quietly contributes nothing at all. This used to stop at
the first source that produced anybody, so a short list from Torn ended the
search - ten sellers meant the scanner, which knows of far more, was never
consulted. Now Torn's own listing, its v2 listing and the community scanner
are all merged by player id, so an item like Xanax gets the union rather
than whichever source happened to answer first.

Torn's own market request asks for **bazaar and item market listings
together**. Torn renders item market listings anonymously, so most carry no
seller to look up - but when one is named it is used rather than silently
ignored, and the scanner is consulted for the sellers Torn will not name.

### Page scans are priced too

Scanning the sellers on a page used to leave them unvalued, because a page
has no item context. On the item market and item pages the URL carries the
item id, so the script now uses it: it fetches that item's listings and
prices the sellers it found on the page from them.

That is what makes someone selling through the **item market** work. They
have no bazaar entry to look up, but their listing for the item does, so
they get a price and a profit figure like anybody else.

So nothing reaches Torn until the cheap sources have had their say. A scan
screens every candidate on FFScouter first (a handful of requests for a few
hundred sellers), discards everyone the strength filters already rule out,
and only then spends Torn lookups on the survivors - ordered so that if the
rate limit does bite, the best prospects have already been checked. On a
typical popular item that turns 300 per-player lookups into a few dozen.

Players the screen ruled out are **still shown**, labelled
`screened out: fair fight 9.40`, with their unread columns marked
"not checked" rather than pretending their bazaar is empty. Skip the Torn
lookup, never the truth about why.

### Watchlist

The players worth attacking are often the ones who are not there yet. The
**Watch** tab holds anyone who is abroad or locked up with a known release
time, and re-checks them as their time comes up - so when they land or are
discharged they are already listed, by name, with an attack link.

A watched player is re-checked as their time comes up, and **somebody who
has already come back is still checked on a slow cycle** - a player who is
hospitalised again must stop being flagged as back, and that could never
happen while ready entries were dropped from the loop entirely.

**A foreign hospital is still abroad.** Being discharged abroad means being
out of the country, not reachable, so the row says `4m (still abroad)` and
no attack link appears. Only somebody actually standing in Torn counts as
back.

They get there automatically: any scan that finds someone freeing up within
the window (30 minutes by default) adds them. You can also press **watch**
on any result row to add someone by hand. The tab is labelled `Watch · 2`
with a dot when people are back, and the status bar announces it.

Watch entries cost one Torn request each, and only when their time is
nearly up - so a list of twenty players is not twenty requests a minute.

### The opener and the panel

The opener is a button built to live in Torn's own footer bar, alongside
the channel icons. It copies the `className` of Torn's `notes_panel_button`
and slots in as a sibling, so Torn's own stylesheet draws it and it lines up
with the rest instead of floating over them. A match count sits on its
corner. If those furniture buttons are missing (Torn PDA, or a layout
change) it falls back to a small square in the corner so it always works.

The panel can be **dragged by its header** and **resized from the corner
grip**, and both are remembered. The Tampermonkey menu has a reset for the
opener and panel geometry if you park it somewhere unhelpful.

## Rate limits

Torn allows 100 API requests per minute per key and FFScouter allows 20 per
minute per IP, so on a busy page you will sometimes hit the ceiling. When
that happens the script parks every request, shows a live countdown in the
status bar ("Rate limit reached - resuming in 42s") and then **carries on
by itself** where it left off. The player that triggered the limit is put
back in the queue rather than dropped. If it is still saturated after a
couple of waits it stops and tells you which knob to turn.

## The filters

Every filter is a switch plus a value, so you can enable, disable and
retune any of them without editing code. Seven of them cover the decision:

**Where they are** - in Torn and not abroad, not hospitalised or jailed,
a maximum time since their last action, plus two "soon" exceptions:
**Or landing within N minutes** and **Or released within N minutes**.
These let abroad/travelling and hospital/jail/federal players through when
they are nearly back, which is exactly who you want to be waiting for.
Their row shows the countdown ("lands in 4m", "out in 3m") and they score
slightly below someone standing there right now.

**What they are carrying** - a minimum bazaar buy-out value, and the
property vault setting with three positions: ignore, skip vault owners, or
only vault owners. Plus **Predicted loot at least**.

### What is on sale

The money that moves is **what you would spend buying the item you searched
for from that seller**: their price times their quantity. That figure is
what the value filter and the profit estimate both use - and it is the only
thing they use.

A seller's bazaar usually holds plenty of other stock, and none of it is
allowed into the maths. The value comes from the listing that found them, or
failing that from **that item's own line in their bazaar** - never the
bazaar total. Searching a different item, or the same seller's different
item, gives a different figure, which is the point.

A **page scan** has no item context, so no profit can be claimed for it. It
still shows their bazaar, clearly labelled as that, and leaves the profit
column empty with "no item selected" rather than inventing one. Use the item
picker when you want a profit figure.

It comes from the listing that found them - the market listing, or the
scanner's bazaar entry - not from a second lookup of their whole bazaar.
That matters because a bazaar lookup frequently comes back empty for
someone selling through the item market, and scoring them on it read as
"they have nothing" when they were plainly selling thirty of the thing.

**Another player's cash is never visible to any key**, so the script does
not ask for it, does not show it, and does not guess at it. A mug is
computed against the cash you hand over by buying, which is the only part
that can honestly be known.

Torn has more than one way of packing a bazaar into the response, and all
of them are read: a list of rows, a map keyed by item id, and rows whose
listing details sit one level down from the seller. Whatever the shape, the
price and quantity are found if they are in there.

A seller row with **no** price or quantity anywhere cannot be valued, and is
reported as unknown - never as `$0`. That combination - a real player id
with no price - is what used to render as `null x` and value a seller at
nothing. A sample of any such rows is kept for diagnosis.

When Torn declines to send a bazaar at all - the request ladder narrows
past that selection - the row says **"bazaar not read"** rather than
`$0 on sale`. An absent bazaar and an empty one are different facts, and
reporting the first as the second is what made a seller holding eighteen
pangolin scales look worthless. Payloads with no bazaar are also kept out
of the response cache, so one degraded reply cannot poison the next
fifteen minutes of scans.

### Net profit

Each seller gets a **Net profit** figure, and it is the number to filter and
rank on. The arithmetic, in the order it happens:

```
difference per item   market value  -  their price
total difference      difference per item  x  quantity
net profit            total difference  +  what the mug returns
```

Buying under the market value gains on every item; buying over it loses on
every item. The mug is what offsets your outlay: Torn rolls 5-10% of the
cash you hand them, and the figures below use the likely roll, 6.5%.

Worked through:

| 18 x 205,000 at market | 18 x 184,500 (10% under) | 1 x 5m (4m market) |
| --- | --- | --- |
| difference +0/item | +20,500/item | -1,000,000/item |
| x 18 = +0 | x 18 = +369,000 | x 1 = -1,000,000 |
| mug +239,850 | mug +215,865 | mug +325,000 |
| **net +239,850** | **net +584,865** | **net -675,000** |

Overpaying comes out negative on its own, which is why there is no separate
market-percentage rule any more.

**The score is signed.** A profitable seller scores 0-100 on the blend of
safety, profit, stock and availability; a losing one scores **below zero**,
so a seller who costs you money can never outrank one who breaks even. The
size of the negative reflects how bad the loss is. The default floor is
**0**, meaning "anything that actually turns a profit"; a positive floor
would hide modest-but-real wins like thirty items at 40k.

**What a bought item is really worth to you** (Setup) scales the market
value. It is 1 by default, meaning the full going rate; set it lower if you
cannot shift goods without undercutting.

**How strong they are** - a maximum fair-fight score, and their estimated
stats against yours with a multiplier (`1.0` means "no stronger than me").
If you have not loaded your own stats, this filter fails loudly rather than
silently passing everyone.

Everything else - cash on hand, item counts, "worthy" items, under-market
deals, an absolute stat ceiling, unknown-stat handling, a minimum score,
faction and level exclusions - lives in the collapsed **Advanced filters**
block directly underneath. Same controls, out of the way until you want
them.

Two notes on how this behaves honestly rather than conveniently:

* Torn hides other players' cash on many key types. When cash is hidden the
  money filter is treated as *unknown* and passes, because rejecting on a
  number you were never given would empty the shortlist for no reason.
* Vault detection reads the property payload and looks for any vault
  signal. If the API exposes no signal at all the result is "unknown", not
  a confident "no vault" - the `require` filter will reject those, the
  `exclude` filter will let them through.

**You are never scouted yourself.** Your own id is dropped from the page
list, and if the script does not know your id yet it looks it up first,
because your own bazaar page links it and mugging yourself is not a plan.

## Reading the results

Rows are colour-coded by verdict and sorted by scout score, a 0-100 blend
of how safe the target looks, how much cash they hold and how much stock
they carry. The Notes column states the actual reason a seller was
rejected rather than just greying them out, and each row links straight to
their profile, bazaar and attack page.

Every seller gets a row, including the ones that came back thin: if Torn
will not hand over a player's data the row still appears, under the name
the listing gave it, with the reason in the Notes column. A seller is never
shown as a bare "Player 1234567" when any name for them is known.

Results can be copied out as JSON or CSV.

## When something looks wrong

Torn has two API generations with different shapes: v1 merges every
selection into one flat object, v2 nests them. The script reads both, but
if a payload ever does not look like either, it does not quietly report
"nothing found" - the last unexpected response is kept and shown verbatim
under **Setup → Advanced settings → Last unexpected response**, with a
button to copy it. That is the thing to send on when a lookup misbehaves.

## The profit estimate

`Copy JSON` includes a rough profit model based on the buy-mug loop: buy
their stock, mug back the cash you just handed them, keep the goods. It is
shown in the tooltip of the results column too.

**The mug side follows the game's current rule, not the old curve:**

```
5% - 10% of the target's cash on hand, rolled at random with the low end
favoured: 6.5% is the middle of the curve, 10% is rare.

Masterful Looting     +5% a point, up to +50% at 10/10
Plunder weapon        +20% to +49% on top of that
```

Torn's patch #115 dropped the old `23 - ln(cash)` curve in 2019 and replaced
it with that flat band, so the rate no longer shrinks as the target gets
richer: a billionaire gives up 5-10% like anyone else. An older spreadsheet
still using the log curve underestimates a big mug by roughly five times.

The rate is a **roll**, so the tool never pretends to know it exactly. It
shows the band - the worst, likely and best case - for whatever sum you hand
over, and every figure is computed live:

| | buy at 4m (market) | buy at 5m (25% over) |
| --- | --- | --- |
| spend | 4,000,000 | 5,000,000 |
| mug returns (5% low / 6.5% likely / 10% high) | 200k / **260k** / 400k | 250k / **325k** / 500k |
| goods worth | 4,000,000 | 4,000,000 |
| **net** | **+260,000** | **-675,000** |

The mug is worked out on **what you pay**, not on the seller's balance - their
cash is private, and the money you hand over is the part of it you can count
on. Buy-mugging works precisely because that money lands on top of any mug
protection they are carrying.

Overpaying does not shave the profit, it turns it into a loss - which is why
the price rule is on by default at 100%.

**Mugging merits and a Plunder weapon** are typed into Setup rather than read
from your key. The API returns merits as numbered entries with no names
attached, so there is nothing to match "Mugging" against. Each Masterful
Looting point adds 5% to the take, and a Plunder weapon adds up to 49% on
top of that - but no bonus makes a bad price good.

The mug bonus figures are yours to type in rather than guessed for you, and
the market value of an item is taken from the listing itself.

The script spaces Torn calls out (default 700 ms apart, capped at
90/minute) and batches all FFScouter lookups into one request, so a page of
40 sellers costs 1 FFScouter call and 40 Torn calls. Player data is cached
for 15 minutes by default.

## Development

```sh
npm install          # jsdom, only needed for the UI test
npm test             # 155 tests
npm run test:core    # logic tests only, no dependencies
```

`test/core.test.js` covers harvesting, status classification, vault
detection, bazaar maths and every filter rule, and needs no dependencies.
`test/ui.smoke.test.js` loads the script into a real DOM with Torn-shaped
markup and canned API responses, then drives an actual scan through the
buttons; it skips itself if jsdom is not installed.

To verify something against the live APIs, the two endpoints the script
depends on are:

```sh
curl "https://ffscouter.com/api/v1/get-stats?key=KEY&targets=1,2,3"
curl "https://api.torn.com/user/1?selections=profile,basic&key=KEY"
```

## Licence

**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).**

This is free software: you may use, study, share and modify it, with no
charge. It comes with **no warranty**. The full text is in
[LICENSE](LICENSE).

The AGPL is the strongest copyleft licence in common use. It is GPL-3.0
plus a clause that closes the network loophole: anyone who redistributes
this script, **or runs a modified version of it as a network service**,
must release their source under the same terms. In short - take it, change
it, share it, but what you build on it stays free for everyone else too.

If you use this in your own project, keep the copyright notice and the
licence with it.
