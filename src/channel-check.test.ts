import { expect, test } from "bun:test";
import {
  ChannelChecker,
  slackCode,
  type ChannelCheckDeps,
} from "./channel-check.ts";

const deps = (change: Partial<ChannelCheckDeps> = {}) => {
  const calls: string[] = [];
  const value: ChannelCheckDeps = {
    accountAccess: async (channelId) => {
      calls.push(`access ${channelId}`);
      return true;
    },
    invite: async (channelId, userId) => {
      calls.push(`invite ${channelId} ${userId}`);
      return true;
    },
    names: async () => ({ bot: "DJ", account: "Music Account" }),
    ...change,
  };
  return { value, calls };
};

test("does nothing outside bot mode", async () => {
  const { value, calls } = deps();
  const checker = new ChannelChecker(value, () => undefined);
  expect(await checker.check("C01TESTCHAN")).toEqual({ ok: true, added: [] });
  expect(calls).toEqual([]);
});

test("invites the bot user once and trusts the channel afterwards", async () => {
  const { value, calls } = deps();
  const checker = new ChannelChecker(value, () => "U01TESTBOT");
  expect(await checker.check("C01TESTCHAN")).toEqual({
    ok: true,
    added: ["DJ"],
  });
  expect(await checker.check("C01TESTCHAN")).toEqual({ ok: true, added: [] });
  expect(calls).toEqual([
    "access C01TESTCHAN",
    "invite C01TESTCHAN U01TESTBOT",
  ]);
});

test("checks again when asked fresh or once the pass is old", async () => {
  const { value, calls } = deps();
  let now = 0;
  const checker = new ChannelChecker(
    value,
    () => "U01TESTBOT",
    () => now,
  );
  await checker.check("C01TESTCHAN");
  await checker.check("C01TESTCHAN", true);
  now = 11 * 60_000;
  await checker.check("C01TESTCHAN");
  expect(calls.filter((call) => call.startsWith("invite"))).toHaveLength(3);
});

test("names the account by name when a private channel lacks it", async () => {
  const { value, calls } = deps({ accountAccess: async () => false });
  const result = await new ChannelChecker(value, () => "U01TESTBOT").check(
    "C01TESTCHAN",
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("account_not_in_channel");
  expect(result.error).toContain("Music Account");
  expect(result.error).not.toContain("<@");
  expect(calls).toEqual([]);
});

test("explains a refused invite without falling back", async () => {
  const { value } = deps({
    invite: async () => {
      throw new Error("conversations.invite failed: restricted_action");
    },
  });
  const checker = new ChannelChecker(value, () => "U01TESTBOT");
  const result = await checker.check("C01TESTCHAN");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("bot_invite_refused");
  expect(result.error).toContain("DJ");
  expect(result.error).toContain("/invite");
  // A failed check is not remembered as ready.
  expect((await checker.check("C01TESTCHAN")).ok).toBe(false);
});

test("reads Slack's error code from a failed call", () => {
  expect(
    slackCode(new Error("conversations.invite failed: not_in_channel")),
  ).toBe("not_in_channel");
  expect(slackCode("boom")).toBe("unknown_error");
});
