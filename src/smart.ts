import type { Database } from "bun:sqlite";
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { logger } from "./logger.ts";

// Smart recommendations: what a song is (its profile), what became of the
// songs a session played (outcomes), and how candidates are weighed (a
// versioned strategy an agent can tune, with an optional sandboxed scoring
// script). The recommendation catalog finds candidates; this ranks them for
// the people listening and learns from what they keep, skip or remove.

const log = logger.child({ component: "smart" });

export type SongProfile = {
  title: string;
  artist: string;
  // ISO 3166 alpha-2 of the artist's country.
  country?: string;
  // ISO 639-1 of the lyrics.
  language?: string;
  genres: string[];
  moods: string[];
  // 1 (calm) to 5 (intense).
  energy?: number;
  // A decade, as "1990s".
  era?: string;
  source: string;
  confidence: number;
  updatedAt: number;
};

export type Outcome = "finished" | "skipped" | "removed";

// Tag words to the vocabularies. A tag counts when it contains the word.
const defaultGenreTags: [string, string[]][] = [
  ["k-pop", ["k-pop", "kpop", "korean pop"]],
  ["j-pop", ["j-pop", "jpop", "anime", "j-rock", "japanese"]],
  ["dangdut", ["dangdut", "koplo", "campursari"]],
  ["hip-hop", ["hip-hop", "hip hop", "rap", "trap"]],
  ["r&b", ["r&b", "rnb", "rhythm and blues"]],
  ["lo-fi", ["lo-fi", "lofi"]],
  ["metal", ["metal", "metalcore", "deathcore"]],
  ["punk", ["punk", "emo", "pop punk"]],
  ["electronic", ["electronic", "edm", "house", "techno", "synth", "trance"]],
  ["dance", ["dance", "disco", "club"]],
  ["indie", ["indie"]],
  ["alternative", ["alternative", "grunge", "shoegaze"]],
  ["rock", ["rock"]],
  ["soul", ["soul", "motown", "neo-soul"]],
  ["jazz", ["jazz", "bossa nova", "swing"]],
  ["blues", ["blues"]],
  ["folk", ["folk", "singer-songwriter"]],
  ["acoustic", ["acoustic", "unplugged"]],
  ["country", ["country", "americana"]],
  ["classical", ["classical", "orchestral", "piano", "instrumental"]],
  ["reggae", ["reggae", "ska", "dub"]],
  ["latin", ["latin", "reggaeton", "salsa"]],
  ["soundtrack", ["soundtrack", "ost", "score", "musical"]],
  ["pop", ["pop"]],
];
const defaultMoodTags: [string, string[]][] = [
  [
    "sad",
    ["sad", "melancholy", "melancholic", "heartbreak", "galau", "depress"],
  ],
  ["chill", ["chill", "mellow", "relax", "calm", "smooth", "easy listening"]],
  ["upbeat", ["upbeat", "happy", "energetic", "feel good", "uplifting", "fun"]],
  ["romantic", ["love", "romantic", "romance", "sensual"]],
  ["nostalgic", ["nostalg", "oldies", "throwback", "classic"]],
  ["focus", ["study", "focus", "ambient", "instrumental", "concentration"]],
  ["party", ["party", "club", "dance"]],
  ["angry", ["angry", "aggressive", "rage", "heavy"]],
  ["dreamy", ["dream", "ethereal", "atmospheric", "psychedelic"]],
];
const defaultPlaceTags: [string, string, string[]][] = [
  ["ID", "id", ["indonesia", "indonesian", "dangdut", "koplo"]],
  ["MY", "ms", ["malaysia", "malaysian"]],
  ["KR", "ko", ["korean", "k-pop", "kpop"]],
  ["JP", "ja", ["japanese", "j-pop", "jpop", "anime", "j-rock"]],
  ["GB", "en", ["british", "uk"]],
  ["US", "en", ["american", "usa"]],
  ["PH", "tl", ["filipino", "opm"]],
  ["TH", "th", ["thai"]],
  ["IN", "hi", ["bollywood", "indian", "hindi"]],
];
const defaultEnergy: Record<string, number> = {
  metal: 5,
  punk: 5,
  angry: 5,
  party: 5,
  dance: 4,
  electronic: 4,
  "hip-hop": 4,
  "k-pop": 4,
  rock: 4,
  upbeat: 4,
  dangdut: 4,
  pop: 3,
  latin: 3,
  indie: 3,
  alternative: 3,
  "j-pop": 3,
  "r&b": 3,
  reggae: 3,
  nostalgic: 3,
  romantic: 2,
  soul: 2,
  folk: 2,
  country: 2,
  blues: 2,
  jazz: 2,
  chill: 2,
  sad: 2,
  acoustic: 2,
  "lo-fi": 1,
  classical: 1,
  focus: 1,
  dreamy: 2,
};

// The vocabularies: genres, moods and places, each with the tag words that
// map to it. They live in the data volume (song_vocabulary) so they grow
// without a release: these defaults are seeded once, new defaults from later
// versions are added, and anything changed or removed through MCP stays as
// it was left. Order matters: the first entry a tag matches wins, which is
// why "k-pop" sits before "pop".
export type VocabularyKind = "genre" | "mood" | "place";
export type VocabularyEntry = {
  kind: VocabularyKind;
  // A genre or mood label, or a place's ISO 3166 alpha-2 country code.
  value: string;
  // Tag words that mean it, matched at the start of a word in a tag.
  keys: string[];
  // Genres and moods: 1 (calm) to 5 (intense).
  energy?: number;
  // Places: the ISO 639-1 language most of its songs are in.
  language?: string;
  // Lower comes first.
  priority: number;
  note?: string;
  origin: "default" | "custom";
};
export type Vocabulary = {
  genres: VocabularyEntry[];
  moods: VocabularyEntry[];
  places: VocabularyEntry[];
};

export const defaultVocabularyEntries: VocabularyEntry[] = [
  ...defaultGenreTags.map(([value, keys], index) => ({
    kind: "genre" as const,
    value,
    keys,
    ...(defaultEnergy[value] ? { energy: defaultEnergy[value] } : {}),
    priority: (index + 1) * 10,
    origin: "default" as const,
  })),
  ...defaultMoodTags.map(([value, keys], index) => ({
    kind: "mood" as const,
    value,
    keys,
    ...(defaultEnergy[value] ? { energy: defaultEnergy[value] } : {}),
    priority: (index + 1) * 10,
    origin: "default" as const,
  })),
  ...defaultPlaceTags.map(([value, language, keys], index) => ({
    kind: "place" as const,
    value,
    keys,
    language,
    priority: (index + 1) * 10,
    origin: "default" as const,
  })),
];

export function buildVocabulary(entries: VocabularyEntry[]): Vocabulary {
  const of = (kind: VocabularyKind) =>
    entries
      .filter((entry) => entry.kind === kind)
      .sort(
        (a, b) => a.priority - b.priority || a.value.localeCompare(b.value),
      );
  return { genres: of("genre"), moods: of("mood"), places: of("place") };
}

