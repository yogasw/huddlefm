import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SmartRecs, type RankContext } from "./smart.ts";
import { matchTerm, TasteRules } from "./taste-rules.ts";
import {
  forgetTasteSaidAction,
  isTasteInteraction,
  tasteBlocks,
  tasteCallback,
  tasteEditView,
  tasteFromState,
} from "./taste-ui.ts";

const offline = (async () =>
  new Response("{}", { status: 404 })) as unknown as typeof fetch;
const make = () => {
  let clock = 1_000_000;
  return new SmartRecs(new Database(":memory:"), {}, offline, {
    now: () => (clock += 1000),
    random: () => 0.9,
  });
};
const context = (change: Partial<RankContext> = {}): RankContext => ({
  sessionId: "s1",
  listeners: ["UALICE", "UBOB"],
  recent: [],
  hour: 20,
  ...change,
});

test("matches a person's words to the vocabulary", () => {
  const places = [{ value: "KR", keys: ["korean", "k-pop", "kpop"] }];
  expect(matchTerm("korea", places)).toBe("KR");
  expect(matchTerm("kr", places)).toBe("KR");
  expect(matchTerm("Korean", places)).toBe("KR");
  expect(matchTerm("narnia", places)).toBeUndefined();
});

test("keeps what a person said, matched and per person", () => {
  const smart = make();
  const { rules, unknown } = smart.setTaste("UALICE", {
    avoid: { genres: ["kpop"], countries: ["korea"], artists: ["Band A"] },
    like: { genres: ["Indie"], moods: ["nonsense-mood"] },
  });
  expect(rules.avoid).toMatchObject({
    genres: ["k-pop"],
    countries: ["KR"],
    artists: ["Band A"],
  });
  expect(rules.like.genres).toEqual(["indie"]);
  expect(unknown).toEqual(["moods: nonsense-mood"]);
  expect(smart.rules.get("UBOB").avoid.genres).toEqual([]);
  // The last stance given wins, and unset drops either.
  smart.setTaste("UALICE", { like: { genres: ["k-pop"] } });
  expect(smart.rules.get("UALICE").like.genres).toContain("k-pop");
  expect(smart.rules.get("UALICE").avoid.genres).toEqual([]);
  smart.setTaste("UALICE", { unset: { artists: ["band a"] } });
  expect(smart.rules.get("UALICE").avoid.artists).toEqual([]);
  // replace starts from nothing, as the form does.
  smart.setTaste("UALICE", { replace: true, avoid: { moods: ["sad"] } });
  expect(smart.rules.get("UALICE")).toMatchObject({
    like: { genres: [] },
    avoid: { moods: ["sad"], countries: [] },
  });
});

test("never recommends what a listener avoids, and says so", async () => {
  const smart = make();
  smart.setProfile({
    title: "Loud",
    artist: "Group K",
    genres: ["k-pop"],
    country: "KR",
  });
  smart.setProfile({ title: "Calm", artist: "Band B", genres: ["indie"] });
  smart.setTaste("UALICE", { avoid: { countries: ["KR"] } });
  const candidates = [
    {
      title: "Loud",
      artist: "Group K",
      reference: "r1",
      forUsers: [],
      sources: [],
      discovery: false,
      rank: 0,
    },
    {
      title: "Calm",
      artist: "Band B",
      reference: "r2",
      forUsers: [],
      sources: [],
      discovery: false,
      rank: 1,
    },
  ];
  const ranked = (await smart.rank(
    candidates as never,
    context(),
    5,
  )) as Record<string, any>;
  expect(ranked.picks.map((pick: any) => pick.title)).toEqual(["Calm"]);
  expect(ranked.heldBack).toEqual([
    { title: "Loud", artist: "Group K", by: "UALICE", because: "country KR" },
  ]);
  // Without that listener, it can be picked again.
  const alone = (await smart.rank(
    candidates as never,
    context({ listeners: ["UBOB"] }),
    5,
  )) as Record<string, any>;
  expect(alone.picks.map((pick: any) => pick.title)).toContain("Loud");
});

