import { timingSafeEqual } from "node:crypto";
import type { IntegrationCommand } from "./integration.ts";
import { defaultWeights, type SmartRecs } from "./smart.ts";
import { smartGuide } from "./smart-guide.ts";
import {
  autoplayModes,
  displayModes,
  duckingModes,
  loopModes,
  modeOf,
  transitionModes,
} from "./store.ts";

/** What the MCP server needs of the running app. */
export type McpHost = {
  token?: string;
  // Who commands run as, with that user's permissions in the session.
  actorId?: string;
  version: string;
  // The active session of a Huddle's thread, when there is one.
  session(
    channel: string,
    threadTs: string,
  ):
    | {
        id: string;
        run(
          userId: string,
          command: IntegrationCommand,
        ): Promise<{ ok: boolean; [key: string]: unknown }>;
      }
    | undefined;
  // Song profiles, outcomes and ranking strategies, shared by all Huddles.
  smart?: Pick<
    SmartRecs,
    | "profile"
    | "setProfile"
    | "activeStrategy"
    | "trialStrategy"
    | "strategies"
    | "proposeStrategy"
    | "evaluate"
    | "rollback"
    | "outcomes"
    | "vocabulary"
    | "setVocabulary"
    | "deleteVocabulary"
    | "resetVocabulary"
    | "vocabularyLog"
  >;
  // Brings HuddleFM into the active Huddle of a thread, hosted by userId.
  join(
    channel: string,
    threadTs: string,
    userId: string,
  ): Promise<{ ok: boolean; [key: string]: unknown }>;
};

const channel = {
  type: "string",
  description: "Slack channel ID of the Huddle's thread",
};
const threadTs = {
  type: "string",
  description: "Timestamp of the Huddle's message (its thread)",
};
const tool = (
  name: string,
  description: string,
  type: IntegrationCommand["type"],
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  name,
  description,
  type,
  inputSchema: {
    type: "object",
    properties: { channel, thread_ts: threadTs, ...properties },
    required: ["channel", "thread_ts", ...required],
    additionalProperties: false,
  },
});

// Descriptions and errors are read by agents, which repeat their words to
// people, so they speak of playing rather than of HuddleFM or sessions.

// Joining is a Huddle's alone: it needs the thread of a Huddle that is on,
// and someone in it to host, as a mention does.
const joinTool = {
  name: "join",
  description:
    "Join the active Huddle of a thread; user must be in the Huddle and becomes host",
  inputSchema: {
    type: "object",
    properties: {
      channel,
      thread_ts: threadTs,
      user: {
        type: "string",
        description: "Slack user ID of who asked; must be in the Huddle",
      },
    },
    required: ["channel", "thread_ts", "user"],
    additionalProperties: false,
  },
};

// The session's settings MCP can change, each a boolean or one of its modes.
// A new setting the coordinator takes is one more line here.
const sessionSettings = {
  autoplay: "boolean",
  autoplayMode: autoplayModes,
  loopMode: loopModes,
  displayMode: displayModes,
  transitionMode: transitionModes,
  duckingMode: duckingModes,
  anchorEnabled: "boolean",
} satisfies Partial<
  Record<keyof IntegrationCommand, "boolean" | readonly string[]>
>;

export const mcpTools = [
  tool("status", "What is playing, the queue and settings", "status"),
  tool(
    "history",
    "Who is listening and what became of recent songs: who added each, and whether it played out, was skipped or removed, by whom and how soon; check it before recommending",
    "history",
    {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "How many recent events, newest last; default 30",
      },
    },
  ),
  tool(
    "recommend",
    "Songs to add next, ranked for who is listening: each pick with a reference for add, who it suits and why, plus each listener's likes and avoids, the mood, who asked last and which songs lack a genre or mood (fill them with profile_set). Pick from these, and add your own only after search.",
    "recommend",
    {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "How many picks; default 5",
      },
    },
  ),
  tool(
    "search",
    "Search songs; returns references to add",
    "search",
    {
      query: { type: "string" },
    },
    ["query"],
  ),
  tool(
    "add",
    "Add a song by a reference from search, or a link",
    "add",
    {
      reference: { type: "string" },
      requested_by: {
        type: "string",
        description:
          "Slack user ID of who asked for the song, shown as who added it; leave it out when nobody asked and the song shows as a recommendation",
      },
    },
    ["reference"],
  ),
  tool(
    "move",
    "Move songs in the queue to a position, in the order given, as one block; ids come from status",
    "move",
    {
      track_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Queue song ids from status, in the order they should play",
      },
      position: {
        type: "integer",
        minimum: 1,
        description: "Queue position the first song lands on; 1 is next",
      },
      play_next: {
        type: "boolean",
        description: "Same as position 1",
      },
    },
    ["track_ids"],
  ),
  tool(
    "remove",
    "Remove songs from the queue; ids come from status",
    "remove",
    {
      track_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Queue song ids from status to take out",
      },
    },
    ["track_ids"],
  ),
  tool("shuffle", "Shuffle the queue", "shuffle"),
  tool("clear", "Remove every song from the queue", "clear"),
  tool("skip", "Skip to the next song", "skip"),
  tool("previous", "Go back to the previous song", "previous"),
  tool("pause", "Pause playback", "pause"),
  tool("resume", "Resume playback", "resume"),
  tool("leave", "Stop the music and leave the Huddle", "end"),
  tool(
    "settings",
    "Change how the music plays; only the fields given change",
    "settings",
    Object.fromEntries(
      Object.entries(sessionSettings).map(([key, kind]) => [
        key,
        kind === "boolean"
          ? { type: "boolean" }
          : { type: "string", enum: [...kind] },
      ]),
    ),
  ),
  tool(
    "volume",
    "Set the volume",
    "volume",
    {
      percent: { type: "number", minimum: 0, maximum: 100 },
    },
    ["percent"],
  ),
];

