import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  SmartRecs,
  cleanSong,
  profileFromTags,
  runScoringScript,
  separation,
  validateWeights,
  type RankCandidate,
  type RankContext,
} from "./smart.ts";

const offline = (async () =>
  new Response("{}", { status: 404 })) as unknown as typeof fetch;

const make = (
  options: { random?: () => number; request?: typeof fetch } = {},
) => {
  let clock = 1_000_000;
  const smart = new SmartRecs(
    new Database(":memory:"),
    { lastFmApiKey: "key" },
    options.request ?? offline,
    { now: () => (clock += 1000), random: options.random ?? (() => 0.9) },
  );
  return smart;
};

const context = (change: Partial<RankContext> = {}): RankContext => ({
  sessionId: "s1",
  listeners: ["UALICE", "UBOB"],
  recent: [],
  hour: 20,
  ...change,
});

test("reads genres, moods, country and era from free-form tags", () => {
  expect(
    profileFromTags(["Indonesian", "pop", "galau", "2000s", "acoustic"]),
  ).toEqual({
    genres: ["pop", "acoustic"],
    moods: ["sad"],
    country: "ID",
    language: "id",
    era: "2000s",
    energy: 2,
  });
  expect(profileFromTags(["kpop", "dance", "happy"])).toMatchObject({
    genres: ["k-pop", "dance"],
    moods: ["party", "upbeat"],
    country: "KR",
  });
  expect(profileFromTags([])).toEqual({ genres: [], moods: [] });
});

test("an agent's profile is checked against the vocabularies", () => {
  const smart = make();
  expect(smart.setProfile({ title: "Song", artist: "Band" })).toMatchObject({
    ok: false,
  });
  expect(
    smart.setProfile({
      title: "Song",
      artist: "Band",
      genres: ["Rock", "polka", "pop", "indie"],
      moods: ["nostalgic"],
      country: "id",
      energy: 9,
      era: "late nineties",
    }),
  ).toMatchObject({
    ok: true,
    profile: {
      genres: ["rock", "pop"],
      moods: ["nostalgic"],
      country: "ID",
      energy: 5,
      source: "agent",
    },
  });
  expect(smart.profile("song", "BAND")?.era).toBeUndefined();
});

test("looks a profile up from Last.fm tags and MusicBrainz once", async () => {
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    if (url.includes("track.getTopTags"))
      return Response.json({
        toptags: {
          tag: [
            { name: "rock", count: 100 },
            { name: "nostalgic", count: 60 },
            { name: "90s", count: 40 },
          ],
        },
      });
    if (url.includes("musicbrainz"))
      return Response.json({ artists: [{ score: 100, country: "id" }] });
    return Response.json({ error: 6 });
  }) as unknown as typeof fetch;
  const smart = make({ request });
  const profile = await smart.ensureProfile("Song", "Band");
  expect(profile).toMatchObject({
    genres: ["rock"],
    moods: ["nostalgic"],
    era: "1990s",
    country: "ID",
    source: "lastfm",
  });
  await smart.ensureProfile("Song", "Band");
  expect(urls.filter((url) => url.includes("getTopTags"))).toHaveLength(1);
});

test("taste learns from what a person keeps, removes and skips", () => {
  const smart = make();
  smart.setProfile({
    title: "Calm",
    artist: "A",
    genres: ["acoustic"],
    moods: ["chill"],
  });
  smart.setProfile({
    title: "Loud",
    artist: "B",
    genres: ["metal"],
    moods: ["angry"],
  });
  for (let index = 0; index < 3; index++)
    smart.recordOutcome(
      { title: "Calm", artist: "A", addedBy: "UALICE", outcome: "finished" },
      context(),
    );
  smart.recordOutcome(
    {
      title: "Loud",
      artist: "B",
      addedBy: "agent",
      actor: "UALICE",
      outcome: "removed",
      queuedSeconds: 10,
    },
    context(),
  );
  const taste = smart.taste("UALICE");
  expect(taste.genres.acoustic).toBe(3);
  expect(taste.genres.metal).toBe(-1);
  // Bob only listened while Alice's song played out.
  expect(smart.taste("UBOB").genres.acoustic).toBeCloseTo(0.9);
});

const candidate = (
  title: string,
  artist: string,
  change: Partial<RankCandidate> = {},
): RankCandidate => ({
  title,
  artist,
  reference: `https://example.com/${title}`,
  forUsers: [],
  sources: ["similar"],
  discovery: false,
  rank: 0,
  ...change,
});

