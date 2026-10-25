# Visy: Shop at the speed of sound

**Elevator pitch:** From hundreds of links read aloud to one conversation. Visy asks what you need, compares stores, sums up reviews and photos, and stops at checkout so you press buy.

---

## Inspiration

Shopping online with a screen reader means listening to a page that was built to be looked at. On an Amazon search page, you are forced to listen through every filter, sponsored result, badge, and hundreds of links before you reach a real product. Reviews are hidden behind "See more", and product photos are often announced as just "image". Most AI shopping agents don't help much either. They run a cloud browser that hits CAPTCHAs, can't see the deals and reviews that only show up when you're signed in, and can't take you to your own checkout.

We wanted a salesperson, not a screen reader. You tell it what you need. It asks a few questions, compares stores for you, tells you what reviewers say, verbalizes what's in the photos, and takes you to the store's own checkout page. Then it stops, and you press the final button yourself.

## What it does

Visy is a voice-first shopping assistant for blind and low-vision shoppers.

- Visy is voice-controlled, with a median response time below 400 ms, or the time it takes to blink twice.
- Visy asks questions that help it understand your needs, and you can interrupt it at any time. Within seconds, Visy narrows 30 candidate items to 3: best match, best value, and the one buyers trust most (best reviews).
- Like an in-person store clerk, it reads the name, price, and a short description of each item. Ask anything about an item, including what it looks like or what reviews on Reddit, YouTube, and blogs say.
- Visy never clicks checkout: our safety layer removes that button before the page reaches Visy's navigation handler.
- Visy remembers your purchase history and preferences, so vague, context-aware requests like "order my usual seaweed" work.

## What makes Visy different

- **Efficiency:** Compared to screen readers, Visy condenses shopping into one extremely fast, guided process. Compared to other AI agents, navigating with Moss beats Claude's typical pick latency.
- **Always current and complete:** Visy reads the live page in your browser, so prices, deals, product details, and reviews are always up to date. Innosearch (in Be My Eyes), the closest tool built for blind shoppers, sometimes shows outdated information.
- **Visual aid:** AI image recognition combined with review synthesis lets visually impaired users confidently learn what a product looks like. Screen readers can't describe visual features, especially when they aren't in the product description.

## How we built it, aka how we made it 4.6x faster than Claude