test("a said like or avoid shows in the person's taste", () => {
  const smart = make();
  smart.setTaste("UALICE", {
    like: { artists: ["Band B"] },
    avoid: { genres: ["k-pop"] },
  });
  const summary = smart.tasteSummary("UALICE");
  expect(summary.learnt.likes.artists).toEqual(["band b"]);
  expect(summary.learnt.avoids.genres).toEqual(["k-pop"]);
  expect(summary.said.like.artists).toEqual(["Band B"]);
});

test("forgets history without the person, and what they said", () => {
  const smart = make();
  const ctx = context({ listeners: ["UALICE"] });
  smart.recordOutcome(
    {
      title: "One",
      artist: "Band",
      addedBy: "UBOB",
      actor: "UALICE",
      outcome: "skipped",
      playedSeconds: 5,
    },
    ctx,
  );
  smart.recordOutcome(
    { title: "Two", artist: "Band", addedBy: "UALICE", outcome: "finished" },
    ctx,
  );
  smart.setTaste("UALICE", { avoid: { genres: ["k-pop"] } });
  expect(smart.tasteSummary("UALICE").history).toBe(2);
  expect(
    smart.forgetTaste("UALICE", "history", [{ title: "One", artist: "Band" }]),
  ).toEqual({ said: 0, history: 1 });
  expect(smart.tasteSummary("UALICE").history).toBe(1);
  expect(smart.forgetTaste("UALICE", "all")).toEqual({ said: 1, history: 1 });
  expect(smart.tasteSummary("UALICE").history).toBe(0);
  // The room's outcomes stay, without the person.
  expect(
    smart.outcomes().map((row) => [row.title, row.addedBy, row.actor ?? null]),
  ).toEqual([
    ["Two", "forgotten", null],
    ["One", "UBOB", "forgotten"],
  ]);
});

test("an avoided artist matches inside a collaboration", () => {
  const db = new Database(":memory:");
  const rules = new TasteRules(db);
  rules.set("UALICE", {
    avoid: { genres: [], moods: [], countries: [], artists: ["Band A"] },
  });
  expect(
    rules.avoiders(["UALICE"], { artist: "Band A & Band B" }),
  ).toHaveLength(1);
  expect(rules.avoiders(["UALICE"], { artist: "Band AB" })).toHaveLength(0);
});

test("Your taste reads back what its form submits", () => {
  const smart = make();
  smart.setTaste("UALICE", {
    avoid: { genres: ["k-pop"], artists: ["Band A"] },
  });
  const view = tasteEditView(
    "s1",
    {},
    smart.rules.get("UALICE"),
    smart.tasteVocabulary(),
  ) as Record<string, any>;
  expect(view.callback_id).toBe(tasteCallback);
  const avoidGenres = view.blocks.find(
    (block: any) => block.block_id === "taste_avoid_genres",
  );
  expect(avoidGenres.element.initial_options).toEqual([
    { text: { type: "plain_text", text: "k-pop" }, value: "k-pop" },
  ]);
  const parsed = tasteFromState({
    taste_avoid_genres: { value: { selected_options: [{ value: "k-pop" }] } },
    taste_like_artists: { value: { value: "Band B, , Band C" } },
  } as never);
  expect(parsed.avoid.genres).toEqual(["k-pop"]);
  expect(parsed.like.artists).toEqual(["Band B", "Band C"]);
  expect(parsed.replace).toBe(true);
  const blocks = tasteBlocks("s1", smart.tasteSummary("UALICE")) as Record<
    string,
    any
  >[];
  expect(JSON.stringify(blocks)).toContain("Never for me");
  expect(
    isTasteInteraction({
      type: "block_actions",
      actionId: forgetTasteSaidAction,
    }),
  ).toBe(true);
  expect(
    isTasteInteraction({ type: "view_submission", actionId: tasteCallback }),
  ).toBe(true);
  expect(isTasteInteraction({ type: "block_actions", actionId: "skip" })).toBe(
    false,
  );
});
