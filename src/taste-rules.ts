import type { Database } from "bun:sqlite";

// What a person says outright about their taste ("no K-pop for me", "more
// Mac DeMarco"), next to what is learnt from what they play and skip. Each
// rule is the person's own: they set it from Your taste or through an agent
// acting for them, and it counts only while they are listening.

export const tasteKinds = ["genres", "moods", "countries", "artists"] as const;
export type TasteKind = (typeof tasteKinds)[number];
export type TasteLists = Record<TasteKind, string[]>;
export type TasteStance = "like" | "avoid";
export type TasteRuleSet = { like: TasteLists; avoid: TasteLists };
export type TasteChange = {
  like?: Partial<TasteLists>;
  avoid?: Partial<TasteLists>;
  // Values to drop, whichever stance they had.
  unset?: Partial<TasteLists>;
  // Start from nothing, as a form that shows every rule submits all of them.
  replace?: boolean;
};

// A vocabulary entry as far as matching a person's words to it goes.
export type TasteTerm = { value: string; keys: string[] };
export type TasteVocabulary = {
  genres: TasteTerm[];
  moods: TasteTerm[];
  countries: TasteTerm[];
};

export const emptyLists = (): TasteLists => ({
  genres: [],
  moods: [],
  countries: [],
  artists: [],
});

const normalize = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The vocabulary value a person's word means: the value itself, or a value
 * one of whose tag words it is ("korea" and "korean" are KR, "kpop" is
 * k-pop). Undefined when nothing fits, so a typo is reported, not kept.
 */
export function matchTerm(word: string, terms: TasteTerm[]) {
  const wanted = normalize(word);
  if (!wanted) return undefined;
  const exact = terms.find((term) => normalize(term.value) === wanted);
  if (exact) return exact.value;
  const byKey = terms.find((term) =>
    term.keys.some((key) => {
      const k = normalize(key);
      return (
        k === wanted ||
        (wanted.length >= 4 && (k.startsWith(wanted) || wanted.startsWith(k)))
      );
    }),
  );
  return byKey?.value;
}

/** Words a person gave, as the values stored for them, plus what fit none. */
export function resolveLists(
  input: Partial<Record<TasteKind, unknown>> | undefined,
  vocabulary: TasteVocabulary,
) {
  const lists = emptyLists();
  const unknown: string[] = [];
  if (!input) return { lists, unknown };
  for (const kind of tasteKinds) {
    const raw = input[kind];
    const words = (
      Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []
    )
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 50);
    for (const word of words) {
      if (kind === "artists") {
        const artist = word.replace(/\s+/g, " ").slice(0, 100);
        if (
          !lists.artists.some((item) => normalize(item) === normalize(artist))
        )
          lists.artists.push(artist);
        continue;
      }
      const value = matchTerm(word, vocabulary[kind]);
      if (value === undefined) unknown.push(`${kind}: ${word}`);
      else if (!lists[kind].includes(value)) lists[kind].push(value);
    }
  }
  return { lists, unknown };
}

export class TasteRules {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {
    db.run(`
      CREATE TABLE IF NOT EXISTS user_taste_rules (
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        stance TEXT NOT NULL,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, value)
      ) WITHOUT ROWID`);
  }

  get(userId: string): TasteRuleSet {
    const rules = { like: emptyLists(), avoid: emptyLists() };
    const rows = this.db
      .query(
        "SELECT kind, value, stance FROM user_taste_rules WHERE user_id = ? ORDER BY set_at, value",
      )
      .all(userId) as { kind: TasteKind; value: string; stance: TasteStance }[];
    for (const row of rows)
      if (tasteKinds.includes(row.kind) && row.stance in rules)
        rules[row.stance][row.kind].push(row.value);
    return rules;
  }

  count(userId: string) {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM user_taste_rules WHERE user_id = ?")
      .get(userId) as { n: number };
    return row.n;
  }

  /** Applies already resolved lists; a value takes the last stance given. */
  set(
    userId: string,
    change: {
      like?: TasteLists;
      avoid?: TasteLists;
      unset?: TasteLists;
      replace?: boolean;
    },
  ) {
    const upsert = this.db.query(
      `INSERT INTO user_taste_rules (user_id, kind, value, stance, set_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, kind, value)
       DO UPDATE SET stance = excluded.stance, set_at = excluded.set_at`,
    );
    const drop = this.db.query(
      "DELETE FROM user_taste_rules WHERE user_id = ? AND kind = ? AND lower(value) = lower(?)",
    );
    this.db.transaction(() => {
      if (change.replace)
        this.db
          .query("DELETE FROM user_taste_rules WHERE user_id = ?")
          .run(userId);
      for (const kind of tasteKinds) {
        for (const value of change.unset?.[kind] ?? [])
          drop.run(userId, kind, value);
        for (const stance of ["like", "avoid"] as const)
          for (const value of change[stance]?.[kind] ?? []) {
            // An artist written differently is still the same artist.
            if (kind === "artists") drop.run(userId, kind, value);
            upsert.run(userId, kind, value, stance, this.now());
          }
      }
    })();
    return this.get(userId);
  }

  clear(userId: string) {
    return this.db
      .query("DELETE FROM user_taste_rules WHERE user_id = ?")
      .run(userId).changes;
  }

  /**
   * Who among the listeners said they want none of this song, and why. An
   * artist matches by name; genres, moods and country need the song's
   * profile, so a song nothing is known about yet is not held back.
   */
  avoiders(
    userIds: Iterable<string>,
    song: {
      artist: string;
      profile?: { genres: string[]; moods: string[]; country?: string };
    },
  ) {
    const found: { userId: string; kind: TasteKind; value: string }[] = [];
    const artist = normalize(song.artist);
    for (const userId of new Set(userIds)) {
      const { avoid } = this.get(userId);
      const hit = (kind: TasteKind, values: string[]) => {
        const value = avoid[kind].find((item) =>
          kind === "artists"
            ? artist === normalize(item) ||
              artist
                .split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/)
                .includes(normalize(item))
            : values.includes(item),
        );
        if (value !== undefined) found.push({ userId, kind, value });
        return value !== undefined;
      };
      hit("artists", []) ||
        hit("genres", song.profile?.genres ?? []) ||
        hit("moods", song.profile?.moods ?? []) ||
        hit("countries", song.profile?.country ? [song.profile.country] : []);
    }
    return found;
  }
}
