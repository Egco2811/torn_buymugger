# Torn Buy-Mug Scout

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
a paused one stays paused. The status bar counts down to the next pass.

Repeats are cheap: the per-player data is cached, so only the bazaar
listing is re-fetched each round unless a player's cache has expired.

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
only vault owners.

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

## The profit estimate

`Copy JSON` includes a rough profit model based on the buy-mug loop: buy
their stock, mug back the cash you just handed them, keep the goods.

It is a model with knobs, not a promise. The mugging percentage, your
faction's cut and what a bought item is really worth to you are all
editable in Setup, and they are your assumptions rather than game
constants. Set them to match what you actually observe.

The script spaces Torn calls out (default 700 ms apart, capped at
90/minute) and batches all FFScouter lookups into one request, so a page of
40 sellers costs 1 FFScouter call and 40 Torn calls. Player data is cached
for 15 minutes by default.

## Development

```sh
npm install          # jsdom, only needed for the UI test
npm test             # 74 tests
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
