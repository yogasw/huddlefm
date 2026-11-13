import { plain } from "./coordinator-ui.ts";
import {
  webhookEvents,
  type WebhookEvent,
  type WebhookSettings,
} from "./store.ts";

export const webhookEventLabels: Record<WebhookEvent, string> = {
  "huddle.joined": "The bot joined a huddle",
  "huddle.left": "The bot left a huddle by itself (alone, idle or paused)",
  "queue.low": "Only a few songs are left in the queue",
  "queue.last": "The last song in the queue started",
  "queue.ended": "The queue ran out",
  "session.ended": "Someone ended the session",
};

export const editWebhookAction = "edit_webhook";
export const testWebhookAction = "test_webhook";
export const removeWebhookAction = "remove_webhook";
export const webhookCallback = "webhook_settings";

/** Reasons a session ends that count as a person ending it. */
const endedByPeople = new Set(["ended by host", "ended by agent"]);

/** Which event a session ending is: someone ended it, or the bot left. */
export function endEvent(reason: string): WebhookEvent {
  return endedByPeople.has(reason) ? "session.ended" : "huddle.left";
}

const privateIpv4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * Why a webhook address cannot be used, or undefined when it can: https
 * only, no credentials in it, and nothing that points at this host or its
 * network. Hostnames are not resolved here, so this is a guard against a
 * slip, not against an admin who means harm.
 */
export function webhookUrlProblem(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That is not a valid address.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  if (url.username || url.password)
    return "Leave the username and password out of the address; use the token instead.";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain") ||
    (!host.includes(".") && !host.includes(":"))
  )
    return "That address points at a private or local host.";
  if (privateIpv4.some((pattern) => pattern.test(host)))
    return "That address points at a private network.";
  if (
    host.includes(":") &&
    (host === "::1" ||
      host === "::" ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("::ffff:"))
  )
    return "That address points at a private network.";
  return undefined;
}

/** The address without its path and query, safe to show and to log. */
export function webhookHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "unknown";
  }
}

type Sender = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

export type WebhookDelivery = {
  ok: boolean;
  status?: number;
  attempts: number;
};

/**
 * Posts an event as JSON, with the token as a bearer when there is one. A
 * failure is tried again twice, a little later each time. It never throws:
 * a webhook that is down must not touch the music.
 */
export async function deliverWebhook(
  settings: Pick<WebhookSettings, "url" | "token">,
  body: unknown,
  options: {
    send?: Sender;
    delaysMs?: number[];
    timeoutMs?: number;
  } = {},
): Promise<WebhookDelivery> {
  const send = options.send ?? (fetch as unknown as Sender);
  const delays = options.delaysMs ?? [1_000, 3_000];
  const payload = JSON.stringify(body);
  let status: number | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) await Bun.sleep(delays[attempt - 1]!);
    try {
      const response = await send(settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "HuddleFM-webhook",
          ...(settings.token
            ? { authorization: `Bearer ${settings.token}` }
            : {}),
        },
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      status = response.status;
      if (status >= 200 && status < 300)
        return { ok: true, status, attempts: attempt + 1 };
    } catch {
      status = undefined;
    }
  }
  return { ok: false, status, attempts: delays.length + 1 };
}

/** The admin's form for the webhook: where to send, the token, the events. */
export function webhookModal(current: WebhookSettings | undefined) {
  const events = webhookEvents.map((event) => ({
    text: plain(webhookEventLabels[event]),
    value: event,
  }));
  const chosen = events.filter((option) =>
    current?.events.includes(option.value),
  );
  return {
    type: "modal",
    callback_id: webhookCallback,
    title: plain("Webhook"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "webhook_url",
        label: plain("Address"),
        hint: plain("Must start with https://. Nothing is sent without one."),
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: plain("https://example.com/huddlefm"),
          ...(current ? { initial_value: current.url } : {}),
        },
      },
      {
        type: "input",
        block_id: "webhook_token",
        optional: true,
        label: plain("Auth token"),
        hint: plain(
          current?.token
            ? "A token is saved and not shown. Leave this empty to keep it, or type a new one."
            : "Sent as Authorization: Bearer <token>. Leave empty to send none.",
        ),
        element: { type: "plain_text_input", action_id: "value" },
      },
      ...(current?.token
        ? [
            {
              type: "input",
              block_id: "webhook_remove_token",
              optional: true,
              label: plain("Saved token"),
              element: {
                type: "checkboxes",
                action_id: "value",
                options: [
                  { text: plain("Remove the saved token"), value: "remove" },
                ],
              },
            },
          ]
        : []),
      {
        type: "input",
        block_id: "webhook_events",
        optional: true,
        label: plain("Send these events"),
        element: {
          type: "checkboxes",
          action_id: "value",
          options: events,
          ...(chosen.length ? { initial_options: chosen } : {}),
        },
      },
    ],
  };
}

type FormState = Record<
  string,
  Record<
    string,
    {
      value?: string | null;
      selected_options?: { value?: string }[];
    }
  >
>;

/**
 * What a submitted form asks for, or why it cannot be saved. An empty token
 * keeps the saved one unless it is being removed.
 */
export function parseWebhookForm(
  state: unknown,
  current: WebhookSettings | undefined,
):
  | { ok: true; url: string; token: string; events: WebhookEvent[] }
  | { ok: false; error: string } {
  const form = (state ?? {}) as FormState;
  const url = (form.webhook_url?.value?.value ?? "").trim();
  const problem = webhookUrlProblem(url);
  if (problem) return { ok: false, error: problem };
  const typed = (form.webhook_token?.value?.value ?? "").trim();
  const remove = Boolean(
    form.webhook_remove_token?.value?.selected_options?.some(
      (option) => option.value === "remove",
    ),
  );
  const token = typed || (remove ? "" : (current?.token ?? ""));
  const picked = new Set(
    (form.webhook_events?.value?.selected_options ?? []).map(
      (option) => option.value,
    ),
  );
  return {
    ok: true,
    url,
    token,
    events: webhookEvents.filter((event) => picked.has(event)),
  };
}