const weightProperties = Object.fromEntries(
  Object.keys(defaultWeights).map((key) => [key, { type: "number" }]),
);
const songProperties = {
  title: { type: "string" },
  artist: { type: "string" },
};

// Tools about songs and strategies rather than one Huddle: no thread needed.
// Genre and mood lists come from the vocabulary, so they grow with it.
export const smartTools = (
  vocabulary: ReturnType<NonNullable<McpHost["smart"]>["vocabulary"]>,
) => [
  {
    name: "guide",
    description:
      "How to recommend well here: the loop (history, recommend, add, profile_set, outcomes), how to grow the vocabulary and tune the strategy. Read it once per session.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "vocabulary_get",
    description:
      "The genres, moods and places songs are described with, each with the tag words that map to it, plus recent changes",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "vocabulary_set",
    description:
      "Add or change a genre, mood or place (only the fields given change). Use it when songs keep arriving with a style the list lacks, or a tag maps wrongly",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["genre", "mood", "place"] },
        value: {
          type: "string",
          description:
            "Lowercase label (genre/mood) or ISO 3166 alpha-2 (place)",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "Tag words that mean it, matched at the start of a word in Last.fm tags; replaces the list",
        },
        energy: { type: "integer", minimum: 1, maximum: 5 },
        language: { type: "string", description: "Places: ISO 639-1" },
        priority: {
          type: "integer",
          description:
            "Lower is matched first; put specific entries (k-pop) before broad ones (pop)",
        },
        note: { type: "string", description: "Why, in a sentence" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "vocabulary_delete",
    description:
      "Remove a genre, mood or place; songs already profiled keep the label",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["genre", "mood", "place"] },
        value: { type: "string" },
        note: { type: "string" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "vocabulary_reset",
    description: "Put a built-in genre, mood or place back as it shipped",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["genre", "mood", "place"] },
        value: { type: "string" },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "profile_get",
    description:
      "A song's profile: country, language, genres, moods, energy, era",
    inputSchema: {
      type: "object",
      properties: songProperties,
      required: ["title", "artist"],
      additionalProperties: false,
    },
  },
  {
    name: "profile_set",
    description:
      "Fill in a song's profile when it has none or it is wrong; ranking uses it to match listeners and keep the mood",
    inputSchema: {
      type: "object",
      properties: {
        ...songProperties,
        genres: {
          type: "array",
          items: {
            type: "string",
            enum: vocabulary.genres.map((entry) => entry.value),
          },
          maxItems: 2,
        },
        moods: {
          type: "array",
          items: {
            type: "string",
            enum: vocabulary.moods.map((entry) => entry.value),
          },
          maxItems: 2,
        },
        country: {
          type: "string",
          description: "Artist's country, ISO 3166 alpha-2 (ID, KR, US)",
        },
        language: {
          type: "string",
          description: "Lyrics language, ISO 639-1 (id, ko, en)",
        },
        energy: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "1 calm to 5 intense",
        },
        era: { type: "string", description: "Decade, e.g. 2000s" },
      },
      required: ["title", "artist"],
      additionalProperties: false,
    },
  },
  {
    name: "outcomes",
    description:
      "What became of past songs across sessions (played out, skipped, removed), to learn which picks work; added_by=agent for your own picks",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        added_by: {
          type: "string",
          description: "agent, autoplay or a Slack user ID",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "strategy_get",
    description:
      "The ranking strategy in use (weights and optional scoring script), any strategy on trial, and earlier versions",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "strategy_eval",
    description:
      "Replay past outcomes through changed weights and/or a script without using it: how often it ranks kept songs above removed or skipped ones (0.5 is chance), next to the active strategy",
    inputSchema: {
      type: "object",
      properties: {
        weights: { type: "object", properties: weightProperties },
        script: {
          type: "string",
          description:
            "JavaScript defining function score(song, ctx) returning a number (-5..5), added to the built-in score times weights.script. song: title, artist, forUsers, sources, discovery, profile, features; ctx: listeners, lastRequester, hour, mood. Runs sandboxed: no network, files or timers, 150ms.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "strategy_set",
    description:
      "Propose changed weights and/or a scoring script (same as strategy_eval). It is checked on past outcomes, then tried on half your picks and takes over only if they are removed or skipped no more often; script null drops the script",
    inputSchema: {
      type: "object",
      properties: {
        weights: { type: "object", properties: weightProperties },
        script: { type: ["string", "null"] },
        note: { type: "string", description: "Why, in a sentence" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "strategy_rollback",
    description:
      "Put an earlier strategy version back in use; 0 is the built-in defaults, no version is the previous one",
    inputSchema: {
      type: "object",
      properties: { version: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },
];

async function callSmart(
  name: string,
  args: Record<string, unknown>,
  smart: NonNullable<McpHost["smart"]>,
  by?: string,
) {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  switch (name) {
    case "guide":
      return { content: [{ type: "text", text: smartGuide }] };
    case "vocabulary_get": {
      const vocabulary = smart.vocabulary();
      const brief = (entries: typeof vocabulary.genres) =>
        entries.map(({ origin: _origin, ...rest }) => rest);
      return text({
        ok: true,
        genres: brief(vocabulary.genres),
        moods: brief(vocabulary.moods),
        places: brief(vocabulary.places),
        recentChanges: smart.vocabularyLog(10),
      });
    }
    case "vocabulary_set": {
      const outcome = smart.setVocabulary(args, by);
      return text(outcome, !outcome.ok);
    }
    case "vocabulary_delete": {
      const outcome = smart.deleteVocabulary(
        args.kind,
        args.value,
        typeof args.note === "string" ? args.note : undefined,
        by,
      );
      return text(outcome, !outcome.ok);
    }
    case "vocabulary_reset": {
      const outcome = smart.resetVocabulary(args.kind, args.value, by);
      return text(outcome, !outcome.ok);
    }
    case "profile_get": {
      const profile = smart.profile(str(args.title), str(args.artist));
      return text(
        profile
          ? { ok: true, profile }
          : { ok: false, error: "No profile yet" },
        !profile,
      );
    }
    case "profile_set": {
      const outcome = smart.setProfile(args);
      return text(outcome, !outcome.ok);
    }
    case "outcomes":
      return text({
        ok: true,
        outcomes: smart.outcomes({
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.added_by === "string"
            ? { addedBy: args.added_by }
            : {}),
        }),
      });
    case "strategy_get":
      return text({
        ok: true,
        active: smart.activeStrategy(),
        trial: smart.trialStrategy() ?? null,
        history: smart.strategies().map(({ script: _script, ...rest }) => rest),
        vocabulary: {
          genres: smart.vocabulary().genres.map((entry) => entry.value),
          moods: smart.vocabulary().moods.map((entry) => entry.value),
        },
      });
    case "strategy_eval": {
      const outcome = await smart.evaluate({
        ...(args.weights && typeof args.weights === "object"
          ? { weights: args.weights as Record<string, number> }
          : {}),
        ...(typeof args.script === "string" ? { script: args.script } : {}),
      });
      return text(outcome, !outcome.ok);
    }
    case "strategy_set": {
      const outcome = await smart.proposeStrategy({
        ...(args.weights && typeof args.weights === "object"
          ? { weights: args.weights as Record<string, unknown> }
          : {}),
        ...(typeof args.script === "string" || args.script === null
          ? { script: args.script as string | null }
          : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
      });
      return text(outcome, !outcome.ok);
    }
    case "strategy_rollback": {
      const outcome = smart.rollback(
        typeof args.version === "number" ? args.version : undefined,
      );
      return text(outcome, !outcome.ok);
    }
  }
  return text({ error: "Unknown tool" }, true);
}

/** A Slack user ID from `U0ABC`, `<@U0ABC>`, `<@U0ABC|name>` or `u0abc`. */
export function slackUserId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const id = value
    .trim()
    .replace(/^<@/, "")
    .replace(/(\|[^>]*)?>$/, "")
    .toUpperCase();
  return /^[UW][A-Z0-9]{2,}$/.test(id) ? id : undefined;
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: any };

/**
 * HuddleFM as an MCP server over streamable HTTP, without sessions: each
 * POST is one JSON-RPC message, answered as JSON. Off without MCP_TOKEN.
 */
export async function mcpResponse(request: Request, host: McpHost) {
  if (!host.token) return new Response("Not found", { status: 404 });
  const auth = request.headers.get("authorization") ?? "";
  if (!same(auth, `Bearer ${host.token}`))
    return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  let rpc: Rpc;
  try {
    rpc = (await request.json()) as Rpc;
  } catch {
    return Response.json(error(null, -32700, "Parse error"));
  }
  // Notifications are only acknowledged.
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  return Response.json(await answer(rpc, host));
}

function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function answer(rpc: Rpc, host: McpHost) {
  switch (rpc.method) {
    case "initialize":
      return result(rpc.id, {
        protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "huddlefm", version: host.version },
      });
    case "ping":
      return result(rpc.id, {});
    case "tools/list":
      return result(rpc.id, {
        tools: [
          joinTool,
          ...mcpTools.map(({ type: _type, ...rest }) => rest),
          ...(host.smart ? smartTools(host.smart.vocabulary()) : []),
        ],
      });
    case "tools/call":
      return result(rpc.id, await call(rpc.params ?? {}, host));
    default:
      return error(rpc.id, -32601, "Method not found");
  }
}

async function call(
  params: { name?: string; arguments?: Record<string, unknown> },
  host: McpHost,
) {
  const args = params.arguments ?? {};
  const target = typeof args.channel === "string" ? args.channel : "";
  const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : "";
  if (params.name === joinTool.name) {
    const user = typeof args.user === "string" ? args.user : "";
    if (!target || !threadTs || !user)
      return text({ error: "channel, thread_ts and user are required" }, true);
    const outcome = await host.join(target, threadTs, user);
    return text(outcome, !outcome.ok);
  }
  if (
    host.smart &&
    smartTools(host.smart.vocabulary()).some(
      (item) => item.name === params.name,
    )
  )
    return callSmart(params.name!, args, host.smart, host.actorId);
  const definition = mcpTools.find((item) => item.name === params.name);
  if (!definition) return text({ error: "Unknown tool" }, true);
  // Only the session of the Huddle thread the caller names.
  if (!target || !threadTs)
    return text({ error: "channel and thread_ts are required" }, true);
  const session = host.session(target, threadTs);
  if (!session)
    return text(
      { error: "Nothing is playing in this Huddle yet. Join it first." },
      true,
    );
  if (!host.actorId)
    return text({ error: "MCP_USER_ID or ADMIN_USER_IDS is not set" }, true);
  const command: IntegrationCommand = {
    type: definition.type,
    channel: target,
  };
  if (typeof args.query === "string") command.query = args.query;
  if (typeof args.reference === "string") command.reference = args.reference;
  // Agents write the ID as a mention or lowercase as often as bare.
  const requestedBy = slackUserId(args.requested_by);
  if (requestedBy) command.requestedBy = requestedBy;
  if (typeof args.percent === "number") command.percent = args.percent;
  if (typeof args.limit === "number") command.limit = args.limit;
  if (Array.isArray(args.track_ids))
    command.trackIds = args.track_ids.filter(
      (id: unknown): id is string => typeof id === "string" && id !== "",
    );
  if (typeof args.position === "number") command.position = args.position;
  if (args.play_next === true) command.playNext = true;
  for (const [key, kind] of Object.entries(sessionSettings)) {
    const value =
      kind === "boolean"
        ? typeof args[key] === "boolean"
          ? args[key]
          : undefined
        : modeOf(kind, args[key]);
    if (value !== undefined) Object.assign(command, { [key]: value });
  }
  // Removing takes one song at a time, so several are taken out in turn and
  // the agent hears which left and which could not.
  if (definition.type === "remove") {
    const ids = [...new Set(command.trackIds ?? [])];
    if (!ids.length) return text({ error: "track_ids is required" }, true);
    const removed: unknown[] = [];
    const failed: { trackId: string; error: unknown }[] = [];
    for (const trackId of ids) {
      const outcome = (await session.run(host.actorId, {
        type: "remove",
        channel: target,
        trackId,
      })) as { ok?: boolean; removed?: unknown; error?: unknown };
      if (outcome.ok) removed.push(outcome.removed ?? { trackId });
      else failed.push({ trackId, error: outcome.error });
    }
    return text(
      { ok: removed.length > 0, removed, ...(failed.length ? { failed } : {}) },
      removed.length === 0,
    );
  }
  const outcome = await session.run(host.actorId, command);
  // A song without who asked still plays, as a recommendation, and the
  // agent hears how to credit the next one to a person.
  if (definition.type === "add" && !requestedBy && outcome.ok)
    return text({
      ...outcome,
      note: "No Slack user ID in requested_by, so the song shows as a recommendation",
    });
  return text(outcome, !outcome.ok);
}
