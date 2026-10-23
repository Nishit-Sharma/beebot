# BeeBot friction log: building on Bee

We built BeeBot as a team. It's a Mac app that takes a processed Bee conversation from an Apple Watch and turns it into a plan, doc or checklist you can review and correct. Below is everything that slowed us down on the Bee side, in the order we hit it.

---

## 1. We couldn't show results inside Bee, so we had to build our own UI
**Severity:** High

- **What we tried:** We wanted BeeBot's output (a workshop plan, a checklist, a "keep or change this?" review step) to show up in the Bee app, so the whole loop stays on the Watch and phone.
- **What happened:** The Bee app has no way for a third-party app to display a document, a checklist or an accept/revise flow. The API's Threads endpoint takes text and file IDs and runs Bee's own agent. We found no documented way to post a reply as our assistant or to add custom UI. On top of that, Threads is preview-only, and the read-only eligibility check on our account returned `test_user_required`.
- **Workaround:** We built a local web app on the Mac (http://127.0.0.1:8767) with its own chat window, task list and review screens. That's the only reason BeeBot has a web UI. We also built a way to resume a task from a reply, but left it turned off because there's no supported way to deliver the question to the user in Bee.
- **Suggestion:** Let approved third-party apps render rich results and simple actions (accept, revise, check off) inside the Bee app, or at least post assistant messages into a thread. Open Threads to normal developer accounts.

## 2. MCP gives us Bee's data, not a way into Bee's agent
**Severity:** Medium

- **What we tried:** Connecting through Bee's MCP server, hoping Bee's own agent could call BeeBot's tools.
- **What happened:** The MCP server exposes Bee context to our app, and also write tools (facts, todos, threads). It doesn't let us register our own tools with Bee's agent. It's also localhost-only.
- **Workaround:** We read conversations with the official CLI library (`conversations.list` / `conversations.get`) and kept all the agent logic on the Mac. We only allow the read calls we need, since we didn't want BeeBot touching write tools it doesn't use.
- **Suggestion:** Document that MCP is data-only for now, or add a way to register outside tools with Bee's agent. Read-only scopes for MCP would also help.

## 3. Short recordings can vanish, and "recording" isn't "ready"
**Severity:** Medium

- **What we tried:** Recording a one-line request on the Watch and grabbing it right away from BeeBot.
- **What happened:** The recording light and the live transcript show up right away, but the conversation isn't usable until Bee finishes processing it. We learned that conversations under about 50 words can disappear instead of completing, so a quick one-liner was a bad test.
- **Workaround:** We wrote a 92-word sample request and only let BeeBot pick conversations that have finished processing. Anything not marked complete gets refused.
- **Suggestion:** Show processing status and the minimum length in the docs and the CLI, and say when a conversation got dropped.

## 4. The realtime stream is hard to build on
**Severity:** Medium

- **What we tried:** Using `bee stream --types new-utterance --json` so BeeBot could follow a conversation as it changed.
- **What happened:** Events come in without an event type field, a stable utterance ID or a capture timestamp. Delivery is at most once, so anything sent while our app was offline is lost. The sync export doesn't help with that either, because incremental sync doesn't report deletions.
- **Workaround:** We use stream events only as a hint to re-read the parent conversation through `conversations.get`. Follow is capped and polls at most once a minute. We don't treat duplicate text as the same utterance.
- **Suggestion:** Add event types, utterance IDs and timestamps, a resume cursor for missed events, and deletion events in incremental sync.

## 5. No way to host it for other people
**Severity:** Medium (for what's next)

- **What we tried:** Figuring out how BeeBot could keep working when our laptop is off, or work for someone else.
- **What happened:** The API uses a personal bearer token from `bee login`. The docs say `bee proxy` gives unauthenticated access and must stay local. We didn't find a third-party OAuth or sign-in flow in the developer docs.
- **Workaround:** BeeBot is local-only and single-user, and it only runs while the Mac is awake.
- **Suggestion:** An OAuth flow with scoped, revocable tokens so third-party apps can connect a user's Bee without handling their personal login.
