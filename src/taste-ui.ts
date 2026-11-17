import {
  button,
  confirm,
  context,
  escape,
  input,
  plain,
  section,
  when,
} from "./coordinator-ui.ts";
import { dialogMetadata, type FormState } from "./settings-view.ts";
import type { SmartRecs } from "./smart.ts";
import {
  emptyLists,
  tasteKinds,
  type TasteKind,
  type TasteLists,
  type TasteRuleSet,
} from "./taste-rules.ts";

// Your taste, under Your data: what someone said they like or avoid, what
// was learnt from what they played and skipped, and how to change or forget
// either. Shared by the Settings of a session and the user's own Settings.

export const openTasteAction = "open_your_taste";
export const tasteCallback = "save_your_taste";
export const forgetTasteHistoryAction = "delete_data_taste_history";
export const forgetTasteSaidAction = "delete_data_taste_said";

export type TasteSummary = ReturnType<SmartRecs["tasteSummary"]>;
export type TasteChoices = ReturnType<SmartRecs["tasteVocabulary"]>;

const kindLabels: Record<TasteKind, string> = {
  genres: "Genres",
  moods: "Moods",
  countries: "Countries",
  artists: "Artists",
};

const list = (lists: TasteLists) =>
  tasteKinds
    .filter((kind) => lists[kind].length)
    .map(
      (kind) =>
        `${kindLabels[kind]}: ${lists[kind].map((value) => escape(value)).join(", ")}`,
    );

/** Your taste's blocks in Your data. */
export function tasteBlocks(sessionId: string, summary: TasteSummary) {
  const liked = list(summary.said.like);
  const avoided = list(summary.said.avoid);
  const learntLikes = list(summary.learnt.likes);
  const learntAvoids = list(summary.learnt.avoids);
  const said = [
    ...when(liked.length, `*More of:* ${liked.join(" · ")}`),
    ...when(avoided.length, `*Never for me:* ${avoided.join(" · ")}`),
  ] as string[];
  const learnt = [
    ...when(learntLikes.length, `Leans to ${learntLikes.join(" · ")}`),
    ...when(learntAvoids.length, `Leans away from ${learntAvoids.join(" · ")}`),
  ] as string[];
  return [
    { type: "header", text: plain("Your taste") },
    {
      type: "section",
      block_id: "taste_said",
      text: {
        type: "mrkdwn",
        text: `*What you told me*\n${said.length ? said.join("\n") : "Nothing yet. Edit it, or tell the DJ “no K-pop for me”."}`,
      },
      accessory: button(openTasteAction, plain("Edit"), { value: sessionId }),
    },
    ...when(
      said.length,
      section(
        "Songs you said never to play are not picked for you while you listen; a song someone asks for still plays.",
        "taste_said_effect",
      ),
      {
        type: "actions",
        block_id: "taste_said_actions",
        elements: [
          button(forgetTasteSaidAction, plain("Clear what I said"), {
            style: "danger",
            value: sessionId,
            confirm: confirm(
              "Clear what you said?",
              "Recommendations go back to learning from what you play and skip.",
              "Clear",
            ),
          }),
        ],
      },
    ),
    {
      type: "section",
      block_id: "taste_history",
      text: {
        type: "mrkdwn",
        text: `*Learnt from your plays and skips* · ${summary.history}${learnt.length ? `\n${learnt.join("\n")}` : ""}`,
      },
      ...(summary.history
        ? {
            accessory: button(forgetTasteHistoryAction, plain("Delete"), {
              style: "danger",
              value: sessionId,
              confirm: confirm(
                "Delete what was learnt?",
                "Recommendations forget which songs you played out, skipped or removed. How each song went for the room is kept, without your name.",
                "Delete",
              ),
            }),
          }
        : {}),
    },
  ];
}

const option = (value: string) => ({
  text: plain(value),
  value,
});

// One stance's fields: three picks from the vocabulary and free artists.
function stanceInputs(
  stance: "like" | "avoid",
  rules: TasteRuleSet,
  choices: TasteChoices,
) {
  const label = stance === "like" ? "More of" : "Never for me";
  const pick = (kind: Exclude<TasteKind, "artists">) => {
    const values = choices[kind].map((entry) => entry.value).slice(0, 100);
    const initial = rules[stance][kind].filter((value) =>
      values.includes(value),
    );
    return input(
      `taste_${stance}_${kind}`,
      `${label}: ${kindLabels[kind].toLowerCase()}`,
      {
        type: "multi_static_select",
        action_id: "value",
        placeholder: plain(`Pick ${kindLabels[kind].toLowerCase()}`),
        options: values.map(option),
        ...(initial.length ? { initial_options: initial.map(option) } : {}),
      },
      { optional: true },
    );
  };
  return [
    { type: "header", text: plain(label) },
    pick("genres"),
    pick("moods"),
    pick("countries"),
    input(
      `taste_${stance}_artists`,
      `${label}: artists`,
      {
        type: "plain_text_input",
        action_id: "value",
        placeholder: plain("Comma separated"),
        ...(rules[stance].artists.length
          ? { initial_value: rules[stance].artists.join(", ") }
          : {}),
      },
      { optional: true },
    ),
  ];
}

