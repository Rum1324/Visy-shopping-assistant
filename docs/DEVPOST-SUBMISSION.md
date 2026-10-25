# Visy: Shop at the speed of your voice

**Elevator pitch (164/200):** From hundreds of links read aloud to one conversation. Visy asks what you need, compares stores, sums up reviews and photos, and stops at checkout so you press buy.

---

## Inspiration

Technology has made our lives richer, but its cutting edge has always assumed you can see. Captions and transcription opened doors for deaf people, while the 43 million blind people worldwide (GBD 2019, *The Lancet Global Health*) are being left behind.

Online shopping is where this hurts most. A screen reader reads a page built to be looked at, one item at a time. On an Amazon search page, you listen through every filter, sponsored result, badge and hundreds of links before reaching a real product. Reviews hide behind "See more", and photos are announced as just "image". Comparing prices, sizes and reviews means holding every detail in memory. Most AI shopping agents don't help either: they run cloud browsers that hit CAPTCHAs, miss the deals and reviews you only see when signed in, and can't take you to your own checkout.

So we asked: what if you had a salesperson who knows every product in the world and is always on your side? You tell it what you need. It asks a few questions, compares stores, tells you what reviewers say, describes the photos, and takes you to the store's own checkout. Then it stops, and you press the final button yourself.

**Visy** closes that gap: a world where anyone can choose and buy for themselves, without needing to see.

## What it does

**Visy** is a voice-first shopping assistant for blind and low-vision shoppers: a Chrome extension with a server "brain". Its median response time is under 400 ms, about the time it takes to blink twice.

- **Just talk.** Ask Visy the way you'd ask a salesperson. It's built for the ear: three options, one sentence each, then a quick recap. Interrupt anytime, adjust the speaking speed (up to 3×), and hear progress updates and live deals, so you always know what's happening.
- **Find it together.** Talk through size, color, budget and what matters to you. Visy searches the stores you choose, like Amazon, Target and Walmart, and suggests three options: **best match**, **best value** and **most trusted by buyers**, covering key features, reviews, and easy-to-miss details like how a product looks.
- **Ask anything.** "Is the strap adjustable?" "What does it look like?" "What do people on Reddit say?" Answers come from store reviews, Reddit, YouTube, articles, and a description of the product photo.
- **You decide.** Visy gives pros and cons, cites its sources and weighs your priorities, but never decides for you. Checkout happens on the store's own confirmation page, and **Visy never presses "Place your order". You do.**
- **"Order the usual."** Visy remembers your past purchases and preferences.

## What makes Visy different

- **Speed.** Compared to screen readers, Visy condenses shopping into one fast, guided conversation. Compared to other AI agents, our Moss-powered navigator picks a click in ~4 ms instead of the ~1.2 s a Claude call takes.
- **Always current.** Visy reads the live page in your own browser, so prices, deals, product details and reviews are always up to date. Innosearch (in Be My Eyes), the closest tool built for blind shoppers, sometimes shows outdated information.
- **Visual aid.** Image recognition plus review synthesis tells shoppers what a product looks like, something screen readers can't do when it isn't in the description.

## How we built it

<!-- TODO: arrowed pipeline diagram (based on slide 2, with more steps) -->

Most agents wait about a second for an LLM on every click. We put **Moss**, a local search index that answers in milliseconds, in front of Claude. The principle: try the cheapest step first.

1. Shortcut URLs and fixed extraction rules (no AI).
2. **Moss memory** of past successful clicks (~5 ms).
3. **Moss hybrid search** over element text (~4 ms per query).
4. **Claude Haiku 5.5** picks from the element list (~1.2 s), and its answer is saved to memory so the same step is free next time.

### Navigation with Moss

- **Every click is a search.** The page's buttons are the index and the step ("Add to Cart") is the query: 4 ms with Moss vs 1.17 s with Claude. Moss scores each element with a weighted mix of meaning and keywords, and we only trust its top pick when it clearly beats the runner-up:

$$\text{score}(e) = \alpha\, s_{\text{sem}}(e) + (1-\alpha)\, s_{\text{kw}}(e),\quad \alpha = 0.2 \qquad \text{trust} \iff \text{score}(e_1) - \text{score}(e_2) \ge 0.1$$

  Leaning toward exact words (α = 0.2) cut confident wrong clicks from 5 to 0. Claude only steps in when there's no clear winner.