test("ranks for who is listening and keeps rejected genres out", async () => {
  const smart = make();
  smart.setProfile({
    title: "Kept",
    artist: "A",
    genres: ["pop"],
    moods: ["nostalgic"],
    energy: 2,
  });
  smart.setProfile({
    title: "Gone",
    artist: "B",
    genres: ["metal"],
    energy: 5,
  });
  smart.setProfile({
    title: "Fits",
    artist: "C",
    genres: ["pop"],
    moods: ["nostalgic"],
    energy: 2,
  });
  smart.setProfile({
    title: "Heavy",
    artist: "D",
    genres: ["metal"],
    energy: 5,
  });
  for (const user of ["UALICE", "UBOB"]) {
    smart.recordOutcome(
      { title: "Kept", artist: "A", addedBy: user, outcome: "finished" },
      context(),
    );
    smart.recordOutcome(
      {
        title: "Gone",
        artist: "B",
        addedBy: "agent",
        actor: user,
        outcome: "removed",
      },
      context(),
    );
  }
  const result = await smart.rank(
    [
      candidate("Heavy", "D", { rank: 0 }),
      candidate("Fits", "C", { rank: 1, forUsers: ["UALICE", "UBOB"] }),
    ],
    context({ recent: [{ title: "Kept", artist: "A" }] }),
    1,
  );
  expect(result.picks.map((pick) => pick.title)).toEqual(["Fits"]);
  expect(result.picks[0]!.why).toContain("suits several listeners");
  expect(result.listeners[0]).toMatchObject({
    id: "UALICE",
    likes: { genres: ["pop"] },
    avoids: { genres: ["metal"] },
  });
  expect(result.mood).toMatchObject({ genres: ["pop"], energy: 2 });
});

test("leans to whoever asked last, for a few songs", async () => {
  const smart = make();
  smart.setProfile({ title: "Hers", artist: "A", genres: ["k-pop"] });
  smart.setProfile({ title: "His", artist: "B", genres: ["jazz"] });
  smart.setProfile({ title: "More K", artist: "C", genres: ["k-pop"] });
  smart.setProfile({ title: "More Jazz", artist: "D", genres: ["jazz"] });
  smart.recordOutcome(
    { title: "Hers", artist: "A", addedBy: "UALICE", outcome: "finished" },
    context(),
  );
  smart.recordOutcome(
    { title: "His", artist: "B", addedBy: "UBOB", outcome: "finished" },
    context(),
  );
  const pick = async (songsAgo: number) =>
    (
      await smart.rank(
        [candidate("More Jazz", "D"), candidate("More K", "C")],
        context({ lastRequester: { userId: "UALICE", songsAgo } }),
        1,
      )
    ).picks[0]!.title;
  expect(await pick(0)).toBe("More K");
  expect(await pick(5)).toBe("More Jazz");
});

test("gives a share of picks to something new, less while picks are rejected", async () => {
  const smart = make();
  const many = Array.from({ length: 10 }, (_, index) =>
    candidate(`Song ${index}`, `Artist ${index}`, {
      rank: index,
      discovery: index >= 5,
    }),
  );
  const first = await smart.rank(many, context(), 5);
  expect(first.picks.filter((pick) => pick.explore)).toHaveLength(1);
  for (let index = 0; index < 10; index++)
    smart.recordOutcome(
      {
        title: `Bad ${index}`,
        artist: "X",
        addedBy: "agent",
        actor: "UALICE",
        outcome: "removed",
      },
      context(),
    );
  const after = await smart.rank(many, context(), 5);
  expect(after.explore.share).toBeLessThan(first.explore.share);
  expect(after.explore.recentRejection).toBe(1);
});

test("scoring scripts run sandboxed and bounded", async () => {
  expect(
    await runScoringScript("function score(song) { return song.n * 10; }", [
      { song: { n: 0.1 }, ctx: {} },
      { song: { n: 2 }, ctx: {} },
    ]),
  ).toEqual([1, 5]);
  expect(
    await runScoringScript(
      "function score() { return typeof fetch + typeof Bun + typeof require === 'undefinedundefinedundefined' ? 1 : -1; }",
      [{ song: {}, ctx: {} }],
    ),
  ).toEqual([1]);
  expect(
    runScoringScript("function score() { while (true) {} }", [
      { song: {}, ctx: {} },
    ]),
  ).rejects.toThrow();
  expect(
    runScoringScript("const x = 1;", [{ song: {}, ctx: {} }]),
  ).rejects.toThrow();
});