/** The dialog to change what someone told about their taste. */
export function tasteEditView(
  sessionId: string,
  settings: unknown,
  rules: TasteRuleSet,
  choices: TasteChoices,
) {
  return {
    type: "modal",
    callback_id: tasteCallback,
    private_metadata: dialogMetadata(sessionId, settings),
    title: plain("Your taste"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      context(
        "taste_about",
        "Only yours, and only while you listen. Countries are where the artist is from.",
      ),
      ...stanceInputs("like", rules, choices),
      ...stanceInputs("avoid", rules, choices),
    ],
  };
}

/** The whole set of rules a submitted Your taste holds. */
export function tasteFromState(state: FormState) {
  const read = (stance: "like" | "avoid") => {
    const lists = emptyLists();
    for (const kind of tasteKinds) {
      const field = state[`taste_${stance}_${kind}`]?.value as
        | {
            value?: string | null;
            selected_options?: { value: string }[];
          }
        | undefined;
      lists[kind] =
        kind === "artists"
          ? (field?.value ?? "")
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : (field?.selected_options ?? []).map((item) => item.value);
    }
    return lists;
  };
  return { like: read("like"), avoid: read("avoid"), replace: true as const };
}

const tasteActions = new Set([
  openTasteAction,
  forgetTasteHistoryAction,
  forgetTasteSaidAction,
]);

/** Whether an interaction is Your taste's, wherever Settings was opened. */
export function isTasteInteraction(interaction: {
  type: string;
  actionId: string;
}) {
  return interaction.type === "view_submission"
    ? interaction.actionId === tasteCallback
    : interaction.type === "block_actions" &&
        tasteActions.has(interaction.actionId);
}

/**
 * Runs a Your taste interaction. Only ever the user's own taste: each
 * change is made for the user who clicked or submitted.
 */
export async function tasteAction(
  interaction: {
    type: string;
    actionId: string;
    userId: string;
    triggerId?: string;
    viewId?: string;
    viewHash?: string;
    previousViewId?: string;
    state: FormState;
  },
  deps: {
    smart: Pick<
      SmartRecs,
      "rules" | "tasteVocabulary" | "setTaste" | "forgetTaste"
    >;
    slack: {
      pushModal(triggerId: string, view: unknown): Promise<unknown>;
      updateModal(
        viewId: string,
        hash: string | undefined,
        view: unknown,
      ): Promise<unknown>;
    };
    audit(event: string, userId: string, fields: Record<string, unknown>): void;
    sessionId: string;
    // The metadata of Settings under Your data.
    settings: unknown;
    yourDataView(notice?: string): unknown;
  },
) {
  const { smart, slack } = deps;
  const { userId } = interaction;
  if (interaction.actionId === openTasteAction) {
    if (!interaction.triggerId) return;
    await slack.pushModal(
      interaction.triggerId,
      tasteEditView(
        deps.sessionId,
        deps.settings,
        smart.rules.get(userId),
        smart.tasteVocabulary(),
      ),
    );
    return;
  }
  if (interaction.actionId === tasteCallback) {
    const { unknown } = smart.setTaste(
      userId,
      tasteFromState(interaction.state),
    );
    deps.audit("taste.changed", userId, { source: "settings" });
    if (interaction.previousViewId)
      await slack.updateModal(
        interaction.previousViewId,
        undefined,
        deps.yourDataView(
          unknown.length
            ? `Saved, apart from ${unknown.map(escape).join(", ")}.`
            : "Saved your taste.",
        ),
      );
    return;
  }
  const what =
    interaction.actionId === forgetTasteSaidAction ? "said" : "history";
  const forgotten = smart.forgetTaste(userId, what);
  deps.audit("data.deleted", userId, {
    kind: `taste_${what}`,
    count: what === "said" ? forgotten.said : forgotten.history,
  });
  if (interaction.viewId)
    await slack.updateModal(
      interaction.viewId,
      interaction.viewHash,
      deps.yourDataView(
        what === "said"
          ? "Cleared what you told me about your taste."
          : "Deleted what was learnt from your plays and skips.",
      ),
    );
}