export const defaultVocabulary = buildVocabulary(defaultVocabularyEntries);

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function profileKey(title: string, artist: string) {
  return `${normalize(artist)}\0${normalize(title)}`;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A key matches at the start of a word ("nostalg" in "nostalgic", not "ost"
// in it); whole marks it as a whole word ("uk", not "ukulele").
const matches = (tag: string, key: string, whole = false) =>
  new RegExp(`(^|[^a-z])${escape(key)}${whole ? "($|[^a-z])" : ""}`).test(tag);

/** A profile from free-form tags, as Last.fm returns them, best first. */
export function profileFromTags(
  tags: string[],
  vocabulary: Vocabulary = defaultVocabulary,
) {
  const words = tags.map(normalize).filter(Boolean).slice(0, 15);
  const pick = (table: VocabularyEntry[], limit: number) => {
    const found: string[] = [];
    for (const tag of words)
      for (const entry of table)
        if (
          !found.includes(entry.value) &&
          entry.keys.some((key) => matches(tag, normalize(key))) &&
          found.length < limit
        )
          found.push(entry.value);
    return found;
  };
  const genresFound = pick(vocabulary.genres, 2);
  const moodsFound = pick(vocabulary.moods, 2);
  let country: string | undefined;
  let language: string | undefined;
  for (const tag of words) {
    const place = vocabulary.places.find((entry) =>
      entry.keys.some((key) => matches(tag, normalize(key), true)),
    );
    if (place) {
      country = place.value;
      language = place.language;
      break;
    }
  }
  const decade = words
    .map((tag) => tag.match(/^(?:19|20)?(\d)0s$/))
    .find(Boolean);
  let era: string | undefined;
  if (decade) {
    const digit = Number(decade[1]);
    era = `${digit >= 5 ? "19" : "20"}${digit}0s`;
  }
  const energy = estimateEnergy([...genresFound, ...moodsFound], vocabulary);
  return {
    genres: genresFound,
    moods: moodsFound,
    ...(country ? { country } : {}),
    ...(language ? { language } : {}),
    ...(era ? { era } : {}),
    ...(energy ? { energy } : {}),
  };
}

function estimateEnergy(labels: string[], vocabulary: Vocabulary) {
  const energies = new Map(
    [...vocabulary.genres, ...vocabulary.moods].map(
      (entry) => [entry.value, entry.energy] as const,
    ),
  );
  const values = labels
    .map((label) => energies.get(label))
    .filter((value): value is number => value !== undefined);
  if (!values.length) return undefined;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// How the built-in ranking weighs a candidate. Every number is bounded, so an
// agent tuning them can make the ranking worse but never break it.
export type Weights = {
  // The recommendation catalog's own order.
  base: number;
  // Songs that suit several of the people listening.
  shared: number;
  // The genres the listeners keep.
  genreMatch: number;
  // Staying with the session's mood.
  moodMatch: number;
  // Penalty for jumping energy (calm to intense) between songs.
  energyJump: number;
  // Leaning to whoever asked for a song last, for a few songs.
  lastRequester: number;
  lastRequesterSongs: number;
  // Penalty for genres and artists the listeners removed or skipped.
  rejected: number;
  // Share of picks that try something new, and its bounds when it adapts.
  explore: number;
  exploreMin: number;
  exploreMax: number;
  // How much a strategy's script adds to the built-in score.
  script: number;
};

export const defaultWeights: Weights = {
  base: 1,
  shared: 0.8,
  genreMatch: 1.2,
  moodMatch: 0.8,
  energyJump: 0.6,
  lastRequester: 0.7,
  lastRequesterSongs: 3,
  rejected: 1.5,
  explore: 0.2,
  exploreMin: 0.05,
  exploreMax: 0.4,
  script: 1,
};

const weightBounds: Record<keyof Weights, [number, number]> = {
  base: [0, 5],
  shared: [0, 5],
  genreMatch: [0, 5],
  moodMatch: [0, 5],
  energyJump: [0, 5],
  lastRequester: [0, 5],
  lastRequesterSongs: [0, 10],
  rejected: [0, 5],
  explore: [0, 1],
  exploreMin: [0, 1],
  exploreMax: [0, 1],
  script: [0, 5],
};

export type Features = {
  base: number;
  shared: number;
  genreMatch: number;
  moodMatch: number;
  energyJump: number;
  lastRequester: number;
  rejected: number;
};

export type Taste = {
  genres: Record<string, number>;
  moods: Record<string, number>;
  countries: Record<string, number>;
  artists: Record<string, number>;
  energy?: number;
  // How many outcomes it is built from.
  evidence: number;
};

export type Strategy = {
  version: number;
  weights: Weights;
  script?: string;
  note: string;
  // active: in use; trial: tried on half the picks against the active one;
  // retired, rejected: kept for history and rollback.
  status: "active" | "trial" | "retired" | "rejected";
  createdAt: number;
  result?: string;
};

export type RankContext = {
  sessionId: string;
  listeners: string[];
  recent: { title: string; artist: string }[];
  lastRequester?: { userId: string; songsAgo: number };
  hour: number;
};

export type RankCandidate = {
  title: string;
  artist: string;
  reference: string;
  forUsers: string[];
  sources: string[];
  discovery: boolean;
  // Position in the catalog's own order, 0 first.
  rank: number;
};

const trialMinimum = 15;
const trialMargin = 0.05;
const scriptBudgetMs = 150;
const scriptMemoryBytes = 16 * 1024 * 1024;

let quickjs: Promise<QuickJSWASMModule> | undefined;
const sandbox = () => (quickjs ??= getQuickJS());

/**
 * Runs `score(song, ctx)` from an agent's script for each input, in a
 * QuickJS sandbox: no network, files, timers or host objects, a memory cap
 * and a deadline. Scores are clamped to -5..5; anything else is 0.
 */
export async function runScoringScript(
  script: string,
  inputs: { song: unknown; ctx: unknown }[],
  budgetMs = scriptBudgetMs,
) {
  const module = await sandbox();
  const code = `const __input = ${JSON.stringify(inputs)};
${script}
;JSON.stringify(__input.map((x) => {
  const value = Number(score(x.song, x.ctx));
  return Number.isFinite(value) ? Math.max(-5, Math.min(5, value)) : 0;
}));`;
  const result = module.evalCode(code, {
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + budgetMs),
    memoryLimitBytes: scriptMemoryBytes,
  });
  if (typeof result !== "string") throw new Error("score must be defined");
  const scores = JSON.parse(result) as number[];
  if (!Array.isArray(scores) || scores.length !== inputs.length)
    throw new Error("score returned the wrong number of values");
  return scores;
}

export function validateWeights(patch: Record<string, unknown>) {
  const weights: Partial<Weights> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const bounds = weightBounds[key as keyof Weights];
    if (!bounds) {
      errors.push(`unknown weight ${key}`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${key} must be a number`);
      continue;
    }
    weights[key as keyof Weights] = Math.max(
      bounds[0],
      Math.min(bounds[1], value),
    );
  }
  return { weights, errors };
}

function share(record: Record<string, number>, keys: readonly string[]) {
  if (!keys.length) return 0;
  const total = Object.values(record).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  if (total <= 0) return 0;
  return (
    keys.reduce((sum, key) => sum + Math.max(0, record[key] ?? 0), 0) / total
  );
}

function negative(record: Record<string, number>, keys: readonly string[]) {
  return keys.reduce((sum, key) => sum + Math.max(0, -(record[key] ?? 0)), 0);
}

/** The built-in score: a weighted sum of the features. */
export function linearScore(features: Features, weights: Weights) {
  return (
    weights.base * features.base +
    weights.shared * features.shared +
    weights.genreMatch * features.genreMatch +
    weights.moodMatch * features.moodMatch -
    weights.energyJump * features.energyJump +
    weights.lastRequester * features.lastRequester -
    weights.rejected * features.rejected
  );
}

/**
 * How well scores tell kept songs from rejected ones: the share of
 * (kept, rejected) pairs the kept one scores higher in. 0.5 is chance.
 */
export function separation(good: number[], bad: number[]) {
  if (!good.length || !bad.length) return undefined;
  let wins = 0;
  for (const g of good)
    for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return wins / (good.length * bad.length);
}

type Lookup = (
  method: string,
  params: Record<string, string>,
) => Promise<Record<string, any> | undefined>;

export class SmartRecs {
  private inflight = new Map<string, Promise<SongProfile | undefined>>();
  private misses = new Map<string, number>();
  // Which strategy version recommended a song, so its outcome counts for it.
  private pickedBy = new Map<string, number>();
  private now: () => number;
  private random: () => number;

  constructor(
    private db: Database,
    private config: { lastFmApiKey?: string; userAgent?: string } = {},
    private request: typeof fetch = fetch,
    options: { now?: () => number; random?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS song_profiles (
        key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        country TEXT,
        language TEXT,
        genres TEXT NOT NULL,
        moods TEXT NOT NULL,
        energy INTEGER,
        era TEXT,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS song_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        added_by TEXT NOT NULL,
        actor TEXT,
        outcome TEXT NOT NULL,
        played_seconds INTEGER,
        queued_seconds INTEGER,
        listeners TEXT NOT NULL,
        features TEXT NOT NULL,
        context TEXT NOT NULL,
        strategy_version INTEGER
      )`);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS song_outcomes_at ON song_outcomes(at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS song_vocabulary (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        keys TEXT NOT NULL,
        energy INTEGER,
        language TEXT,
        priority INTEGER NOT NULL,
        note TEXT,
        origin TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS song_vocabulary_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        before TEXT,
        after TEXT,
        note TEXT,
        by TEXT
      )`);
    // Defaults not seen before are added; edited or removed ones are left.
    const seed = this.db.query(
      `INSERT OR IGNORE INTO song_vocabulary
        (kind, value, keys, energy, language, priority, note, origin, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'default', ?)`,
    );
    this.db.transaction(() => {
      for (const entry of defaultVocabularyEntries)
        seed.run(
          entry.kind,
          entry.value,
          JSON.stringify(entry.keys),
          entry.energy ?? null,
          entry.language ?? null,
          entry.priority,
          this.now(),
        );
    })();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS smart_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rec_strategies (
        version INTEGER PRIMARY KEY,
        weights TEXT NOT NULL,
        script TEXT,
        note TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        result TEXT
      )`);
  }

  // Vocabulary --------------------------------------------------------------

  private vocabularyCache?: Vocabulary;

  vocabulary(): Vocabulary {
    if (this.vocabularyCache) return this.vocabularyCache;
    const rows = this.db
      .query("SELECT * FROM song_vocabulary WHERE deleted = 0")
      .all() as Record<string, any>[];
    this.vocabularyCache = buildVocabulary(rows.map(rowVocabulary));
    return this.vocabularyCache;
  }

  /**
   * Adds or changes a genre, mood or place. Only the fields given change; a
   * removed entry comes back. Every change is logged with who and why.
   */
  setVocabulary(input: Record<string, unknown>, by?: string) {
    const kind = input.kind;
    if (kind !== "genre" && kind !== "mood" && kind !== "place")
      return { ok: false as const, error: "kind is genre, mood or place" };
    const raw = typeof input.value === "string" ? input.value.trim() : "";
    const value = kind === "place" ? raw.toUpperCase() : normalize(raw);
    if (
      kind === "place"
        ? !/^[A-Z]{2}$/.test(value)
        : !/^[a-z0-9&' -]{2,30}$/.test(value)
    )
      return {
        ok: false as const,
        error:
          kind === "place"
            ? "value is an ISO 3166 alpha-2 country code"
            : "value is a short lowercase label (2-30 letters, digits, spaces, - & ')",
      };
    const before = this.vocabularyRow(kind, value);
    const keys = Array.isArray(input.keys)
      ? [
          ...new Set(
            input.keys
              .map((key) => normalize(String(key)))
              .filter((key) => key.length >= 2),
          ),
        ].slice(0, 30)
      : (before?.keys ?? []);
    if (!keys.length && !before)
      return {
        ok: false as const,
        error: "keys: give the tag words that mean it",
      };
    const energy =
      typeof input.energy === "number"
        ? Math.max(1, Math.min(5, Math.round(input.energy)))
        : before?.energy;
    const language =
      typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language)
        ? input.language.toLowerCase()
        : before?.language;
    const priority =
      typeof input.priority === "number"
        ? Math.round(input.priority)
        : (before?.priority ?? 1000);
    const note =
      typeof input.note === "string" ? input.note.slice(0, 300) : undefined;
    const after: VocabularyEntry = {
      kind,
      value,
      keys: keys.length ? keys : (before?.keys ?? []),
      ...(energy && kind !== "place" ? { energy } : {}),
      ...(language && kind === "place" ? { language } : {}),
      priority,
      ...((note ?? before?.note) ? { note: note ?? before?.note } : {}),
      origin: before?.origin ?? "custom",
    };
    this.db
      .query(
        `INSERT INTO song_vocabulary
          (kind, value, keys, energy, language, priority, note, origin, deleted, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(kind, value) DO UPDATE SET
           keys = excluded.keys, energy = excluded.energy,
           language = excluded.language, priority = excluded.priority,
           note = excluded.note, deleted = 0,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(
        kind,
        value,
        JSON.stringify(after.keys),
        after.energy ?? null,
        after.language ?? null,
        after.priority,
        after.note ?? null,
        after.origin,
        by ?? null,
        this.now(),
      );
    this.logVocabulary(before ? "update" : "add", after, before, note, by);
    return { ok: true as const, entry: after };
  }

  /** Removes a genre, mood or place; profiles that use it keep the label. */
  deleteVocabulary(kind: unknown, value: unknown, note?: string, by?: string) {
    const entry =
      typeof kind === "string" && typeof value === "string"
        ? this.vocabularyRow(
            kind,
            kind === "place" ? value.toUpperCase() : normalize(value),
          )
        : undefined;
    if (!entry) return { ok: false as const, error: "no such entry" };
    this.db
      .query(
        "UPDATE song_vocabulary SET deleted = 1, updated_by = ?, updated_at = ? WHERE kind = ? AND value = ?",
      )
      .run(by ?? null, this.now(), entry.kind, entry.value);
    this.logVocabulary("delete", undefined, entry, note, by);
    return {
      ok: true as const,
      removed: { kind: entry.kind, value: entry.value },
    };
  }

  /** Puts a default entry back as it shipped. */
  resetVocabulary(kind: unknown, value: unknown, by?: string) {
    const original = defaultVocabularyEntries.find(
      (entry) =>
        entry.kind === kind &&
        entry.value ===
          (kind === "place"
            ? String(value).toUpperCase()
            : normalize(String(value))),
    );
    if (!original) return { ok: false as const, error: "not a default entry" };
    const before = this.vocabularyRow(original.kind, original.value, true);
    this.db
      .query(
        `UPDATE song_vocabulary SET keys = ?, energy = ?, language = ?, priority = ?,
           note = NULL, deleted = 0, updated_by = ?, updated_at = ?
         WHERE kind = ? AND value = ?`,
      )
      .run(
        JSON.stringify(original.keys),
        original.energy ?? null,
        original.language ?? null,
        original.priority,
        by ?? null,
        this.now(),
        original.kind,
        original.value,
      );
    this.logVocabulary("reset", original, before, undefined, by);
    return { ok: true as const, entry: original };
  }

  vocabularyLog(limit = 30) {
    return (
      this.db
        .query("SELECT * FROM song_vocabulary_log ORDER BY id DESC LIMIT ?")
        .all(Math.max(1, Math.min(200, limit))) as Record<string, any>[]
    ).map((row) => ({
      at: new Date(Number(row.at)).toISOString(),
      action: row.action,
      kind: row.kind,
      value: row.value,
      ...(row.before ? { before: JSON.parse(row.before) } : {}),
      ...(row.after ? { after: JSON.parse(row.after) } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.by ? { by: row.by } : {}),
    }));
  }

  private vocabularyRow(kind: string, value: string, withDeleted = false) {
    const row = this.db
      .query(
        `SELECT * FROM song_vocabulary WHERE kind = ? AND value = ?${withDeleted ? "" : " AND deleted = 0"}`,
      )
      .get(kind, value) as Record<string, any> | null;
    return row ? rowVocabulary(row) : undefined;
  }

  private logVocabulary(
    action: string,
    after: VocabularyEntry | undefined,
    before: VocabularyEntry | undefined,
    note?: string,
    by?: string,
  ) {
    this.vocabularyCache = undefined;
    const subject = (after ?? before)!;
    this.db
      .query(
        `INSERT INTO song_vocabulary_log (at, action, kind, value, before, after, note, by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        action,
        subject.kind,
        subject.value,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        note ?? null,
        by ?? null,
      );
  }

  // Profiles ----------------------------------------------------------------

  profile(title: string, artist: string): SongProfile | undefined {
    const row = this.db
      .query("SELECT * FROM song_profiles WHERE key = ?")
      .get(profileKey(title, artist)) as Record<string, any> | null;
    return row ? rowProfile(row) : undefined;
  }

  /** The stored profile, or one looked up from Last.fm and MusicBrainz. */
  ensureProfile(title: string, artist: string) {
    const known = this.profile(title, artist);
    if (known) return Promise.resolve(known);
    const key = profileKey(title, artist);
    // A song nobody has tags for is not asked about again for a day.
    if ((this.misses.get(key) ?? 0) > this.now())
      return Promise.resolve(undefined);
    const running = this.inflight.get(key);
    if (running) return running;
    const load = this.lookupProfile(title, artist)
      .catch((error) => {
        log.warn(
          { event: "profile_lookup_failed", title, artist, err: error },
          "Song profile lookup failed",
        );
        return undefined;
      })
      .then((profile) => {
        if (profile) this.saveProfile(profile);
        else this.misses.set(key, this.now() + 24 * 60 * 60_000);
        return profile;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, load);
    return load;
  }

  private async lookupProfile(title: string, artist: string) {
    const tags = await this.lastFmTags(title, artist);
    const fromTags = profileFromTags(tags, this.vocabulary());
    const country = fromTags.country ?? (await this.artistCountry(artist));
    const hasAnything =
      fromTags.genres.length || fromTags.moods.length || country;
    if (!hasAnything) return undefined;
    return {
      title,
      artist,
      ...fromTags,
      ...(country ? { country } : {}),
      source: tags.length ? "lastfm" : "musicbrainz",
      confidence: tags.length >= 3 ? 0.7 : 0.4,
      updatedAt: this.now(),
    } satisfies SongProfile;
  }

  private lastFm: Lookup = async (method, params) => {
    if (!this.config.lastFmApiKey) return undefined;
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", method);
    url.searchParams.set("api_key", this.config.lastFmApiKey);
    url.searchParams.set("format", "json");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const response = await this.request(url.href, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, any>;
    return body?.error ? undefined : body;
  };

  private async lastFmTags(title: string, artist: string) {
    const names = (body: Record<string, any> | undefined) => {
      const tags = body?.toptags?.tag;
      const list = Array.isArray(tags) ? tags : tags ? [tags] : [];
      return list
        .filter((tag: any) => Number(tag?.count ?? 1) > 0)
        .map((tag: any) => String(tag?.name ?? ""))
        .filter(Boolean);
    };
    const track = names(
      await this.lastFm("track.getTopTags", {
        track: title,
        artist,
        autocorrect: "1",
      }),
    );
    if (track.length >= 3) return track;
    const byArtist = names(
      await this.lastFm("artist.getTopTags", { artist, autocorrect: "1" }),
    );
    return [...track, ...byArtist];
  }

  private async artistCountry(artist: string) {
    const url = new URL("https://musicbrainz.org/ws/2/artist");
    url.searchParams.set("query", `artist:"${artist.replace(/"/g, "")}"`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("fmt", "json");
    const response = await this.request(url.href, {
      headers: {
        accept: "application/json",
        "user-agent": this.config.userAgent ?? "HuddleFM/1.0",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      artists?: { score?: number; country?: string }[];
    };
    const best = body.artists?.[0];
    return best && (best.score ?? 0) >= 90 && best.country
      ? best.country.toUpperCase()
      : undefined;
  }

  /** A profile an agent filled in; it replaces looked-up tags. */
  setProfile(input: Record<string, unknown>) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const artist = typeof input.artist === "string" ? input.artist.trim() : "";
    if (!title || !artist)
      return { ok: false as const, error: "title and artist are required" };
    const list = <T extends string>(value: unknown, allowed: readonly T[]) =>
      (Array.isArray(value) ? value : [])
        .map((item) => normalize(String(item)))
        .filter((item): item is T =>
          (allowed as readonly string[]).includes(item),
        )
        .slice(0, 2);
    const vocabulary = this.vocabulary();
    const genres = vocabulary.genres.map((entry) => entry.value);
    const moods = vocabulary.moods.map((entry) => entry.value);
    const genresGiven = list(input.genres, genres);
    const moodsGiven = list(input.moods, moods);
    const code = (value: unknown, length: number) =>
      typeof value === "string" && value.trim().length === length
        ? value.trim()
        : undefined;
    const country = code(input.country, 2)?.toUpperCase();
    const language = code(input.language, 2)?.toLowerCase();
    const energy =
      typeof input.energy === "number"
        ? Math.max(1, Math.min(5, Math.round(input.energy)))
        : estimateEnergy([...genresGiven, ...moodsGiven], vocabulary);
    const era =
      typeof input.era === "string" && /^(19|20)\d0s$/.test(input.era)
        ? input.era
        : undefined;
    if (!genresGiven.length && !moodsGiven.length && !country)
      return {
        ok: false as const,
        error: `give at least one known genre (${genres.join(", ")}), mood (${moods.join(", ")}) or country; a missing genre or mood can be added with vocabulary_set first`,
      };
    const profile: SongProfile = {
      title,
      artist,
      genres: genresGiven,
      moods: moodsGiven,
      ...(country ? { country } : {}),
      ...(language ? { language } : {}),
      ...(energy ? { energy } : {}),
      ...(era ? { era } : {}),
      source: "agent",
      confidence: 0.6,
      updatedAt: this.now(),
    };
    this.saveProfile(profile);
    this.misses.delete(profileKey(title, artist));
    return { ok: true as const, profile };
  }

  private saveProfile(profile: SongProfile) {
    this.db
      .query(
        `INSERT INTO song_profiles
          (key, title, artist, country, language, genres, moods, energy, era,
           source, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           title = excluded.title, artist = excluded.artist,
           country = excluded.country, language = excluded.language,
           genres = excluded.genres, moods = excluded.moods,
           energy = excluded.energy, era = excluded.era,
           source = excluded.source, confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        profileKey(profile.title, profile.artist),
        profile.title,
        profile.artist,
        profile.country ?? null,
        profile.language ?? null,
        JSON.stringify(profile.genres),
        JSON.stringify(profile.moods),
        profile.energy ?? null,
        profile.era ?? null,
        profile.source,
        profile.confidence,
        profile.updatedAt,
      );
  }

  // Taste and mood ----------------------------------------------------------

  /**
   * What a person keeps and rejects, from outcomes: songs they added that
   * played out count for, songs they removed or skipped count against, and
   * songs others added that played out while they listened count a little.
   */
  taste(userId: string): Taste {
    const rows = this.db
      .query(
        `SELECT title, artist, added_by, actor, outcome, listeners
           FROM song_outcomes
          WHERE added_by = ?1 OR actor = ?1 OR listeners LIKE ?2
          ORDER BY at DESC LIMIT 400`,
      )
      .all(userId, `%"${userId}"%`) as Record<string, any>[];
    const taste: Taste = {
      genres: {},
      moods: {},
      countries: {},
      artists: {},
      evidence: 0,
    };
    let energySum = 0;
    let energyWeight = 0;
    for (const row of rows) {
      let weight = 0;
      if (row.actor === userId && row.outcome !== "finished") weight = -1;
      else if (row.outcome === "finished")
        weight = row.added_by === userId ? 1 : 0.3;
      if (!weight) continue;
      taste.evidence++;
      const artist = normalize(String(row.artist));
      taste.artists[artist] = (taste.artists[artist] ?? 0) + weight;
      const profile = this.profile(String(row.title), String(row.artist));
      if (!profile) continue;
      for (const genre of profile.genres)
        taste.genres[genre] = (taste.genres[genre] ?? 0) + weight;
      for (const mood of profile.moods)
        taste.moods[mood] = (taste.moods[mood] ?? 0) + weight;
      if (profile.country)
        taste.countries[profile.country] =
          (taste.countries[profile.country] ?? 0) + weight;
      if (profile.energy && weight > 0) {
        energySum += profile.energy * weight;
        energyWeight += weight;
      }
    }
    // A like is a plain "more of this", from the player's like button.
    const likes = this.hasTable("track_likes")
      ? (this.db
          .query(
            "SELECT title, artist FROM track_likes WHERE user_id = ? LIMIT 200",
          )
          .all(userId) as { title: string; artist: string }[])
      : [];
    for (const like of likes) {
      taste.evidence++;
      const artist = normalize(like.artist);
      taste.artists[artist] = (taste.artists[artist] ?? 0) + 1;
      const profile = this.profile(like.title, like.artist);
      if (!profile) continue;
      for (const genre of profile.genres)
        taste.genres[genre] = (taste.genres[genre] ?? 0) + 1;
      for (const mood of profile.moods)
        taste.moods[mood] = (taste.moods[mood] ?? 0) + 1;
      if (profile.country)
        taste.countries[profile.country] =
          (taste.countries[profile.country] ?? 0) + 1;
    }
    if (energyWeight) taste.energy = energySum / energyWeight;
    return taste;
  }

  private tables = new Map<string, boolean>();
  private hasTable(name: string) {
    if (!this.tables.has(name))
      this.tables.set(
        name,
        Boolean(
          this.db
            .query(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(name),
        ),
      );
    return this.tables.get(name)!;
  }

  /** The mood of the latest songs: top genres, moods and average energy. */
  sessionMood(recent: { title: string; artist: string }[]) {
    const genresSeen: Record<string, number> = {};
    const moodsSeen: Record<string, number> = {};
    const countries: Record<string, number> = {};
    const energies: number[] = [];
    let profiled = 0;
    recent.slice(-8).forEach((track, index, list) => {
      const profile = this.profile(track.title, track.artist);
      if (!profile) return;
      profiled++;
      // The latest songs say most about where the room is now.
      const weight = 1 + index / list.length;
      for (const genre of profile.genres)
        genresSeen[genre] = (genresSeen[genre] ?? 0) + weight;
      for (const mood of profile.moods)
        moodsSeen[mood] = (moodsSeen[mood] ?? 0) + weight;
      if (profile.country)
        countries[profile.country] = (countries[profile.country] ?? 0) + weight;
      if (profile.energy) energies.push(profile.energy);
    });
    const top = (record: Record<string, number>) =>
      Object.entries(record)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key]) => key);
    return {
      genres: top(genresSeen),
      moods: top(moodsSeen),
      countries: top(countries),
      ...(energies.length
        ? {
            energy:
              Math.round(
                (energies.reduce((a, b) => a + b, 0) / energies.length) * 10,
              ) / 10,
          }
        : {}),
      profiled,
      of: Math.min(8, recent.length),
    };
  }

  // Features ----------------------------------------------------------------

  features(
    song: {
      title: string;
      artist: string;
      forUsers: string[];
      rank?: number;
      of?: number;
    },
    context: RankContext,
    tastes: Map<string, Taste>,
    mood: ReturnType<SmartRecs["sessionMood"]>,
    weights: Weights,
  ): Features {
    const profile = this.profile(song.title, song.artist);
    const labels = profile ? [...profile.genres, ...profile.moods] : [];
    const listeners = context.listeners.length ? context.listeners : [];
    const present = listeners
      .map((id) => tastes.get(id))
      .filter(Boolean) as Taste[];
    const artist = normalize(song.artist);
    const genreMatch = present.length
      ? present.reduce(
          (sum, taste) =>
            sum +
            (profile ? share(taste.genres, profile.genres) : 0) +
            (taste.artists[artist] && taste.artists[artist] > 0 ? 0.3 : 0),
          0,
        ) / present.length
      : 0;
    const moodMatch = profile
      ? (profile.moods.filter((mood_) => mood.moods.includes(mood_)).length +
          profile.genres.filter((genre) => mood.genres.includes(genre)).length *
            0.5) /
        Math.max(1, profile.moods.length + profile.genres.length * 0.5)
      : 0;
    const energyJump =
      profile?.energy && mood.energy
        ? Math.abs(profile.energy - mood.energy) / 4
        : 0;
    const rejected =
      present.reduce(
        (sum, taste) =>
          sum +
          Math.min(
            1,
            (profile ? negative(taste.genres, labels) * 0.25 : 0) +
              Math.max(0, -(taste.artists[artist] ?? 0)) * 0.5,
          ),
        0,
      ) / Math.max(1, present.length);
    let lastRequester = 0;
    const last = context.lastRequester;
    if (last && last.songsAgo < weights.lastRequesterSongs) {
      const decay = 1 - last.songsAgo / Math.max(1, weights.lastRequesterSongs);
      const taste = tastes.get(last.userId);
      const fits = song.forUsers.includes(last.userId)
        ? 1
        : taste && profile
          ? share(taste.genres, profile.genres)
          : 0;
      lastRequester = decay * fits;
    }
    const of = song.of ?? 1;
    return {
      base: song.rank === undefined ? 0 : 1 - song.rank / Math.max(1, of),
      shared:
        listeners.length > 1
          ? Math.max(0, song.forUsers.length - 1) / (listeners.length - 1)
          : 0,
      genreMatch,
      moodMatch,
      energyJump,
      lastRequester,
      rejected,
    };
  }

  // History -----------------------------------------------------------------

  /**
   * Turns the audit log HuddleFM has always kept into outcomes, once, so
   * taste starts from everything played before smart recommendations
   * existed rather than from nothing. Listeners come from `participants`.
   */
  importAudit(contents: string, participants: (sessionId: string) => string[]) {
    const done = this.db
      .query("SELECT value FROM smart_meta WHERE key = 'audit_imported'")
      .get() as { value: string } | null;
    if (done) return { imported: 0, skipped: true };
    const added = new Map<string, number>();
    const listeners = new Map<string, string[]>();
    const insert = this.db.query(
      `INSERT INTO song_outcomes
        (session_id, at, title, artist, added_by, actor, outcome,
         played_seconds, queued_seconds, listeners, features, context,
         strategy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0)`,
    );
    const neutral = JSON.stringify({
      base: 0.5,
      shared: 0,
      genreMatch: 0,
      moodMatch: 0,
      energyJump: 0,
      lastRequester: 0,
      rejected: 0,
    });
    let imported = 0;
    this.db.transaction(() => {
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const at = Date.parse(String(event.time ?? ""));
        if (!Number.isFinite(at) || !event.title || !event.artist) continue;
        if (
          event.event === "track.added" ||
          event.event === "track.autoplay_added"
        ) {
          if (event.trackId) added.set(String(event.trackId), at);
          continue;
        }
        const outcome =
          event.event === "track.finished"
            ? "finished"
            : event.event === "track.skipped"
              ? "skipped"
              : event.event === "track.removed"
                ? "removed"
                : undefined;
        if (!outcome) continue;
        const actor =
          event.actor?.id && event.actor.id !== "system"
            ? String(event.actor.id)
            : undefined;
        if (outcome !== "finished" && !actor) continue;
        const sessionId = String(event.sessionId ?? "");
        if (!listeners.has(sessionId))
          listeners.set(sessionId, sessionId ? participants(sessionId) : []);
        const addedBy =
          event.requesterId === "recommended"
            ? "agent"
            : event.origin === "autoplay"
              ? "autoplay"
              : String(event.requesterId ?? "unknown");
        const queuedAt = event.trackId
          ? added.get(String(event.trackId))
          : undefined;
        insert.run(
          sessionId,
          at,
          String(event.title),
          String(event.artist),
          addedBy,
          outcome === "finished" ? null : (actor ?? null),
          outcome,
          typeof event.playedSeconds === "number" ? event.playedSeconds : null,
          outcome === "removed" && queuedAt !== undefined
            ? Math.max(0, Math.round((at - queuedAt) / 1000))
            : null,
          JSON.stringify(listeners.get(sessionId)),
          neutral,
        );
        imported++;
      }
      this.db
        .query(
          "INSERT INTO smart_meta (key, value) VALUES ('audit_imported', ?)",
        )
        .run(String(this.now()));
    })();
    log.info({ event: "audit_imported", imported }, "Imported past outcomes");
    return { imported, skipped: false };
  }

  /**
   * Looks up profiles for songs that have outcomes but no profile, one at a
   * time and slowly (MusicBrainz allows one request a second), most played
   * first. Stops when every song has been tried or `stop` says so.
   */
  async backfillProfiles(
    options: { delayMs?: number; limit?: number; stop?: () => boolean } = {},
  ) {
    if (!this.config.lastFmApiKey) return 0;
    const songs = this.db
      .query(
        `SELECT o.title, o.artist, COUNT(*) AS plays FROM song_outcomes o
          LEFT JOIN song_profiles p
            ON p.key = lower(o.artist) || char(0) || lower(o.title)
          WHERE p.key IS NULL
          GROUP BY lower(o.artist), lower(o.title)
          ORDER BY plays DESC LIMIT ?`,
      )
      .all(options.limit ?? 2000) as { title: string; artist: string }[];
    let filled = 0;
    for (const song of songs) {
      if (options.stop?.()) break;
      if (this.profile(song.title, song.artist)) continue;
      if (await this.ensureProfile(song.title, song.artist)) filled++;
      await Bun.sleep(options.delayMs ?? 1500);
    }
    log.info(
      { event: "profiles_backfilled", tried: songs.length, filled },
      "Backfilled song profiles",
    );
    return filled;
  }

  // Outcomes ----------------------------------------------------------------

  recordOutcome(
    song: {
      title: string;
      artist: string;
      addedBy: string;
      actor?: string;
      outcome: Outcome;
      playedSeconds?: number;
      queuedSeconds?: number;
    },
    context: RankContext,
  ) {
    const strategy = this.activeStrategy();
    const tastes = new Map(
      context.listeners.map((id) => [id, this.taste(id)] as const),
    );
    const mood = this.sessionMood(context.recent);
    const features = this.features(
      { ...song, forUsers: song.addedBy.startsWith("U") ? [song.addedBy] : [] },
      context,
      tastes,
      mood,
      strategy.weights,
    );
    // The catalog's order is unknown afterwards; replays treat it as neutral.
    features.base = 0.5;
    const key = profileKey(song.title, song.artist);
    const version =
      song.addedBy === "agent"
        ? (this.pickedBy.get(key) ?? strategy.version)
        : strategy.version;
    this.db
      .query(
        `INSERT INTO song_outcomes
          (session_id, at, title, artist, added_by, actor, outcome,
           played_seconds, queued_seconds, listeners, features, context,
           strategy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        context.sessionId,
        this.now(),
        song.title,
        song.artist,
        song.addedBy,
        song.actor ?? null,
        song.outcome,
        song.playedSeconds ?? null,
        song.queuedSeconds ?? null,
        JSON.stringify(context.listeners),
        JSON.stringify(features),
        JSON.stringify({
          mood,
          hour: context.hour,
          lastRequester: context.lastRequester ?? null,
          profile: this.profile(song.title, song.artist) ?? null,
        }),
        version,
      );
    if (song.addedBy === "agent") this.settleTrial();
  }

  /** Recent outcomes, for an agent reflecting on what worked. */
  outcomes(options: { limit?: number; addedBy?: string } = {}) {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const rows = (
      options.addedBy
        ? this.db
            .query(
              "SELECT * FROM song_outcomes WHERE added_by = ? ORDER BY at DESC LIMIT ?",
            )
            .all(options.addedBy, limit)
        : this.db
            .query("SELECT * FROM song_outcomes ORDER BY at DESC LIMIT ?")
            .all(limit)
    ) as Record<string, any>[];
    return rows.map((row) => ({
      at: new Date(Number(row.at)).toISOString(),
      title: row.title,
      artist: row.artist,
      addedBy: row.added_by,
      ...(row.actor ? { actor: row.actor } : {}),
      outcome: row.outcome,
      ...(row.played_seconds !== null
        ? { playedSeconds: row.played_seconds }
        : {}),
      ...(row.queued_seconds !== null
        ? { queuedSeconds: row.queued_seconds }
        : {}),
      listeners: JSON.parse(row.listeners),
      strategyVersion: row.strategy_version,
    }));
  }

  /** Kept (true), rejected (false), or neither, for learning. */
  private static verdict(row: Record<string, any>) {
    if (row.outcome === "finished") return true;
    if (row.outcome === "removed") return false;
    // A skip late in a song says little.
    if (row.outcome === "skipped")
      return (row.played_seconds ?? 0) < 60 ? false : undefined;
    return undefined;
  }

  // Strategies --------------------------------------------------------------

  private strategyRows() {
    return (
      this.db
        .query("SELECT * FROM rec_strategies ORDER BY version DESC")
        .all() as Record<string, any>[]
    ).map(rowStrategy);
  }

  activeStrategy(): Strategy {
    const active = this.strategyRows().find((item) => item.status === "active");
    return (
      active ?? {
        version: 0,
        weights: defaultWeights,
        note: "built-in defaults",
        status: "active",
        createdAt: 0,
      }
    );
  }

  trialStrategy() {
    return this.strategyRows().find((item) => item.status === "trial");
  }

  strategies(limit = 10) {
    return this.strategyRows().slice(0, limit);
  }

  /**
   * A new strategy from changed weights and/or a script. It is checked on
   * the stored outcomes first, then tried on half the agent's picks against
   * the active one, and only replaces it when its picks are rejected no
   * more often.
   */
  async proposeStrategy(input: {
    weights?: Record<string, unknown>;
    script?: string | null;
    note?: string;
  }) {
    const { weights, errors } = validateWeights(input.weights ?? {});
    if (errors.length) return { ok: false as const, error: errors.join("; ") };
    const active = this.activeStrategy();
    const merged: Weights = { ...active.weights, ...weights };
    const script =
      input.script === null
        ? undefined
        : typeof input.script === "string" && input.script.trim()
          ? input.script
          : active.script;
    if (script && script.length > 20_000)
      return {
        ok: false as const,
        error: "script is longer than 20000 characters",
      };
    const evaluation = await this.evaluate({ weights: merged, script });
    if (!evaluation.ok) return evaluation;
    this.db.run(
      "UPDATE rec_strategies SET status = 'retired' WHERE status = 'trial'",
    );
    const version = (this.strategyRows()[0]?.version ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO rec_strategies
          (version, weights, script, note, status, created_at, result)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version,
        JSON.stringify(merged),
        script ?? null,
        String(input.note ?? "").slice(0, 500),
        "trial",
        this.now(),
        JSON.stringify({ evaluation: evaluation.summary }),
      );
    return {
      ok: true as const,
      version,
      status: "trial",
      evaluation: evaluation.summary,
      note: `Tried on half of your picks against version ${active.version}; it takes over after ${trialMinimum} picks each if they are removed or skipped no more often.`,
    };
  }

  /** Puts an earlier version back as the active one. */
  rollback(version?: number) {
    const rows = this.strategyRows();
    const active = rows.find((item) => item.status === "active");
    const target =
      version === undefined
        ? rows.find(
            (item) =>
              item.status === "retired" &&
              item.version < (active?.version ?? 0),
          )
        : rows.find((item) => item.version === version);
    if (version === 0 || (!target && version === undefined && active)) {
      this.db.run(
        "UPDATE rec_strategies SET status = 'retired' WHERE status IN ('active', 'trial')",
      );
      return {
        ok: true as const,
        active: 0,
        note: "back to built-in defaults",
      };
    }
    if (!target) return { ok: false as const, error: "no such version" };
    this.db.run(
      "UPDATE rec_strategies SET status = 'retired' WHERE status IN ('active', 'trial')",
    );
    this.db
      .query("UPDATE rec_strategies SET status = 'active' WHERE version = ?")
      .run(target.version);
    return { ok: true as const, active: target.version };
  }

  /**
   * Replays stored outcomes through a strategy: how often it scores songs
   * people kept above songs they removed or skipped (0.5 is chance), next to
   * the active strategy's figure.
   */
  async evaluate(input: { weights?: Partial<Weights>; script?: string }) {
    const rows = this.db
      .query("SELECT * FROM song_outcomes ORDER BY at DESC LIMIT 500")
      .all() as Record<string, any>[];
    const labelled = rows
      .map((row) => ({ row, kept: SmartRecs.verdict(row) }))
      .filter((item) => item.kept !== undefined);
    const weights: Weights = {
      ...this.activeStrategy().weights,
      ...input.weights,
    };
    const scoreAll = async (strategy: {
      weights: Weights;
      script?: string;
    }) => {
      const base = labelled.map(({ row }) =>
        linearScore(JSON.parse(row.features) as Features, strategy.weights),
      );
      if (!strategy.script) return base;
      const extra = await runScoringScript(
        strategy.script,
        labelled.map(({ row }) => scriptInput(row)),
        Math.max(scriptBudgetMs, labelled.length * 2),
      );
      return base.map(
        (value, index) => value + strategy.weights.script * extra[index]!,
      );
    };
    if (input.script) {
      const failed = await smokeTest(input.script);
      if (failed) return { ok: false as const, error: failed };
    }
    let proposed: number[];
    try {
      proposed = await scoreAll({ weights, script: input.script });
    } catch (error) {
      return {
        ok: false as const,
        error: `script failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const active = this.activeStrategy();
    const current = await scoreAll(active).catch(() =>
      labelled.map(({ row }) =>
        linearScore(JSON.parse(row.features) as Features, active.weights),
      ),
    );
    const split = (scores: number[]) =>
      separation(
        scores.filter((_, index) => labelled[index]!.kept),
        scores.filter((_, index) => !labelled[index]!.kept),
      );
    const proposedFigure = split(proposed);
    const currentFigure = split(current);
    const round = (value: number | undefined) =>
      value === undefined ? null : Math.round(value * 1000) / 1000;
    return {
      ok: true as const,
      summary: {
        outcomes: labelled.length,
        kept: labelled.filter((item) => item.kept).length,
        rejected: labelled.filter((item) => !item.kept).length,
        separation: round(proposedFigure),
        activeSeparation: round(currentFigure),
        activeVersion: active.version,
        ...(labelled.length < 20
          ? { warning: "Few outcomes yet; the figures will move a lot." }
          : {}),
      },
    };
  }

  // Promotes a trial whose picks are rejected no more often than the active
  // strategy's, or drops one that does worse, once both have enough picks.
  private settleTrial() {
    const trial = this.trialStrategy();
    if (!trial) return;
    const active = this.activeStrategy();
    const rate = (version: number) => {
      const rows = this.db
        .query(
          `SELECT outcome, played_seconds, queued_seconds FROM song_outcomes
            WHERE added_by = 'agent' AND strategy_version = ? AND at >= ?`,
        )
        .all(version, trial.createdAt) as Record<string, any>[];
      const verdicts = rows
        .map((row) => SmartRecs.verdict(row))
        .filter((kept) => kept !== undefined);
      return {
        picks: verdicts.length,
        rejected: verdicts.length
          ? verdicts.filter((kept) => !kept).length / verdicts.length
          : 0,
      };
    };
    const tried = rate(trial.version);
    const control = rate(active.version);
    if (tried.picks < trialMinimum || control.picks < trialMinimum) return;
    const result = JSON.stringify({
      trial: tried,
      control: { version: active.version, ...control },
    });
    if (tried.rejected > control.rejected + trialMargin) {
      this.db
        .query(
          "UPDATE rec_strategies SET status = 'rejected', result = ? WHERE version = ?",
        )
        .run(result, trial.version);
      log.info(
        { event: "strategy_rejected", version: trial.version, ...tried },
        "Strategy trial did worse and was dropped",
      );
      return;
    }
    this.db.run(
      "UPDATE rec_strategies SET status = 'retired' WHERE status = 'active'",
    );
    this.db
      .query(
        "UPDATE rec_strategies SET status = 'active', result = ? WHERE version = ?",
      )
      .run(result, trial.version);
    log.info(
      { event: "strategy_promoted", version: trial.version, ...tried },
      "Strategy trial took over",
    );
  }

  /** How often the agent's latest picks were rejected, 0..1. */
  recentRejection(limit = 20) {
    const rows = this.db
      .query(
        `SELECT outcome, played_seconds, queued_seconds FROM song_outcomes
          WHERE added_by = 'agent' ORDER BY at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, any>[];
    const verdicts = rows
      .map((row) => SmartRecs.verdict(row))
      .filter((kept) => kept !== undefined);
    return verdicts.length
      ? verdicts.filter((kept) => !kept).length / verdicts.length
      : undefined;
  }

  // Ranking -----------------------------------------------------------------

  /**
   * Orders candidates for the people listening: the built-in score (plus the
   * strategy's script, if any), then a share of the picks given to songs
   * that try something new. The share shrinks while picks keep being
   * rejected and grows while they are kept.
   */
  async rank(candidates: RankCandidate[], context: RankContext, count = 5) {
    const strategyFor =
      this.trialStrategy() && this.random() < 0.5
        ? this.trialStrategy()!
        : this.activeStrategy();
    const weights = strategyFor.weights;
    const tastes = new Map(
      [
        ...new Set([
          ...context.listeners,
          ...(context.lastRequester ? [context.lastRequester.userId] : []),
        ]),
      ].map((id) => [id, this.taste(id)] as const),
    );
    const mood = this.sessionMood(context.recent);
    const scored = candidates.map((candidate) => {
      const features = this.features(
        { ...candidate, of: candidates.length },
        context,
        tastes,
        mood,
        weights,
      );
      return {
        candidate,
        features,
        profile: this.profile(candidate.title, candidate.artist),
        score: linearScore(features, weights),
      };
    });
    let scriptError: string | undefined;
    if (strategyFor.script && scored.length) {
      try {
        const extra = await runScoringScript(
          strategyFor.script,
          scored.map((item) => ({
            song: {
              title: item.candidate.title,
              artist: item.candidate.artist,
              forUsers: item.candidate.forUsers,
              sources: item.candidate.sources,
              discovery: item.candidate.discovery,
              profile: item.profile ?? null,
              features: item.features,
            },
            ctx: {
              listeners: context.listeners,
              lastRequester: context.lastRequester ?? null,
              hour: context.hour,
              mood,
            },
          })),
        );
        scored.forEach((item, index) => {
          item.score += weights.script * extra[index]!;
        });
      } catch (error) {
        scriptError = error instanceof Error ? error.message : String(error);
        log.warn(
          {
            event: "strategy_script_failed",
            version: strategyFor.version,
            err: error,
          },
          "Strategy script failed; using the built-in score",
        );
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const rejection = this.recentRejection();
    const explore = Math.max(
      weights.exploreMin,
      Math.min(
        weights.exploreMax,
        rejection === undefined
          ? weights.explore
          : weights.explore * (1 + (0.3 - rejection) * 2),
      ),
    );
    const exploreCount =
      count > 1 ? Math.min(count - 1, Math.round(count * explore)) : 0;
    const safe = scored.filter((item) => item.features.rejected < 0.5);
    const picked: ((typeof scored)[number] & { explore: boolean })[] = [];
    const used = new Set<string>();
    const take = (item: (typeof scored)[number], exploring: boolean) => {
      const key = profileKey(item.candidate.title, item.candidate.artist);
      if (used.has(key)) return;
      used.add(key);
      picked.push({ ...item, explore: exploring });
    };
    // Something new: a discovery, or, once there is taste to go on, a song
    // nobody's taste points at yet.
    const known = [...tastes.values()].some((taste) => taste.evidence > 0);
    const isFresh = (item: (typeof scored)[number]) =>
      item.candidate.discovery ||
      (known && item.features.genreMatch < 0.15 && item.features.shared === 0);
    for (const item of safe) {
      if (picked.length >= count - exploreCount) break;
      if (!isFresh(item)) take(item, false);
    }
    let explored = 0;
    for (const item of safe) {
      if (picked.length >= count || explored >= exploreCount) break;
      if (
        isFresh(item) &&
        !used.has(profileKey(item.candidate.title, item.candidate.artist))
      ) {
        take(item, true);
        explored++;
      }
    }
    for (const item of scored) {
      if (picked.length >= count) break;
      take(item, false);
    }
    const summarize = (taste: Taste) => {
      const top = (record: Record<string, number>, n = 3) =>
        Object.entries(record)
          .filter(([, value]) => value > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([key]) => key);
      const avoid = (record: Record<string, number>) =>
        Object.entries(record)
          .filter(([, value]) => value < 0)
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3)
          .map(([key]) => key);
      return {
        likes: {
          genres: top(taste.genres),
          moods: top(taste.moods),
          countries: top(taste.countries),
          artists: top(taste.artists),
        },
        avoids: { genres: avoid(taste.genres), artists: avoid(taste.artists) },
        ...(taste.energy ? { energy: Math.round(taste.energy * 10) / 10 } : {}),
        evidence: taste.evidence,
      };
    };
    for (const item of picked) {
      this.pickedBy.delete(
        profileKey(item.candidate.title, item.candidate.artist),
      );
      this.pickedBy.set(
        profileKey(item.candidate.title, item.candidate.artist),
        strategyFor.version,
      );
    }
    while (this.pickedBy.size > 500) {
      const oldest = this.pickedBy.keys().next().value;
      if (oldest === undefined) break;
      this.pickedBy.delete(oldest);
    }
    return {
      strategy: {
        version: strategyFor.version,
        status: strategyFor.status,
        ...(scriptError ? { scriptError } : {}),
      },
      explore: {
        share: Math.round(explore * 100) / 100,
        ...(rejection !== undefined
          ? { recentRejection: Math.round(rejection * 100) / 100 }
          : {}),
      },
      mood,
      listeners: context.listeners.map((id) => ({
        id,
        ...summarize(tastes.get(id)!),
      })),
      picks: picked.map((item) => ({
        title: item.candidate.title,
        artist: item.candidate.artist,
        reference: item.candidate.reference,
        forUsers: item.candidate.forUsers,
        sources: item.candidate.sources,
        explore: item.explore,
        score: Math.round(item.score * 100) / 100,
        profile: item.profile
          ? {
              genres: item.profile.genres,
              moods: item.profile.moods,
              ...(item.profile.country
                ? { country: item.profile.country }
                : {}),
              ...(item.profile.energy ? { energy: item.profile.energy } : {}),
              ...(item.profile.era ? { era: item.profile.era } : {}),
            }
          : null,
        why: explain(item.features, item.explore),
      })),
    };
  }
}

// Runs a script once on a made-up song, so a broken one is refused even
// before there are outcomes to replay.
async function smokeTest(script: string) {
  try {
    await runScoringScript(script, [
      {
        song: {
          title: "Example",
          artist: "Band",
          forUsers: ["U01EXAMPLE"],
          sources: ["similar"],
          discovery: false,
          profile: { genres: ["pop"], moods: ["chill"], energy: 2 },
          features: {
            base: 0.5,
            shared: 0,
            genreMatch: 0.2,
            moodMatch: 0.5,
            energyJump: 0,
            lastRequester: 0,
            rejected: 0,
          },
        },
        ctx: {
          listeners: ["U01EXAMPLE"],
          lastRequester: null,
          hour: 12,
          mood: { genres: ["pop"], moods: ["chill"], countries: [] },
        },
      },
    ]);
    return undefined;
  } catch (error) {
    return `script failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function explain(features: Features, explore: boolean) {
  const reasons: string[] = [];
  if (explore) reasons.push("something new");
  if (features.shared > 0) reasons.push("suits several listeners");
  if (features.genreMatch >= 0.3) reasons.push("their usual genres");
  if (features.moodMatch >= 0.5) reasons.push("keeps the mood");
  if (features.lastRequester >= 0.3) reasons.push("follows the last request");
  if (features.energyJump >= 0.5) reasons.push("big energy change");
  if (features.rejected >= 0.3) reasons.push("listeners removed similar songs");
  return reasons;
}

function scriptInput(row: Record<string, any>) {
  const context = JSON.parse(row.context) as Record<string, any>;
  return {
    song: {
      title: row.title,
      artist: row.artist,
      forUsers: String(row.added_by).startsWith("U") ? [row.added_by] : [],
      sources: [],
      discovery: false,
      profile: context.profile ?? null,
      features: JSON.parse(row.features),
    },
    ctx: {
      listeners: JSON.parse(row.listeners),
      lastRequester: context.lastRequester ?? null,
      hour: context.hour ?? 12,
      mood: context.mood ?? { genres: [], moods: [], countries: [] },
    },
  };
}

function rowVocabulary(row: Record<string, any>): VocabularyEntry {
  return {
    kind: row.kind,
    value: row.value,
    keys: JSON.parse(row.keys),
    ...(row.energy ? { energy: row.energy } : {}),
    ...(row.language ? { language: row.language } : {}),
    priority: row.priority,
    ...(row.note ? { note: row.note } : {}),
    origin: row.origin,
  };
}

function rowProfile(row: Record<string, any>): SongProfile {
  return {
    title: row.title,
    artist: row.artist,
    ...(row.country ? { country: row.country } : {}),
    ...(row.language ? { language: row.language } : {}),
    genres: JSON.parse(row.genres),
    moods: JSON.parse(row.moods),
    ...(row.energy ? { energy: row.energy } : {}),
    ...(row.era ? { era: row.era } : {}),
    source: row.source,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  };
}

function rowStrategy(row: Record<string, any>): Strategy {
  return {
    version: row.version,
    weights: { ...defaultWeights, ...JSON.parse(row.weights) },
    ...(row.script ? { script: row.script } : {}),
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    ...(row.result ? { result: row.result } : {}),
  };
}