test("a strategy is evaluated, tried, then promoted or rejected by outcomes", async () => {
  const smart = make({ random: () => 0.1 });
  expect(validateWeights({ genreMatch: 99, nope: 1 })).toMatchObject({
    weights: { genreMatch: 5 },
    errors: ["unknown weight nope"],
  });
  expect(
    await smart.proposeStrategy({
      script: "function score() { while(true){} }",
    }),
  ).toMatchObject({ ok: false });
  const proposed = await smart.proposeStrategy({
    weights: { genreMatch: 2 },
    script: "function score(song) { return song.profile ? 1 : 0; }",
    note: "lean on genres",
  });
  expect(proposed).toMatchObject({ ok: true, version: 1, status: "trial" });
  expect(smart.activeStrategy().version).toBe(0);
  // Trial picks get removed, the active strategy's picks play out.
  const trialPicks = await smart.rank(
    Array.from({ length: 20 }, (_, index) =>
      candidate(`T${index}`, "A", { rank: index }),
    ),
    context(),
    10,
  );
  expect(trialPicks.strategy.version).toBe(1);
  for (let index = 0; index < 16; index++) {
    const title = `T${index % 10}`;
    smart.recordOutcome(
      {
        title,
        artist: "A",
        addedBy: "agent",
        actor: "UALICE",
        outcome: "removed",
      },
      context(),
    );
    smart.recordOutcome(
      {
        title: `C${index}`,
        artist: "B",
        addedBy: "agent",
        outcome: "finished",
      },
      context(),
    );
  }
  expect(smart.trialStrategy()).toBeUndefined();
  expect(smart.strategies()[0]).toMatchObject({
    version: 1,
    status: "rejected",
  });
  expect(smart.activeStrategy().version).toBe(0);
  const evaluation = await smart.evaluate({ weights: { rejected: 3 } });
  expect(evaluation).toMatchObject({ ok: true, summary: { outcomes: 32 } });
});

test("rolls back to an earlier version or the defaults", async () => {
  const smart = make();
  await smart.proposeStrategy({ weights: { shared: 2 } });
  expect(smart.rollback(1)).toEqual({ ok: true, active: 1 });
  expect(smart.activeStrategy().weights.shared).toBe(2);
  expect(smart.rollback(7)).toMatchObject({ ok: false });
  expect(smart.rollback(0)).toMatchObject({ ok: true, active: 0 });
  expect(smart.activeStrategy().version).toBe(0);
});

test("separation is the share of kept-over-rejected pairs", () => {
  expect(separation([2, 3], [1])).toBe(1);
  expect(separation([1], [1])).toBe(0.5);
  expect(separation([], [1])).toBeUndefined();
});

test("the vocabulary lives in the data and grows without a release", async () => {
  const db = new Database(":memory:");
  const smart = new SmartRecs(db, {}, offline);
  expect(smart.vocabulary().genres.map((entry) => entry.value)).toContain(
    "pop",
  );
  expect(
    smart.setVocabulary(
      {
        kind: "genre",
        value: "City Pop",
        keys: ["city pop", "citypop"],
        energy: 3,
        priority: 5,
        note: "keeps coming up",
      },
      "UALICE",
    ),
  ).toMatchObject({ ok: true, entry: { value: "city pop", origin: "custom" } });
  // Matched before the broad "pop" thanks to its priority.
  const request = (async (url: string) =>
    url.includes("track.getTopTags")
      ? Response.json({
          toptags: {
            tag: [
              { name: "city pop", count: 9 },
              { name: "japanese", count: 5 },
              { name: "80s", count: 3 },
            ],
          },
        })
      : Response.json({ error: 6 })) as unknown as typeof fetch;
  const withTags = new SmartRecs(db, { lastFmApiKey: "key" }, request);
  expect(await withTags.ensureProfile("Plastic", "Singer")).toMatchObject({
    genres: ["city pop", "pop"],
    country: "JP",
  });
  expect(
    withTags.setProfile({ title: "A", artist: "B", genres: ["city pop"] }),
  ).toMatchObject({ ok: true });
  expect(smart.setVocabulary({ kind: "place", value: "Japan" })).toMatchObject({
    ok: false,
  });
  expect(smart.deleteVocabulary("genre", "pop", "too broad")).toMatchObject({
    ok: true,
  });
  // A new instance on the same data keeps the removal: defaults are not re-added.
  const again = new SmartRecs(db, {}, offline);
  expect(again.vocabulary().genres.map((entry) => entry.value)).not.toContain(
    "pop",
  );
  expect(again.resetVocabulary("genre", "pop")).toMatchObject({ ok: true });
  expect(again.vocabulary().genres.map((entry) => entry.value)).toContain(
    "pop",
  );
  expect(again.vocabularyLog().map((item) => item.action)).toEqual([
    "reset",
    "delete",
    "add",
  ]);
  expect(again.vocabularyLog().at(-1)).toMatchObject({
    by: "UALICE",
    note: "keeps coming up",
  });
});

