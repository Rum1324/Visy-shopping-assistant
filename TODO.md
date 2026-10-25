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

- [working] B-NARROW · Ask 2-3 clarifying questions, collect ~30 candidates per marketplace, narrow to 3 with a Jev-shaped picker (Claude Haiku stand-in), then review synthesis · merged in [PR #12](https://github.com/Rum1324/Visy-shopping-assistant/pull/12), waiting for Sota to check it in Chrome before done · agent: Run latest demo (for Sota) · b/narrow
- [working] D-APIFY · External reviews from Reddit, YouTube and articles via Apify (`collectExternal`; needs an Apify token) · agent: Git remote list (for Pixl) · d/apify · since 19:12 PT
- [working] DOCS-ARCH · Architecture flow diagram · agent: Architecture flow diagram (for Sota) · branch unknown · since 16:40 PT

## Open

- [open] A-STT · Investigate speech-to-text: it looks broken and the mic button is missing from the side panel. Lead: `5dd71f1` simplified the panel to one send/stop control and may have dropped push-to-talk. Check `apps/extension/sidepanel.*` and the server's Cartesia `audio.end` path in `voice.ts`
- [open] LIVE-1 · Full live run on `main` in real Chrome: picnic blanket → shortlist → under $20 → review question → add → checkout read-back → yes, with no order placed
- [open] C4 · Variants (size, color, quantity), filters, sort, and the checkout read-back flow on Amazon (`navigator/sites/amazon.ts`)
- [open] C-TGT · Real Target search and detail flow (sample listings today)
- [open] C-WMT · Real Walmart search and detail flow (sample listings today)
- [open] B-PRELOAD · Agent calls C1b `flow.preload()` as soon as the shortlist is final (check whether the tool loop already does)
- [open] D-PAGEQA · Answer "what's on this page?" over the C5 `PageState` capture
- [open] A-VOICE · Decide whether voice-only must work with no clicks at all (motor-impaired users)
- [open] DEMO · Feature freeze and rehearsal (H+14); warm `RecipeCache` and picker memory before going on stage

## Done

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
