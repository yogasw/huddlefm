import { contentSuffix } from "./content-shares.ts";
import { slackUserId } from "./data-channel.ts";
import type { SignalFrame } from "./signaling.ts";

/**
 * The Slack users connected to the meeting, other than the bot's own
 * attendee, from the attendee presence Chime sends. Each device joins as its
 * own attendee, so this shows the account the bot joined as listening from
 * another device, which Slack's participant list cannot tell apart.
 */
export class AttendeeUsers {
  private streams = new Map<number, { attendeeId: string; userId?: string }>();
  private reported = "";

  constructor(
    private selfId: string,
    private onChange: (userIds: string[]) => void,
  ) {}

  get userIds() {
    const users = new Set<string>();
    for (const { attendeeId, userId } of this.streams.values())
      if (
        userId &&
        attendeeId !== this.selfId &&
        !attendeeId.endsWith(contentSuffix)
      )
        users.add(userId);
    return [...users].sort();
  }

  handle(frame: SignalFrame) {
    const streams = frame.audio_stream_id_info?.streams;
    if (!streams?.length) return;
    for (const stream of streams) {
      if (stream.attendee_id)
        this.streams.set(stream.audio_stream_id, {
          attendeeId: stream.attendee_id,
          userId: slackUserId(stream.external_user_id),
        });
      // An entry with neither an attendee nor a mute state means the stream
      // left.
      else if (stream.muted === undefined)
        this.streams.delete(stream.audio_stream_id);
    }
    this.report();
  }

  /** Forgets everyone, for a rebuilt connection that will resend presence. */
  reset() {
    this.streams.clear();
    this.report();
  }

  private report() {
    const userIds = this.userIds;
    const key = userIds.join(",");
    if (key === this.reported) return;
    this.reported = key;
    this.onChange(userIds);
  }
}
