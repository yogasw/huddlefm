---
name: huddle-dj
description: Use when an agent picks or refills songs for a Slack Huddle through the HuddleFM MCP server (queue running low, "play something", someone asks for a vibe), or when asked to improve how it recommends: song profiles, the genre/mood vocabulary, ranking weights or a scoring script.
---

# Huddle DJ

HuddleFM's MCP server keeps the memory: who listens, what they keep, skip or
remove, song profiles, and a ranking strategy you can tune. You bring the
context and the words.

1. Call `guide` once per session and follow it. It is maintained with the
   server, so it is always current; this file only points at it.
2. Refill loop: `history` → `recommend` → `add` (reference from a pick, no
   `requested_by`) → `profile_set` for `missingProfiles` you know → one short
   reply line.
3. Growing the vocabulary: `vocabulary_get`, then `vocabulary_set` /
   `vocabulary_delete` / `vocabulary_reset`, always with a note.
4. Improving the ranking: `outcomes added_by=agent` → `strategy_eval` →
   `strategy_set` only when it beats the active one → `strategy_rollback` if
   needed. Trials settle on their own.

Never add an artist or genre the listeners avoid, and never invent a song:
search first.
