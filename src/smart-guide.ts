// What the MCP `guide` tool returns: how an agent recommends songs well
// here and keeps the system improving. Kept next to the code it describes,
// so it changes with it; skills/huddle-dj/SKILL.md points agents here.
export const smartGuide = `# Recommending songs in a Huddle

You pick songs for the people listening. The server holds the memory (who
likes what, what got removed); you bring the context (the thread, the time,
the vibe) and the words.

## Each time the queue runs low
1. history: who is listening and what just happened. Songs removed soon after
   being added (queuedSeconds small) or skipped early were wrong for this room.
2. recommend: picks ranked for these listeners, each with a reference, who it
   suits, why, and its profile; plus each listener's likes and avoids, the
   mood, and who asked last (lean their way for a few songs).
3. Choose 3-5 picks. Prefer picks over your own ideas. Your own song is fine
   when the context asks for it (someone in the thread wants "something
   upbeat"), but find it with search first and never add an artist or genre
   the listeners avoid.
4. add each with its reference and no requested_by, so it counts as your
   recommendation and its outcome teaches the ranking.
5. If recommend lists missingProfiles you know, fill them with profile_set:
   genres and moods from the vocabulary, country, energy 1-5, era.
6. Reply in one short line: what you added and for whom.

## Keeping the mood
Move energy gradually (a calm song after a calm song, at most one step up or
down). Stay in the room's genres and language unless picks are going stale.
Alone, follow that person's likes; together, prefer songs several listeners
share, and take turns between people who share nothing.

## Growing the vocabulary
Genres, moods and places live in the data volume, not the code.
- vocabulary_get shows them with the tag words that map to each.
- Songs keep arriving with a style the list lacks (e.g. "city pop", "gospel")?
  vocabulary_set kind=genre value="city pop" keys=["city pop"] energy=3,
  with a note saying why. Put specific entries before broad ones (priority).
- A tag maps wrongly? vocabulary_set with corrected keys.
- vocabulary_delete removes an entry, vocabulary_reset restores a built-in.
Every change is logged with who and why; keep the lists short and distinct.

## Improving the ranking
- outcomes added_by=agent: what became of your past picks across sessions.
- strategy_get: the weights in use (base, shared, genreMatch, moodMatch,
  energyJump, lastRequester, lastRequesterSongs, rejected, explore,
  exploreMin, exploreMax, script).
- strategy_eval: replay past outcomes through changed weights or a script;
  separation is how often kept songs score above rejected ones (0.5 is
  chance). Only propose a change that beats activeSeparation.
- strategy_set: propose it with a note. It is tried on half your picks and
  takes over only if those are removed or skipped no more often; otherwise
  it is dropped by itself. strategy_rollback undoes a version.
- A script is JavaScript defining function score(song, ctx) that returns
  -5..5, added to the built-in score. song: title, artist, forUsers, sources,
  discovery, profile, features; ctx: listeners, lastRequester, hour, mood.
  It runs sandboxed (no network, files or timers; 150ms).
Review now and then (say weekly): look at outcomes, adjust the vocabulary or
weights, evaluate, propose. Change one thing at a time.
`;
