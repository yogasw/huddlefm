# Smart recommendations

Agents connected over MCP (see [bot-api.md](bot-api.md)) can pick songs with
the server's memory instead of guessing.

- **Outcomes**: every song that plays out, is skipped or is removed is stored
  with who added it, who acted and who was listening. Taste per person comes
  from these, so nobody has to link an account (linked Last.fm/ListenBrainz
  accounts still help).
- **Song profiles**: genres, moods, country, language, energy and era, from
  Last.fm tags and MusicBrainz, or filled in by the agent (`profile_set`).
- **Vocabulary**: the genres, moods and places profiles use, with the tag
  words that map to each. Seeded with defaults into the data volume
  (`song_vocabulary`); agents add, change or remove entries over MCP and
  every change is logged. New defaults from later versions are added without
  touching edited ones.
- **Strategy**: bounded ranking weights plus an optional scoring script that
  runs in a QuickJS sandbox. Proposals are replayed on past outcomes, tried on
  half of the agent's picks, and take over only if they do no worse.

`LASTFM_API_KEY` (an app key, free at last.fm/api) enables tags and similar
tracks. Agents should read the MCP `guide` tool; `skills/huddle-dj/SKILL.md`
is a ready skill that points to it.
