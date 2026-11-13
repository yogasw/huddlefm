import { speechVolumeThreshold } from "../ducking.ts";
import { contentSuffix } from "./content-shares.ts";
import { slackUserId } from "./data-channel.ts";
import { normalizedVolume } from "./speech.ts";
import type { SignalFrame } from "./signaling.ts";

export type PeopleState = { speaking: string[]; muted: string[] };

/**
 * Who in the meeting is speaking and who is muted, by Slack user, from the
 * attendee presence and audio metadata Chime sends. Like SpeechSignals, but
 * kept per person rather than per attendee, since a person on two devices is
 * one circle: speaking if either is, muted only if both are.
 */
export class PeopleSignals {
  private streams = new Map<number, { attendeeId: string; userId?: string }>();
  private muted = new Map<string, boolean>();
  private volumes = new Map<string, number>();
  private reported = "";

  constructor(
    private selfId: string,
    private onChange: (state: PeopleState) => void,
  ) {}

  private isSelf(attendeeId: string) {
    return attendeeId === this.selfId || attendeeId.endsWith(contentSuffix);
  }

  handle(frame: SignalFrame) {
    for (const stream of frame.audio_stream_id_info?.streams ?? []) {
      if (stream.attendee_id) {
        this.streams.set(stream.audio_stream_id, {
          attendeeId: stream.attendee_id,
          userId: slackUserId(stream.external_user_id),
        });
        if (stream.muted !== undefined)
          this.muted.set(stream.attendee_id, stream.muted);
        continue;
      }
      const known = this.streams.get(stream.audio_stream_id);
      if (!known) continue;
      if (stream.muted !== undefined) {
        this.muted.set(known.attendeeId, stream.muted);
        continue;
      }
      // Neither an attendee nor a mute state: the stream left. The attendee is
      // gone once no newer stream belongs to them.
      this.streams.delete(stream.audio_stream_id);
      if (
        ![...this.streams.values()].some(
          (other) => other.attendeeId === known.attendeeId,
        )
      ) {
        this.muted.delete(known.attendeeId);
        this.volumes.delete(known.attendeeId);
      }
    }
    const states = frame.audio_metadata?.attendee_states;
    if (states) this.metadata(states);
    this.report();
  }

  private metadata(
    states: NonNullable<
      NonNullable<SignalFrame["audio_metadata"]>["attendee_states"]
    >,
  ) {
    const levels = new Map<string, number>();
    let carriesVolumes = false;
    for (const state of states) {
      if (state.volume === undefined) continue;
      carriesVolumes = true;
      const known = this.streams.get(state.audio_stream_id);
      if (known) levels.set(known.attendeeId, normalizedVolume(state.volume));
    }
    // A frame that carries volumes implies silence for everyone it leaves out.
    if (!carriesVolumes) return;
    for (const { attendeeId } of this.streams.values())
      this.volumes.set(attendeeId, levels.get(attendeeId) ?? 0);
  }

  /** Forgets everyone, for a rebuilt connection that will resend presence. */
  reset() {
    this.streams.clear();
    this.muted.clear();
    this.volumes.clear();
    this.report();
  }

  get state(): PeopleState {
    const speaking = new Set<string>();
    const present = new Map<string, boolean[]>();
    for (const { attendeeId, userId } of this.streams.values()) {
      if (!userId || this.isSelf(attendeeId)) continue;
      const muted = this.muted.get(attendeeId) ?? false;
      present.set(userId, [...(present.get(userId) ?? []), muted]);
      if (
        !muted &&
        (this.volumes.get(attendeeId) ?? 0) >= speechVolumeThreshold
      )
        speaking.add(userId);
    }
    return {
      speaking: [...speaking].sort(),
      muted: [...present]
        .filter(([, devices]) => devices.every(Boolean))
        .map(([userId]) => userId)
        .sort(),
    };
  }

  private report() {
    const state = this.state;
    const key = `${state.speaking.join(",")}|${state.muted.join(",")}`;
    if (key === this.reported) return;
    this.reported = key;
    this.onChange(state);
  }
}
