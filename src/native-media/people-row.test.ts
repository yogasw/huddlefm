import { expect, test } from "bun:test";
import {
  blendPatch,
  chooseShown,
  colourFor,
  drawPeople,
  initialsOf,
  layoutPeople,
  maxShown,
  PeopleOverlay,
  type Person,
} from "./people-row.ts";

const size = { width: 1280, height: 720 };
const crowd = (count: number): Person[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `U0TEST${index}`,
    name: `Person ${index}`,
  }));
const none = new Set<string>();

test("initials come from the first and last word of a name", () => {
  expect(initialsOf("Ada Lovelace")).toBe("AL");
  expect(initialsOf("Ada Augusta King Lovelace")).toBe("AL");
  expect(initialsOf("cy")).toBe("C");
  expect(initialsOf("  ")).toBe("?");
  expect(initialsOf("émile zola")).toBe("ÉZ");
});

test("someone with no photo always gets the same colour", () => {
  expect(colourFor("U0TEST1")).toBe(colourFor("U0TEST1"));
  expect(colourFor("U0TEST1")).toMatch(/^#[0-9a-f]{6}$/);
});

test("nothing is drawn when the row is off or nobody is there", () => {
  expect(layoutPeople("off", crowd(3), none, none, size)).toBeUndefined();
  expect(layoutPeople("all", [], none, none, size)).toBeUndefined();
  expect(layoutPeople("speaking", crowd(3), none, none, size)).toBeUndefined();
});

test("past eight people the rest are counted, and speakers are never hidden", () => {
  const people = crowd(11);
  const quiet = chooseShown(people, none);
  expect(quiet.shown.map((person) => person.id)).toEqual(
    people.slice(0, maxShown).map((person) => person.id),
  );
  expect(quiet.extra).toBe(3);
  const speaking = new Set(["U0TEST10", "U0TEST9"]);
  const loud = chooseShown(people, speaking);
  expect(loud.shown).toHaveLength(maxShown);
  expect(loud.shown.map((person) => person.id)).toContain("U0TEST10");
  expect(loud.shown.map((person) => person.id)).toContain("U0TEST9");
  // Still in the order the huddle lists them.
  expect(loud.shown.map((person) => person.id)).toEqual(
    [...loud.shown.map((person) => person.id)].sort(
      (a, b) =>
        people.findIndex((person) => person.id === a) -
        people.findIndex((person) => person.id === b),
    ),
  );
  expect(loud.extra).toBe(3);
});

test("the row sits bottom right, inside the frame, on even coordinates", () => {
  for (const template of ["all", "speaking", "stack"] as const) {
    const layout = layoutPeople(
      template,
      crowd(11),
      new Set(["U0TEST2"]),
      new Set(["U0TEST3"]),
      size,
    )!;
    const { box } = layout;
    expect(box.x % 2).toBe(0);
    expect(box.y % 2).toBe(0);
    expect(box.width % 2).toBe(0);
    expect(box.height % 2).toBe(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    expect(box.y + box.height).toBeLessThan(size.height);
    // Right half, bottom quarter, clear of the progress bar.
    expect(box.x).toBeGreaterThan(size.width / 2);
    expect(box.y).toBeGreaterThan(size.height * 0.75);
    expect(box.y + box.height).toBeLessThan(size.height * 0.96);
  }
});

test("the all row shows everyone with a ring on speakers and a mark on the muted", () => {
  const people = crowd(4);
  const layout = layoutPeople(
    "all",
    people,
    new Set(["U0TEST1"]),
    new Set(["U0TEST2"]),
    size,
  )!;
  expect(layout.items.map((item) => item.person.id)).toEqual(
    people.map((person) => person.id),
  );
  expect(layout.items.map((item) => item.speaking)).toEqual([
    false,
    true,
    false,
    false,
  ]);
  expect(layout.items.map((item) => item.muted)).toEqual([
    false,
    false,
    true,
    false,
  ]);
  expect(layout.more).toBeUndefined();
  expect(layout.pills).toHaveLength(1);
  const eleven = layoutPeople("all", crowd(11), none, none, size)!;
  expect(eleven.items).toHaveLength(maxShown);
  expect(eleven.more?.count).toBe(3);
});

test("the speaking row shows only speakers, with their names", () => {
  const people = crowd(6);
  const layout = layoutPeople(
    "speaking",
    people,
    new Set(["U0TEST1", "U0TEST4"]),
    none,
    size,
  )!;
  expect(layout.items.map((item) => item.person.id).sort()).toEqual([
    "U0TEST1",
    "U0TEST4",
  ]);
  expect(layout.items.every((item) => item.label)).toBeTrue();
  expect(layout.pills).toHaveLength(2);
  const four = layoutPeople(
    "speaking",
    people,
    new Set(people.map((person) => person.id)),
    none,
    size,
  )!;
  expect(four.items).toHaveLength(3);
});

test("a long name is cut short", () => {
  const layout = layoutPeople(
    "speaking",
    [{ id: "U0TEST1", name: "A very long display name indeed" }],
    new Set(["U0TEST1"]),
    none,
    size,
  )!;
  expect(layout.items[0]!.label!.text.length).toBeLessThanOrEqual(14);
  expect(layout.items[0]!.label!.text.endsWith("…")).toBeTrue();
});

test("the stacked row overlaps the circles and lifts speakers", () => {
  const layout = layoutPeople(
    "stack",
    crowd(5),
    new Set(["U0TEST2"]),
    none,
    size,
  )!;
  const [first, second] = layout.items;
  expect(second!.cx - first!.cx).toBeLessThan(first!.radius * 2);
  const lifted = layout.items.find((item) => item.speaking)!;
  expect(lifted.cy).toBeLessThan(first!.cy);
});

test("a patch holds the pills, rings and marks as pixels", () => {
  const layout = layoutPeople(
    "all",
    crowd(3),
    new Set(["U0TEST1"]),
    new Set(["U0TEST2"]),
    size,
  )!;
  const patch = drawPeople(layout, size);
  expect(patch).toMatchObject(layout.box);
  expect(patch.rgba.length).toBe(patch.width * patch.height * 4);
  const pixel = (x: number, y: number) => {
    const at = (y * patch.width + x) * 4;
    return [...patch.rgba.slice(at, at + 4)];
  };
  // Outside the pill is clear, inside it is a translucent dark.
  expect(pixel(0, 0)[3]).toBe(0);
  const pill = layout.pills[0]!;
  const inside = pixel(
    pill.x - patch.x + Math.round(pill.width / 2),
    pill.y - patch.y + 2,
  );
  expect(inside[3]).toBeGreaterThan(0);
  expect(inside[3]).toBeLessThan(255);
  // The speaker's ring is green.
  const speaker = layout.items[1]!;
  const ring = pixel(
    Math.round(speaker.cx - patch.x),
    Math.round(speaker.cy - patch.y - speaker.radius - 4),
  );
  expect(ring[1]).toBeGreaterThan(ring[0]!);
  expect(ring[3]).toBeGreaterThan(200);
  // The muted person has a red mark at the corner of the circle.
  const muted = layout.items[2]!;
  const mark = pixel(
    Math.round(muted.cx - patch.x + muted.radius * 0.72 + 2),
    Math.round(muted.cy - patch.y + muted.radius * 0.72 - 2),
  );
  expect(mark[0]).toBeGreaterThan(150);
  expect(mark[3]).toBeGreaterThan(200);
});

const frameOf = (luma: number, chroma: number, { width, height } = size) => {
  const frame = Buffer.alloc((width * height * 3) / 2, chroma);
  frame.fill(luma, 0, width * height);
  return frame;
};

test("blending changes only the patch's own pixels, luma and colour", () => {
  const small = { width: 16, height: 16 };
  const frame = frameOf(100, 128, small);
  const before = Buffer.from(frame);
  // A solid red 4x4 patch at (4, 6), fully opaque.
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = 255;
    rgba[at + 3] = 255;
  }
  blendPatch(frame, small, { x: 4, y: 6, width: 4, height: 4, rgba });
  const luma = (x: number, y: number) => frame[y * 16 + x]!;
  expect(luma(5, 7)).toBe(Math.round(16 + 0.257 * 255));
  expect(luma(3, 7)).toBe(100);
  expect(luma(8, 7)).toBe(100);
  expect(luma(5, 5)).toBe(100);
  expect(luma(5, 10)).toBe(100);
  const v = (x: number, y: number) =>
    frame[16 * 16 + 8 * 8 + (y >> 1) * 8 + (x >> 1)]!;
  expect(v(5, 7)).toBe(Math.round(128 + 0.439 * 255));
  expect(v(2, 7)).toBe(128);
  // Everything outside the patch is untouched.
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      if (x < 4 || x >= 8 || y < 6 || y >= 10)
        expect(luma(x, y)).toBe(before[y * 16 + x]!);
});

test("a half-clear pixel half-blends", () => {
  const small = { width: 4, height: 4 };
  const frame = frameOf(200, 128, small);
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  for (let at = 0; at < rgba.length; at += 4) rgba[at + 3] = 128;
  blendPatch(frame, small, { x: 0, y: 0, width: 2, height: 2, rgba });
  const black = 16;
  expect(frame[0]).toBe(
    Math.round(200 * (1 - 128 / 255) + black * (128 / 255)),
  );
});

test("a patch that runs off the frame is cut, not wrapped", () => {
  const small = { width: 8, height: 8 };
  const frame = frameOf(100, 128, small);
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  blendPatch(frame, small, { x: 6, y: 6, width: 4, height: 4, rgba });
  expect(frame[0]).toBe(100);
  expect(frame[7 * 8 + 7]).toBe(Math.round(16 + (0.257 + 0.504 + 0.098) * 255));
});

const overlayFor = (now: { value: number }) =>
  new PeopleOverlay(size, () => now.value, 800);

test("with the row off the frame comes back untouched", () => {
  const overlay = overlayFor({ value: 0 });
  overlay.setPeople(crowd(3));
  const frame = frameOf(100, 128);
  expect(overlay.over(frame)).toBe(frame);
  overlay.setTemplate("all");
  overlay.setPeople([]);
  expect(overlay.over(frame)).toBe(frame);
});

test("the overlay draws on a copy and hands back the same one while nothing changes", () => {
  const now = { value: 0 };
  const overlay = overlayFor(now);
  overlay.setTemplate("all");
  overlay.setPeople(crowd(3));
  const frame = frameOf(100, 128);
  const first = overlay.over(frame);
  expect(first).not.toBe(frame);
  expect(
    frame.every(
      (byte, index) => index >= size.width * size.height || byte === 100,
    ),
  ).toBeTrue();
  expect(first.equals(frame)).toBeFalse();
  expect(overlay.over(frame)).toBe(first);
  // Another frame is drawn on again, in the other of two buffers.
  const next = overlay.over(frameOf(100, 128));
  expect(next).not.toBe(first);
  const third = overlay.over(frameOf(100, 128));
  expect(third).not.toBe(next);
});

test("a ring stays a moment after its speaker falls quiet, then goes", () => {
  const now = { value: 1_000 };
  const overlay = overlayFor(now);
  overlay.setTemplate("all");
  overlay.setPeople(crowd(3));
  const frame = frameOf(100, 128);
  const quiet = overlay.over(frame);
  overlay.setState(["U0TEST1"], []);
  const speaking = overlay.over(frame);
  expect(speaking).not.toBe(quiet);
  overlay.setState([], []);
  now.value += 500;
  expect(overlay.over(frame)).toBe(speaking);
  now.value += 400;
  const after = overlay.over(frame);
  expect(after).not.toBe(speaking);
  expect(after.equals(quiet)).toBeTrue();
});

test("the speaking row shows nothing until someone speaks", () => {
  const now = { value: 0 };
  const overlay = overlayFor(now);
  overlay.setTemplate("speaking");
  overlay.setPeople(crowd(3));
  const frame = frameOf(100, 128);
  expect(overlay.over(frame)).toBe(frame);
  overlay.setState(["U0TEST0"], []);
  expect(overlay.over(frame)).not.toBe(frame);
  overlay.setState([], []);
  now.value += 900;
  expect(overlay.over(frame)).toBe(frame);
});

test("clearing the overlay forgets what it drew", () => {
  const overlay = overlayFor({ value: 0 });
  overlay.setTemplate("all");
  overlay.setPeople(crowd(2));
  const frame = frameOf(100, 128);
  const drawn = overlay.over(frame);
  overlay.clear();
  expect(overlay.over(frame)).not.toBe(drawn);
});