test("imports past outcomes from the audit log once, and counts likes", () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE track_likes (user_id TEXT, title TEXT, artist TEXT, liked_at INTEGER)",
  );
  db.run("INSERT INTO track_likes VALUES ('UALICE', 'Liked', 'Band', 1)");
  const smart = new SmartRecs(db, {}, offline);
  smart.setProfile({ title: "Liked", artist: "Band", genres: ["jazz"] });
  const line = (event: Record<string, unknown>) => JSON.stringify(event);
  const audit = [
    line({
      time: "2026-11-01T10:00:00.000Z",
      event: "track.added",
      actor: { id: "UALICE" },
      sessionId: "old",
      trackId: "t1",
      title: "Mine",
      artist: "Band",
      requesterId: "UALICE",
      origin: "manual",
    }),
    line({
      time: "2026-11-01T10:04:00.000Z",
      event: "track.finished",
      actor: { id: "system" },
      sessionId: "old",
      trackId: "t1",
      title: "Mine",
      artist: "Band",
      requesterId: "UALICE",
      origin: "manual",
    }),
    line({
      time: "2026-11-01T10:05:00.000Z",
      event: "track.added",
      actor: { id: "U01MCP" },
      sessionId: "old",
      trackId: "t2",
      title: "Pick",
      artist: "Other",
      requesterId: "recommended",
      origin: "manual",
    }),
    line({
      time: "2026-11-01T10:05:30.000Z",
      event: "track.removed",
      actor: { id: "UBOB" },
      sessionId: "old",
      trackId: "t2",
      title: "Pick",
      artist: "Other",
      requesterId: "recommended",
      origin: "manual",
    }),
    line({
      time: "2026-11-01T10:06:00.000Z",
      event: "track.skipped",
      actor: { id: "UBOB" },
      sessionId: "old",
      trackId: "t3",
      title: "Auto",
      artist: "Third",
      requesterId: "UALICE",
      origin: "autoplay",
      playedSeconds: 12,
    }),
    "not json",
  ].join("\n");
  expect(smart.importAudit(audit, () => ["UALICE", "UBOB"])).toEqual({
    imported: 3,
    skipped: false,
  });
  expect(smart.importAudit(audit, () => [])).toEqual({
    imported: 0,
    skipped: true,
  });
  expect(
    smart
      .outcomes()
      .map((item) => [
        item.title,
        item.outcome,
        item.addedBy,
        item.actor ?? null,
        item.queuedSeconds ?? null,
      ]),
  ).toEqual([
    ["Auto", "skipped", "autoplay", "UBOB", null],
    ["Pick", "removed", "agent", "UBOB", 30],
    ["Mine", "finished", "UALICE", null, null],
  ]);
  const taste = smart.taste("UALICE");
  expect(taste.genres.jazz).toBe(1);
  expect(taste.artists.band).toBe(2);
  expect(smart.taste("UBOB").artists.other).toBe(-1);
});

test("reads the song out of messy video titles", () => {
  expect(cleanSong("Band A - Songbird (Offiical Video)", "Band A")).toEqual({
    title: "Songbird",
    artist: "Band A",
  });
  expect(
    cleanSong("Band A - Band A - Songbird [Official Music Video]", "Band A"),
  ).toEqual({
    title: "Songbird",
    artist: "Band A",
  });
  expect(
    cleanSong(
      "Singer B - River Flows (Lirik) | Live 2019",
      "SINGER B place / official",
    ),
  ).toEqual({
    title: "River Flows",
    artist: "Singer B",
  });
  expect(cleanSong("Night Drive (feat. Someone)", "Band C - Topic")).toEqual({
    title: "Night Drive",
    artist: "Band C",
  });
  // A dash that is part of the song stays when the left side is not the artist.
  expect(cleanSong("Rain - Remix", "Band D")).toEqual({
    title: "Rain - Remix",
    artist: "Band D",
  });
});

