# TODO: who is working on what

The single list of open, claimed and finished tasks. Humans and agents both use it.

## Claim before you touch a task

1. **Pull first.** Run `git pull` (or `git fetch origin` and read `origin/main:TODO.md`). Never trust your local copy.
2. **Pick an `[open]` task.** If it's `[working]`, it belongs to someone else: pick another one, or ask that person.
3. **Claim it and push right away,** before writing any code. Change the line to `[working]` and fill in who, branch and time. Commit only `TODO.md` with the message `claim: <ID>` and push it straight to `main`.
4. **If the push is rejected,** run `git pull --rebase` and read the line again. If someone else claimed it first, they keep it.
5. **When the work merges,** change the line to `[done]` and add the PR link. Do it in the same PR, or in a quick follow-up push.
6. **Found new work?** Add it as an `[open]` line in the right section. Don't start it without claiming it.
7. **Stale claims:** if a `[working]` line is over 2 hours old and its branch has no new commits, ask in the team chat before you take it over.

Line format: `[status] ID · task · owner · branch · since HH:MM PT`. Use one line per task, so merges rarely conflict. For an agent, write the owner as `agent: <session title> (for <person>)`.

## In progress

- [working] B-READBACK · Checkout read-back: say the total after tax and name the real button (Proceed to checkout vs Place your order); drop "I will not place the order" · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT
- [working] B-NARROW · Ask 2-3 clarifying questions, collect ~30 candidates per marketplace, narrow to 3 with a Jev-shaped picker (Claude Haiku stand-in), then review synthesis · merged in [PR #12](https://github.com/Rum1324/Visy-shopping-assistant/pull/12), waiting for Sota to check it in Chrome before done · agent: Run latest demo (for Sota) · b/narrow
- [working] DOCS-ARCH · Architecture flow diagram · agent: Architecture flow diagram (for Sota) · branch unknown · since 16:40 PT
- [done] B-REVIEWS-FIRST · Picker reads ~6 finalists' pages and reviews before choosing the 3; quick reads, full reviews for the final 3 only. On by default with a 9 s cap; live it adds ~5-9 s (`VISY_REVIEWS_FIRST_MS=0` turns it off) · agent: Reviews before picking (for Sota) · [PR #31](https://github.com/Rum1324/Visy-shopping-assistant/pull/31)
- [done] D-APIFY-FAST · Outside reviews per product: one Google run with a "<product> review" query per option (late results re-summarize that option), Reddit through Google (the Reddit actor timed out on every run), no YouTube actor, hedge slow Google runs, no second 25 s Apify pass · [PR #29](https://github.com/Rum1324/Visy-shopping-assistant/pull/29)
- [done] D-APIFY-BUDGET · Shortlist pitch = retailer only; Apify Reddit/YouTube/articles in background on shortlist; follow-up "more info"/external uses externalReviews · agent: Apify budget (for Pixl) · [PR #32](https://github.com/Rum1324/Visy-shopping-assistant/pull/32)
- [working] B-PRICE-FILTER · Put the budget into each site's search URL (Amazon, Walmart, Target price filters) and say plainly when nothing is in range instead of re-reading the same picks · agent: Price filters (for Sota) · claude/price-filters-808483 · since 02:50 PT
- [done] B-USUAL · "I'm out of sugar, get the usual": recall picks the item named (keyword match, not the first saved usual), "add it" goes through to cart and checkout read-back, and a real Amazon sugar product (B01JA9KAOM) is seeded in Convex · agent: Demo video plan (for Sota) · pushed straight to `main`

## Open

- [done] A-STT · Hands-free voice: mic on by default, live transcript in the input box (Cartesia /stt/turns), listen/stop tones, mute stops the track, barge-in · [PR #20](https://github.com/Rum1324/Visy-shopping-assistant/pull/20)
- [open] LIVE-1 · Full live run on `main` in real Chrome: picnic blanket → shortlist → under $20 → review question → add → checkout read-back → yes, with no order placed
- [open] C4 · Variants (size, color, quantity), filters, sort, and the checkout read-back flow on Amazon (`navigator/sites/amazon.ts`)
- [working] B-PRELOAD · Agent calls C1b `flow.preload()` as soon as the shortlist is final (check whether the tool loop already does) · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT
- [working] C-WMT-CART · Walmart add to cart and cart read-back. Search and detail are live (PR #16); a Walmart add still goes to the mock and returns not_found · agent: Multi-item cart tests (for Sota) · claude/multi-cart · since 23:02 PT
- [open] D-PAGEQA · Answer "what's on this page?" over the C5 `PageState` capture
- [working] C-MULTI · Several items (and quantities) in one cart, and choosing a color/size variant before adding, on Amazon, Walmart and Target; covers the variant + quantity part of C4 · agent: Multi-item cart tests (for Sota) · claude/multi-cart · since 23:02 PT
- [done] A-VOICE · Yes: voice-only works with no clicks (mic on by default; only Chrome's one-time Allow, which mic.html asks for on open) · [PR #20](https://github.com/Rum1324/Visy-shopping-assistant/pull/20)
- [open] DEMO · Feature freeze and rehearsal (H+14); warm `RecipeCache` and picker memory before going on stage

### From team testing (Slack, Oct 24)

- [working] B-RELEVANCE · Keyword search returns related-but-wrong products (e.g. "avocado" → avocado oil); pass scraped candidates through Claude and keep only real matches before narrowing · yujielee · agent: Relevance filter (for Pixl) · cursor/b-relevance · since 01:08 PT
- [working] UX-LEN · Spoken replies are too long; each option takes too long to read. Decide how much to say per turn (Alexa as a benchmark) · Yuka, Sota · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT
- [working] UX-FORMAT · Present the 3 options like a normal store: names and prices first, then pros and cons for each · yujielee · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT
- [open] UX-OPT3 · Bug: the agent only presents up to Option 2, not all 3 · Yuka
- [done] UX-FOLLOWUP · Bug: a question that cuts off the picks ("is the last one really $165?", "describe them") got "I don't have any results yet" and a new search; the picks now go into the session before they're read, and late details still land · Sota · agent: Fix presented results context (for Sota) · [PR #27](https://github.com/Rum1324/Visy-shopping-assistant/pull/27)
- [done] UX-BUDGET · Bug: after a $100 budget, "a little more expensive, the premium ones" searched up to $150 and read $119.99 picks. A follow-up search now keeps the stated cap unless the user names a new amount; "premium" sets a price floor (`budgetMinCents`) instead · Sota · agent: Run latest demo (for Sota) · pushed straight to `main`
- [done] UX-NEAR-BUDGET · Bug: "a $100 keyboard" came back as $19.99, $22.84 and $27.03. With only a cap, narrowing now picks from its top half ($50–$100) when at least 3 options are there, and the picker is told cheaper isn't better by itself · Sota · agent: Run latest demo (for Sota) · pushed straight to `main`
- [done] UX-CROP · Part of UX-LEN: the per-option lines after the names-and-prices overview repeated every price and compared a pick with itself ("costs the same as the best match pick at $44.99"). They're now one sentence, at most 16 words, with no prices; a longer one falls back to a short template · Sota · agent: Run latest demo (for Sota) · pushed straight to `main`
- [working] UX-CUT · Text is cut mid-word (the caption shows "Picnic Blank / et"). Check whether it's caption wrapping or how TTS chunks the text · Yuka · agent: Caption word wrap (for Sota) · b/feedback · since 20:48 PT
- [working] UX-ASK-FIRST · Ask clarifying questions before searching · Sota (shipped in B-NARROW / PR #12; now one question at a time) · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT
- [open] UX-NARROW · Decide how to handle the 3 narrowing/filtering options · Yuka
- [open] UX-ASK-END · End every turn by asking the user a question · Yuka
- [working] UX-PROGRESS · Spoken progress when work takes over ~2 s, with varied lines ("searching Amazon now", "comparing results from Walmart"); "One moment" is too repetitive · Yuka, Sota, yujielee · agent: Run latest demo (for Sota) · b/feedback · since 20:36 PT
- [done] B-HISTORY · Follow-up searches ("make it black") keep the last search's budget and needs · [PR #20](https://github.com/Rum1324/Visy-shopping-assistant/pull/20)
- [working] A-SHOWPAGE · When recommending, open the top pick's product page on screen instead of staying on the home tab · Sota (open all 3 options as tabs, focus option 1) · agent: Run latest demo (for Sota) · b/feedback · since 20:16 PT


## Done

- [done] UX-PAUSE · Bug: after pausing voice, clicking the "type here" input resumes voice (audioCtx unlock ignored while paused) · yujielee · agent: Pause voice input bug (for yujielee) · [PR #26](https://github.com/Rum1324/Visy-shopping-assistant/pull/26)
- [done] C-TGT-CART · Target add to cart (Shipping, picker-chain Add to cart) and cart read-back with est. tax and total · [PR #24](https://github.com/Rum1324/Visy-shopping-assistant/pull/24)
- [done] C-TGT · Real Target search and detail flow · [PR #18](https://github.com/Rum1324/Visy-shopping-assistant/pull/18)
- [done] UX-PITCH · Bug: spoken option lines included the pitch model's self-corrections ("wait, correction: …") and wrong price math; the prompt now gets computed differences and a guard falls back to the template · agent: Clean pitch lines (for Sota) · [PR #25](https://github.com/Rum1324/Visy-shopping-assistant/pull/25)
- [done] D-UNBIASED · Unbiased review summary: drop loaded-language reviews before synthesis (ties to D-APIFY) · agent: Unbiased review summary (for Pixl) · [PR #23](https://github.com/Rum1324/Visy-shopping-assistant/pull/23)
- [done] UX-PROGRESS · Spoken progress after ~2 s of quiet, varied lines that fit the running tool ("Searching Amazon now", "Reading the reviews"), stops when the answer starts · first version in [PR #13](https://github.com/Rum1324/Visy-shopping-assistant/pull/13), `progress.ts` in [PR #21](https://github.com/Rum1324/Visy-shopping-assistant/pull/21)
- [done] C-WMT · Real Walmart search and detail flow (live walmart.com via `__NEXT_DATA__`; add to cart not covered) · [PR #16](https://github.com/Rum1324/Visy-shopping-assistant/pull/16)
- [done] B-INTEL · Track D review summary, accessibility answers and photo description feed the tool loop's product answers · [PR #11](https://github.com/Rum1324/Visy-shopping-assistant/pull/11)
- [done] D-MAIN · Track D on `main`: review synthesis, Moss review Q&A, photo descriptions, wired into the tool loop · [PR #11](https://github.com/Rum1324/Visy-shopping-assistant/pull/11)
- [done] A+B · Chrome side panel, Cartesia voice, conversation server · `561b7dd`
- [done] C1a · Moss embeds only the ~30 most plausible elements · `39bd8bd`
- [done] C1b · Preload the shortlisted product pages · `187df2f`
- [done] C1c · One Moss session per tab, in parallel · `0c8ac85`
- [done] B-CONVEX · "The usual" items stored in Convex · [PR #3](https://github.com/Rum1324/Visy-shopping-assistant/pull/3)
- [done] C2 · Amazon retailer reviews in `getDetail` · [PR #4](https://github.com/Rum1324/Visy-shopping-assistant/pull/4)
- [done] C5 · Capture the user's open tab as a `PageState` · [PR #5](https://github.com/Rum1324/Visy-shopping-assistant/pull/5)
- [done] B-LOOP · Claude tool loop with keyword fallback · [PR #6](https://github.com/Rum1324/Visy-shopping-assistant/pull/6)
- [done] A-CHROME · Drive the user's real Chrome through the extension by default · [PR #7](https://github.com/Rum1324/Visy-shopping-assistant/pull/7)
- [done] ENV · Shared server keys across worktrees · [PR #8](https://github.com/Rum1324/Visy-shopping-assistant/pull/8)
- [done] C3 · Product detail extraction with `RecipeCache` · [PR #9](https://github.com/Rum1324/Visy-shopping-assistant/pull/9)
- [done] D-APIFY · External reviews from Reddit, YouTube and articles via Apify · [PR #17](https://github.com/Rum1324/Visy-shopping-assistant/pull/17)
- [done] UX-SALES · Say explicitly when a product is on sale or has a deal · yujielee · agent: On-sale mentions (for Sota) · [PR #14](https://github.com/Rum1324/Visy-shopping-assistant/pull/14), follow-up [PR #22](https://github.com/Rum1324/Visy-shopping-assistant/pull/22)
- [done] B-PREFS-TEST · Test that preferences are really stored in Convex: favorite marketplaces and brands, what the user cares about (price, quality, shipping speed) · yujielee · agent: Preferences in Convex (for Sota) · [PR #15](https://github.com/Rum1324/Visy-shopping-assistant/pull/15)
- [done] UX-SPEED · Let the user adjust voice speed · yujielee · [PR #19](https://github.com/Rum1324/Visy-shopping-assistant/pull/19)
- [working] UX-SPEED-VOICE · Change voice speed by saying/typing it ("speak faster", "set speed to 1.5") · agent: Voice speed by prompt (for Pixl) · cursor/ux-speed-voice · since 04:38 PT
