import { expect, test } from "bun:test";
import { PeopleSignals, type PeopleState } from "./people-signals.ts";

const streams = (...entries: Record<string, unknown>[]) => ({
  type: "AUDIO_STREAM_ID_INFO",
  audio_stream_id_info: { streams: entries as never },
});
const volumes = (...entries: Record<string, unknown>[]) => ({
  type: "AUDIO_METADATA",
  audio_metadata: { attendee_states: entries as never },
});
const person = (
  stream: number,
  attendee: string,
  user: string,
  muted = false,
) => ({
  audio_stream_id: stream,
  attendee_id: attendee,
  external_user_id: `s-call-${user}`,
  muted,
});

function setup() {
  const reports: PeopleState[] = [];
  const signals = new PeopleSignals("bot", (state) => reports.push(state));
  return { reports, signals };
}

test("who is speaking and who is muted, by Slack user", () => {
  const { signals, reports } = setup();
  signals.handle(
    streams(person(1, "a1", "U0TESTA"), person(2, "a2", "U0TESTB", true)),
  );
  expect(signals.state).toEqual({ speaking: [], muted: ["U0TESTB"] });
  signals.handle(volumes({ audio_stream_id: 1, volume: 14 }));
  expect(signals.state).toEqual({ speaking: ["U0TESTA"], muted: ["U0TESTB"] });
  expect(reports.at(-1)).toEqual(signals.state);
});

test("a muted person is never speaking, and silence in a frame ends speech", () => {
  const { signals } = setup();
  signals.handle(
    streams(person(1, "a1", "U0TESTA"), person(2, "a2", "U0TESTB")),
  );
  signals.handle(
    volumes(
      { audio_stream_id: 1, volume: 14 },
      { audio_stream_id: 2, volume: 14 },
    ),
  );
  expect(signals.state.speaking).toEqual(["U0TESTA", "U0TESTB"]);
  signals.handle(streams({ audio_stream_id: 2, muted: true }));
  expect(signals.state.speaking).toEqual(["U0TESTA"]);
  // A frame with volumes that leaves someone out says they are quiet.
  signals.handle(volumes({ audio_stream_id: 2, volume: 14 }));
  expect(signals.state.speaking).toEqual([]);
});

test("the bot and its screen share are not people", () => {
  const { signals } = setup();
  signals.handle(
    streams(
      person(1, "bot", "U0TESTBOT"),
      person(2, "bot#content", "U0TESTBOT"),
      person(3, "a1", "U0TESTA"),
    ),
  );
  signals.handle(
    volumes(
      { audio_stream_id: 1, volume: 14 },
      { audio_stream_id: 2, volume: 14 },
      { audio_stream_id: 3, volume: 14 },
    ),
  );
  expect(signals.state.speaking).toEqual(["U0TESTA"]);
});

test("a person on two devices is speaking if either is and muted only if both are", () => {
  const { signals } = setup();
  signals.handle(
    streams(
      person(1, "a1", "U0TESTA", true),
      person(2, "a2", "U0TESTA", false),
    ),
  );
  expect(signals.state.muted).toEqual([]);
  signals.handle(streams({ audio_stream_id: 2, muted: true }));
  expect(signals.state.muted).toEqual(["U0TESTA"]);
  signals.handle(streams({ audio_stream_id: 1, muted: false }));
  signals.handle(volumes({ audio_stream_id: 1, volume: 14 }));
  expect(signals.state.speaking).toEqual(["U0TESTA"]);
});

test("someone who leaves is forgotten, and a changed state is reported once", () => {
  const { signals, reports } = setup();
  signals.handle(streams(person(1, "a1", "U0TESTA", true)));
  expect(reports).toHaveLength(1);
  signals.handle(streams({ audio_stream_id: 1, muted: true }));
  expect(reports).toHaveLength(1);
  signals.handle(streams({ audio_stream_id: 1 }));
  expect(signals.state).toEqual({ speaking: [], muted: [] });
  expect(reports).toHaveLength(2);
});

test("a rebuilt connection forgets everyone", () => {
  const { signals, reports } = setup();
  signals.handle(streams(person(1, "a1", "U0TESTA", true)));
  signals.reset();
  expect(signals.state).toEqual({ speaking: [], muted: [] });
  expect(reports.at(-1)).toEqual({ speaking: [], muted: [] });
});

test("a stream without a Slack user is not shown", () => {
  const { signals } = setup();
  signals.handle(
    streams({
      audio_stream_id: 1,
      attendee_id: "a1",
      external_user_id: "nonsense",
      muted: true,
    }),
  );
  expect(signals.state).toEqual({ speaking: [], muted: [] });
});
