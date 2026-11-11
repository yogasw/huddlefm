import { expect, test } from "bun:test";
import { AttendeeUsers } from "./attendee-users.ts";
import type { SignalFrame } from "./signaling.ts";

const streams = (
  ...entries: {
    audio_stream_id: number;
    attendee_id?: string;
    external_user_id?: string;
    muted?: boolean;
  }[]
) =>
  ({
    type: "AUDIO_STREAM_ID_INFO",
    audio_stream_id_info: { streams: entries },
  }) as SignalFrame;

test("lists the Slack users on other attendees, the bot's own account too", () => {
  const changes: string[][] = [];
  const users = new AttendeeUsers("bot", (ids) => changes.push(ids));
  users.handle(
    streams(
      {
        audio_stream_id: 1,
        attendee_id: "bot",
        external_user_id: "x-R1-U01ACCOUNT",
      },
      {
        audio_stream_id: 2,
        attendee_id: "bot#content",
        external_user_id: "x-R1-U01ACCOUNT",
      },
    ),
  );
  expect(users.userIds).toEqual([]);
  // The same account on another device is its own attendee.
  users.handle(
    streams({
      audio_stream_id: 3,
      attendee_id: "phone",
      external_user_id: "x-R1-U01ACCOUNT",
    }),
  );
  expect(users.userIds).toEqual(["U01ACCOUNT"]);
  users.handle(streams({ audio_stream_id: 3, muted: true }));
  expect(users.userIds).toEqual(["U01ACCOUNT"]);
  users.handle(streams({ audio_stream_id: 3 }));
  expect(users.userIds).toEqual([]);
  expect(changes).toEqual([["U01ACCOUNT"], []]);
});