- **Memory.** When Claude picks a button, Moss saves it. A warm Amazon run went from **11.3 s to 3.4 s with zero Claude calls**.
- **Recipe cache.** The first time Visy sees a product page type, Claude reads a trimmed HTML outline and writes CSS selectors for ~15 fields (price, deal, Prime, specs, variants, images…). Later visits reuse them with no model: **5.4 s → 47 ms**.
- **Preloading.** While Visy reads out the three options, their pages load and get indexed in background tabs. Opening one and adding it to cart drops from **2.4 s to 0.9 s**.

### Product intelligence

- Claude summarizes store reviews plus outside reviews from **Apify** (Reddit, YouTube and Google articles, three actors in parallel), after filtering out over-the-top hype and rage reviews.
- Moss indexes every review by meaning, so "waterproof?" matches "stayed dry in the rain" in 3–6 ms.
- Claude's vision describes the product photo.

### Voice and memory

- **Cartesia** handles speech-to-text and text-to-speech on the server, so the extension holds no keys. Cartesia's speed tops out at 1.5×, so above that we time-compress the audio with WSOLA, which keeps the pitch.
- **Convex** stores the shopper's profile and purchases. For "order the usual seaweed", Moss searches your saved items by meaning, finds your nori snacks, and Visy offers to add them to your cart.

## Challenges we ran into

- **Bot walls.** Walmart and Target blocked or emptied our automated browser after one page. Moving the agent into the user's real Chrome fixed this, and also unlocked Amazon reviews only visible when signed in.
- **Confident wrong clicks.** With Moss's default weighting (α = 0.8), it was confidently wrong on 5 of 38 steps. Leaning on keywords (α = 0.2) plus the gap rule brought that to zero.
- **Making the UI audio-native.** We had to design audio alternatives that match or improve on visual shopping. Visy interviews the user about what they want, accepts interruptions, and never goes quiet for more than 2 s without a progress update. Claude turns product visuals into words.
- **Harness engineering for safety.** To protect users' payment information and prevent accidental purchases, a safety layer strips dangerous elements like "Place your order" before the navigator ever sees the page.

## Accomplishments that we're proud of

- Visually impaired users can shop as fast as, if not faster than, sighted users.
- They can learn what a product looks like and compare options side by side.
- A conversation loop with tight timing that minimizes waiting while multiple APIs run concurrently.
- Combining an LLM (Claude) with a retrieval engine (Moss) for speed neither achieves alone, without losing accuracy.
- **0 wrong clicks** on our 38-step benchmark across real Amazon, Target and Walmart pages.
- Small tricks that push performance to the edge:
  - Indexing while the page loads, without waiting for it to finish.
  - Preloading review synthesis for products the user is likely to ask about.

## What we learned

- **The smallest model that gets it right wins.** Haiku 5.5 got 38/38 picks right, the same as Sonnet 5.5, and was faster. Opus 5.5 declined to answer more often and took longer.
- **Use AI last, not first.** Shortcut URLs, saved selectors and Moss lookups do most of the work. Claude handles what's new.
- **In voice, speed and length are the experience.** More than ~4 s of silence feels broken, so Visy gives short spoken progress updates, and a screen-reader user wants fewer words, not more. But faster isn't always better: answering the instant you stop talking feels creepy.

## What's next for Visy

- **Checkout on every store.** Finish Walmart add-to-cart, and support sizes, colors and multiple items in one cart.
- **"What's on this page?" for any site.** Visy can already capture any open page; next, users can ask questions about it.
- **More kinds of shopping.** Categories that depend on looks, like clothing, where color, fit and style are hard to judge without seeing.
- **More stores**, so users can compare even more options.
- **Testing with blind and low-vision shoppers.** So far only our team has tested it; we'll measure how much time and effort it saves.
- **Faster decisions with Jev.** Swap in the Jev decision model where Haiku runs today; our picker is already built for it.
- **Mobile.** Bring Visy to phones with a cloud browser, on the same driver interface.
- **Public release.** Add a wake word and publish on the Chrome Web Store.
