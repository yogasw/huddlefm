// In bot mode three members must be in a channel before music can play
// there: whoever was asked (an agent or a person), the app's bot user, which
// posts the player, and the signed-in account, which joins the Huddle. People
// should only have to invite one of them, so a channel is checked before a
// join and what can be fixed is fixed: the account joins a public channel by
// itself, then invites the bot user. Nothing falls back to posting the player
// as the account; what cannot be fixed is reported in one line saying what to
// do, naming the bot user and the account by name, never as a mention, so the
// account's owner is not pinged every time a channel is not ready.

// Who has to be in the channel, by plain name.
export type ChannelMembers = { bot: string; account: string };

export type ChannelCheck =
  // added: plain names of who was invited just now.
  | { ok: true; added: string[] }
  | { ok: false; reason: ChannelCheckReason; error: string };

export type ChannelCheckReason =
  "account_not_in_channel" | "bot_invite_refused" | "check_failed";

export type ChannelCheckDeps = {
  // True once the signed-in account is in the channel, joining it if public.
  accountAccess(channelId: string): Promise<boolean>;
  // Invites a user with the signed-in account; true when the user was added
  // now, false when the user was already there.
  invite(channelId: string, userId: string): Promise<boolean>;
  // Plain names of the bot user and the signed-in account.
  names(): Promise<ChannelMembers>;
};

// How long a channel that passed stays trusted before it is checked again.
const readyTtlMs = 10 * 60_000;

// Slack's error code in an error thrown for a failed call, e.g.
// "conversations.invite failed: restricted_action".
export function slackCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed: ([a-z_]+)/.exec(message)?.[1] ?? "unknown_error";
}

export function inviteRefusal(code: string, bot: string) {
  const why =
    code === "restricted_action" || code === "not_allowed_token_type"
      ? "Slack doesn’t allow adding apps to this channel"
      : code === "is_archived"
        ? "this channel is archived"
        : code === "ekm_access_denied" || code === "no_permission"
          ? "this channel doesn’t allow adding apps"
          : `Slack refused to add ${bot} (${code})`;
  return `I can’t play here yet: ${why}. A channel manager can add ${bot} with /invite, then ask again.`;
}

export function accountMissing(account: string) {
  return `I can’t play here yet: this channel is private and ${account}, the account that plays the music, isn’t in it. Add ${account} with /invite, then ask again.`;
}

export class ChannelChecker {
  private ready = new Map<string, number>();
  private running = new Map<string, Promise<ChannelCheck>>();

  constructor(
    private deps: ChannelCheckDeps,
    // The app's bot user; undefined outside bot mode, where nothing is checked.
    private botUserId: () => string | undefined,
    private now: () => number = Date.now,
  ) {}

  // fresh skips the remembered pass, for a mention or an explicit check, so
  // a bot user removed since is invited again.
  check(channelId: string, fresh = false): Promise<ChannelCheck> {
    if (!this.botUserId()) return Promise.resolve({ ok: true, added: [] });
    const readyAt = this.ready.get(channelId);
    if (!fresh && readyAt !== undefined && this.now() - readyAt < readyTtlMs)
      return Promise.resolve({ ok: true, added: [] });
    const pending = this.running.get(channelId);
    if (pending) return pending;
    const run = this.run(channelId).finally(() =>
      this.running.delete(channelId),
    );
    this.running.set(channelId, run);
    return run;
  }

  // Forget a channel, e.g. after the bot user was removed from it.
  forget(channelId: string) {
    this.ready.delete(channelId);
  }

  private async run(channelId: string): Promise<ChannelCheck> {
    const botUserId = this.botUserId()!;
    let access: boolean;
    try {
      access = await this.deps.accountAccess(channelId);
    } catch (error) {
      return {
        ok: false,
        reason: "check_failed",
        error: `I couldn’t check this channel (${slackCode(error)}). Try again in a moment.`,
      };
    }
    const names = await this.deps
      .names()
      .catch(() => ({ bot: "the player app", account: "the music account" }));
    if (!access)
      return {
        ok: false,
        reason: "account_not_in_channel",
        error: accountMissing(names.account),
      };
    const added: string[] = [];
    try {
      if (await this.deps.invite(channelId, botUserId)) added.push(names.bot);
    } catch (error) {
      return {
        ok: false,
        reason: "bot_invite_refused",
        error: inviteRefusal(slackCode(error), names.bot),
      };
    }
    this.ready.set(channelId, this.now());
    return { ok: true, added };
  }
}