![How Visy works](https://raw.githubusercontent.com/Rum1324/Visy-shopping-assistant/main/docs/devpost-gallery/00-how-visy-works.png)

Most agents wait about a second for an LLM on every click. We put Moss, a local search index that answers in milliseconds, in front of Claude. The principle: try the cheapest step first.

- **Every click is a search.** The page's buttons are the index and the step ("Add to Cart") is the query. That takes 4 ms with Moss and 1.17 s with Claude. We tuned Moss's hybrid search toward exact words (α = 0.2), which brought confident wrong clicks from 5 to 0. Claude only steps in when Moss's top pick isn't a clear winner.
- **Memory.** When Claude picks a button, Moss saves it, so next time that step is a 5 ms lookup. A warm Amazon run went from 11.3 s to 3.4 s with no Claude calls.
- **Review Q&A.** Moss finds reviews by meaning, so "waterproof?" matches "stayed dry in the rain", in 3–6 ms.
- **"Order the usual seaweed."** Moss searches your saved items by meaning, finds your nori snacks, and Visy offers to add them to your cart.

**The browser agent always tries the cheapest step first:**

1. Shortcut URLs and fixed extraction rules (no AI).
2. A **Moss** memory of past successful clicks (~5 ms).
3. Moss hybrid search over the element text (~4 ms per query).
4. **Claude Haiku 5.5** picks from the element list (~1.2 s), and its answer is saved to memory so the same step is free next time.

Moss scores each element with a weighted mix of meaning and keywords, and we only trust its top pick when it clearly beats the runner-up:

$$\text{score}(e) = \alpha\, s_{\text{sem}}(e) + (1-\alpha)\, s_{\text{kw}}(e),\quad \alpha = 0.2 \qquad \text{trust} \iff \text{score}(e_1) - \text{score}(e_2) \ge 0.1$$

- **Recipe cache:** The first time Visy sees a type of product page, Claude reads a trimmed HTML outline and writes CSS selectors for about 15 fields (price, deal, Prime, specs, variants, images and more). Later visits reuse those selectors with no model at all: **5.4 s → 47 ms**.
- **Preloading:** While Visy is still reading out the three options, their pages load and get indexed in background tabs. Opening one and adding it to the cart drops from **2.4 s to 0.9 s**.
- **Product intelligence:** Claude summarizes the store's reviews plus outside reviews from **Apify** (Reddit, YouTube and Google articles, three actors in parallel), after filtering out over-the-top hype and rage reviews. Moss indexes every review, so follow-up questions are answered in about 10 ms. Claude's vision describes the product photo.
- **Voice:** **Cartesia** handles speech-to-text and text-to-speech on the server, so the extension holds no keys. Cartesia's speed setting tops out at 1.5×, so above that we time-compress the audio with WSOLA, which keeps the pitch.
- **Memory:** **Convex** stores the shopper's profile and purchases. Moss looks them up when you say "the usual".

## Challenges we ran into

- **Making the UI audio-native:** To meet the needs of visually impaired users, we had to design audio alternatives that match or improve on the usual online shopping flow. Visy actively interviews the user about what they want and accepts interruptions midway. It never goes quiet for more than 2 s, giving spoken progress updates so users stay informed instead of confused. Claude converts product visuals into understandable audio.
- **Harness engineering for safety:** To protect users' financial information and prevent accidental purchases, we added a layer that strips dangerous UI elements like "Place order" before handing control to our navigator agent.

## Accomplishments that we're proud of

- Visually impaired users can now shop as fast as, if not faster than, sighted users.
  - They can learn what a product looks like and compare options side by side.
- A cyclical conversation flow with tight timing that minimizes waiting while different APIs are called concurrently.
- Combining two tools for performance neither achieves alone: pairing an LLM (Claude) with a retrieval engine (Moss) boosted speed significantly while keeping accuracy.
- Subtle techniques that push performance to the edge:
  - Indexing while the page loads, without waiting for it to finish.
  - Preloading review synthesis for products users are likely to ask about.
  - Embedding only the 30 most plausible page elements instead of 150 (445 → 144 ms per page), and the right element survived the cut 38/38 times.
  - Starting outside-review searches the moment the query is known, in parallel with the store search.
  - Asking the next clarifying question in code, with no model call (~0.3 s).

## What we learned

- **The smallest model that gets it right wins.** Haiku 5.5 got 38/38 picks right, the same as Sonnet 5.5, and was faster. Opus 5.5 declined to answer more often and took longer.
- **Use AI last, not first.** Shortcut URLs, saved selectors and Moss lookups do most of the work. Claude handles what's new.
- **In a voice interface, speed and length are the experience.** More than about 4 seconds of silence feels broken, so Visy gives short spoken progress updates. A screen-reader user wants fewer words, not more.

## What's next for Visy: Shop at the speed of sound

- **Complete checkout on every store:** Finish add-to-cart on Walmart, and support sizes, colors and multiple items in one cart across all stores.
- **"What's on this page?" for any site:** Visy can already capture any open page. Next, users will be able to ask questions about it, not just about shopping sites.
- **More kinds of shopping:** Expand to categories that depend heavily on visuals, like clothing, where color, fit and style are hard to judge without seeing them.
- **Faster decisions with Jev:** Swap in the Jev decision model where Haiku runs today. Our product picker is already built to support it.
- **A mobile version:** Bring Visy to phones using a cloud browser, built on the same driver interface.
- **Public release:** Add a wake word and publish Visy on the Chrome Web Store.
