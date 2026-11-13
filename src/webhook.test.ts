import { expect, test } from "bun:test";
import type { WebhookSettings } from "./store.ts";
import {
  deliverWebhook,
  endEvent,
  parseWebhookForm,
  webhookHost,
  webhookModal,
  webhookUrlProblem,
} from "./webhook.ts";

const saved: WebhookSettings = {
  url: "https://hooks.example.com/huddlefm",
  token: "test-token",
  events: ["queue.last"],
  updatedBy: "U01TESTADMIN",
  updatedAt: 1,
};

test("only public https addresses are accepted", () => {
  expect(webhookUrlProblem("https://hooks.example.com/a?b=1")).toBeUndefined();
  expect(webhookUrlProblem("https://8.8.8.8/hook")).toBeUndefined();
  for (const bad of [
    "http://hooks.example.com",
    "not a url",
    "https://user:pass@hooks.example.com",
    "https://localhost/a",
    "https://app.localhost/a",
    "https://printer.local/a",
    "https://db.internal/a",
    "https://metadata/a",
    "https://127.0.0.1/a",
    "https://10.1.2.3/a",
    "https://172.20.0.5/a",
    "https://192.168.1.9/a",
    "https://169.254.169.254/latest",
    "https://100.64.0.1/a",
    "https://[::1]/a",
    "https://[fd00::1]/a",
    "https://[fe80::1]/a",
  ])
    expect(webhookUrlProblem(bad)).toBeString();
  expect(webhookUrlProblem("https://172.32.0.1/a")).toBeUndefined();
});

test("the host is shown without a path or query", () => {
  expect(webhookHost("https://hooks.example.com:8443/secret/path?key=1")).toBe(
    "hooks.example.com:8443",
  );
  expect(webhookHost("nonsense")).toBe("unknown");
});

test("someone ending the session is told apart from the bot leaving", () => {
  expect(endEvent("ended by host")).toBe("session.ended");
  expect(endEvent("ended by agent")).toBe("session.ended");
  for (const reason of [
    "alone timeout",
    "idle timeout",
    "paused timeout",
    "huddle ended",
    "media connection ended",
  ])
    expect(endEvent(reason)).toBe("huddle.left");
});

test("an event is posted as JSON with the token as a bearer", async () => {
  const calls: { url: string; init: any }[] = [];
  const result = await deliverWebhook(
    saved,
    { event: "queue.last" },
    {
      send: async (url, init) => {
        calls.push({ url, init });
        return { status: 204 };
      },
    },
  );
  expect(result).toEqual({ ok: true, status: 204, attempts: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(saved.url);
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.redirect).toBe("manual");
  expect(calls[0]!.init.headers.authorization).toBe("Bearer test-token");
  expect(calls[0]!.init.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0]!.init.body)).toEqual({ event: "queue.last" });
});

test("no token means no authorization header", async () => {
  let headers: Record<string, string> = {};
  await deliverWebhook(
    { url: saved.url, token: "" },
    {},
    {
      send: async (_url, init) => {
        headers = init.headers;
        return { status: 200 };
      },
    },
  );
  expect(headers.authorization).toBeUndefined();
});

test("a failed delivery is tried twice more, then given up on", async () => {
  let attempts = 0;
  const result = await deliverWebhook(
    saved,
    {},
    {
      delaysMs: [1, 1],
      send: async () => {
        attempts++;
        return { status: 500 };
      },
    },
  );
  expect(attempts).toBe(3);
  expect(result).toEqual({ ok: false, status: 500, attempts: 3 });
});

test("a delivery that works on a retry counts as sent, and errors never throw", async () => {
  let attempts = 0;
  const flaky = await deliverWebhook(
    saved,
    {},
    {
      delaysMs: [1, 1],
      send: async () => {
        attempts++;
        if (attempts === 1) throw new Error("connection refused");
        return { status: 200 };
      },
    },
  );
  expect(flaky).toEqual({ ok: true, status: 200, attempts: 2 });
  const down = await deliverWebhook(
    saved,
    {},
    {
      delaysMs: [1, 1],
      send: async () => {
        throw new Error("down");
      },
    },
  );
  expect(down).toEqual({ ok: false, status: undefined, attempts: 3 });
});

test("a redirect is not followed and counts as a failure", async () => {
  const result = await deliverWebhook(
    saved,
    {},
    { delaysMs: [], send: async () => ({ status: 302 }) },
  );
  expect(result.ok).toBeFalse();
});

const form = (
  url: string,
  token?: string,
  events: string[] = [],
  remove = false,
) => ({
  webhook_url: { value: { value: url } },
  webhook_token: { value: { value: token ?? null } },
  webhook_remove_token: {
    value: { selected_options: remove ? [{ value: "remove" }] : [] },
  },
  webhook_events: {
    value: { selected_options: events.map((value) => ({ value })) },
  },
});

test("the form keeps the saved token unless a new one is typed or it is removed", () => {
  const url = "https://hooks.example.com/a";
  expect(parseWebhookForm(form(url, "", ["queue.last"]), saved)).toEqual({
    ok: true,
    url,
    token: "test-token",
    events: ["queue.last"],
  });
  expect(parseWebhookForm(form(url, " new "), saved)).toMatchObject({
    token: "new",
  });
  expect(parseWebhookForm(form(url, "", [], true), saved)).toMatchObject({
    token: "",
  });
  expect(parseWebhookForm(form(url), undefined)).toMatchObject({ token: "" });
});

test("the form drops unknown events and keeps the order of the list", () => {
  expect(
    parseWebhookForm(
      form("https://hooks.example.com/a", "", [
        "session.ended",
        "huddle.joined",
        "bogus",
      ]),
      undefined,
    ),
  ).toMatchObject({ events: ["huddle.joined", "session.ended"] });
});

test("the form refuses an address that cannot be used", () => {
  expect(parseWebhookForm(form("http://hooks.example.com"), saved)).toEqual({
    ok: false,
    error: "The address must start with https://.",
  });
  expect(parseWebhookForm({}, saved)).toMatchObject({ ok: false });
});

test("the form shows the saved events and never the saved token", () => {
  const view = webhookModal(saved);
  const text = JSON.stringify(view);
  expect(text).not.toContain("test-token");
  expect(text).toContain("Remove the saved token");
  expect(text).toContain(saved.url);
  const events = (view.blocks as any[]).find(
    (block) => block.block_id === "webhook_events",
  );
  expect(events.element.initial_options.map((o: any) => o.value)).toEqual([
    "queue.last",
  ]);
  expect(events.element.options).toHaveLength(6);
  const fresh = JSON.stringify(webhookModal(undefined));
  expect(fresh).not.toContain("Remove the saved token");
  expect(fresh).not.toContain("initial_options");
});