test("a fixed vocabulary mapping fixes songs already profiled, from their stored tags", async () => {
  const request = (async (url: string) =>
    url.includes("track.getTopTags")
      ? Response.json({
          toptags: {
            tag: [
              { name: "smooth jazz", count: 9 },
              { name: "instrumental", count: 8 },
              { name: "saxophone", count: 5 },
            ],
          },
        })
      : Response.json({ error: 6 })) as unknown as typeof fetch;
  const smart = new SmartRecs(
    new Database(":memory:"),
    { lastFmApiKey: "key" },
    request,
  );
  smart.setVocabulary({
    kind: "genre",
    value: "classical",
    keys: ["classical", "instrumental"],
  });
  const before = await smart.ensureProfile(
    "Band A - Songbird (Official Video)",
    "Band A",
  );
  expect(before).toMatchObject({
    title: "Songbird",
    artist: "Band A",
    genres: ["jazz", "classical"],
  });
  // The same song under a cleaner title shares the profile.
  expect(smart.profile("Songbird", "Band A")?.genres).toEqual([
    "jazz",
    "classical",
  ]);
  smart.setVocabulary({
    kind: "genre",
    value: "classical",
    keys: ["classical"],
    note: "sax is not classical",
  });
  expect(smart.profile("Songbird", "Band A")?.genres).toEqual(["jazz"]);
});

test("imported outcomes are replayed with what was known that day, so evaluation can tell", async () => {
  const smart = new SmartRecs(new Database(":memory:"), {}, offline);
  smart.setProfile({ title: "Loud", artist: "Metal Band", genres: ["metal"] });
  smart.setProfile({ title: "Soft", artist: "Pop Band", genres: ["pop"] });
  const events: string[] = [];
  for (let day = 1; day <= 6; day++) {
    const time = (minute: number) =>
      `2026-11-0${day}T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const base = {
      sessionId: `s${day}`,
      requesterId: "recommended",
      origin: "manual",
    };
    events.push(
      JSON.stringify({
        ...base,
        time: time(0),
        event: "track.added",
        actor: { id: "U01MCP" },
        trackId: `l${day}`,
        title: "Loud",
        artist: "Metal Band",
      }),
      JSON.stringify({
        ...base,
        time: time(1),
        event: "track.removed",
        actor: { id: "UBOB" },
        trackId: `l${day}`,
        title: "Loud",
        artist: "Metal Band",
      }),
      JSON.stringify({
        ...base,
        time: time(5),
        event: "track.finished",
        actor: { id: "system" },
        trackId: `p${day}`,
        title: "Soft",
        artist: "Pop Band",
      }),
    );
  }
  smart.importAudit(events.join("\n"), () => ["UBOB"]);
  const evaluation = await smart.evaluate({});
  expect(evaluation).toMatchObject({
    ok: true,
    summary: { outcomes: 12, rejected: 6 },
  });
  // Day one knows nothing yet; from day two the removals weigh metal down.
  expect((evaluation as any).summary.separation).toBeGreaterThan(0.75);
});

test("songs profiled under a raw video title are looked up again by their real title", async () => {
  const db = new Database(":memory:");
  const first = new SmartRecs(db, {}, offline);
  // A profile saved before titles were cleaned: raw key, no tags.
  db.query(
    `INSERT INTO song_profiles (key, title, artist, genres, moods, source, confidence, updated_at)
     VALUES (?, ?, 'Band A', '["classical"]', '[]', 'lastfm', 0.7, 1)`,
  ).run(
    "band a\u0000band a - songbird (official video)",
    "Band A - Songbird (Official Video)",
  );
  first.recordOutcome(
    {
      title: "Band A - Songbird (Official Video)",
      artist: "Band A",
      addedBy: "UALICE",
      outcome: "finished",
    },
    { sessionId: "s", listeners: ["UALICE"], recent: [], hour: 10 },
  );
  const looked: string[] = [];
  const request = (async (url: string) => {
    if (url.includes("track.getTopTags")) {
      looked.push(new URL(url).searchParams.get("track")!);
      return Response.json({
        toptags: {
          tag: [
            { name: "smooth jazz", count: 9 },
            { name: "saxophone", count: 4 },
            { name: "jazz", count: 3 },
          ],
        },
      });
    }
    return Response.json({ error: 6 });
  }) as unknown as typeof fetch;
  const second = new SmartRecs(db, { lastFmApiKey: "key" }, request);
  expect(await second.backfillProfiles({ delayMs: 0 })).toBe(1);
  expect(looked).toEqual(["Songbird"]);
  expect(second.profile("Songbird", "Band A")?.genres).toEqual(["jazz"]);
});
