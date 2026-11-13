// The people in the huddle, drawn over a playing video on the screen share:
// their photos in small circles, a green ring on whoever is speaking, and a
// mark on whoever is muted. Drawn once into a small picture whenever
// something changes, then blended into the decoder's yuv420p frames, so a
// frame costs a copy and a small blend.
import { createCanvas, type Image } from "@napi-rs/canvas";
import type { PeopleTemplate } from "./video-format.ts";
import { fonts } from "./fonts.ts";

type Size = { width: number; height: number };

export type Person = { id: string; name: string; image?: Image };

/** The most people a row shows before the rest are counted. */
export const maxShown = 8;
/** The most names shown at once when only the speakers are. */
const maxSpeakers = 3;
/** How long a ring stays after its speaker falls quiet. */
export const ringHoldMs = 800;

const palette = [
  "#e07a5f",
  "#3d85c6",
  "#81b29a",
  "#d4a017",
  "#9b5de5",
  "#00a5c8",
  "#ef476f",
  "#06a77d",
  "#f28c28",
  "#8d99ae",
];

/** A colour for someone with no photo, the same one every time. */
export function colourFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

/** The letters in a circle with no photo: the first of up to two words. */
export function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
  return (
    letters
      .map((word) => [...word][0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

export type Placed = {
  person: Person;
  cx: number;
  cy: number;
  radius: number;
  speaking: boolean;
  muted: boolean;
  /** Draws the name beside the circle, for the speakers-only row. */
  label?: { x: number; text: string };
};

export type Layout = {
  items: Placed[];
  /** The rounded backgrounds, one for a row and one per speaker. */
  pills: { x: number; y: number; width: number; height: number }[];
  /** The "+N" circle, when people did not all fit. */
  more?: { cx: number; cy: number; radius: number; count: number };
  /** Everything's bounding box, on even coordinates for the chroma. */
  box: { x: number; y: number; width: number; height: number };
};

const even = (value: number) => Math.round(value / 2) * 2;

/** The row's geometry for a frame size, in pixels. */
export function metrics({ width, height }: Size) {
  const radius = even(Math.max(10, height * 0.03));
  return {
    radius,
    gap: Math.round(radius * 0.4),
    pad: Math.round(radius * 0.4),
    right: Math.round(height * 0.025),
    // Above the progress bar and its shade.
    bottom: Math.round(height * 0.07),
    font: Math.max(10, Math.round(radius * 0.72)),
    width,
    height,
  };
}

/** Who is drawn, in the order the huddle lists them, with speakers kept in. */
export function chooseShown(
  people: Person[],
  speaking: ReadonlySet<string>,
  limit = maxShown,
) {
  if (people.length <= limit) return { shown: people, extra: 0 };
  const speakers = people.filter((person) => speaking.has(person.id));
  const chosen = new Set(
    [...speakers, ...people.filter((person) => !speaking.has(person.id))]
      .slice(0, limit)
      .map((person) => person.id),
  );
  return {
    shown: people.filter((person) => chosen.has(person.id)),
    extra: people.length - chosen.size,
  };
}

const clip = (text: string, length: number) =>
  [...text].length > length
    ? `${[...text].slice(0, length - 1).join("")}…`
    : text;

/**
 * Where everything goes for a template. Pure geometry: the picture is drawn
 * from it, and the tests read it.
 */
export function layoutPeople(
  template: PeopleTemplate,
  people: Person[],
  speaking: ReadonlySet<string>,
  muted: ReadonlySet<string>,
  size: Size,
): Layout | undefined {
  if (template === "off" || !people.length) return undefined;
  const m = metrics(size);
  const { radius: r, gap, pad } = m;
  const baseline = m.height - m.bottom;
  const items: Placed[] = [];
  const pills: Layout["pills"] = [];
  let more: Layout["more"];
  const place = (
    person: Person,
    cx: number,
    cy: number,
    label?: Placed["label"],
  ) =>
    items.push({
      person,
      cx,
      cy,
      radius: r,
      speaking: speaking.has(person.id),
      muted: muted.has(person.id),
      label,
    });

  if (template === "all") {
    const { shown, extra } = chooseShown(people, speaking);
    const slots = shown.length + (extra ? 1 : 0);
    const width = pad * 2 + slots * 2 * r + (slots - 1) * gap;
    const x0 = m.width - m.right - width;
    const cy = baseline - pad - r;
    pills.push({ x: x0, y: cy - r - pad, width, height: 2 * r + 2 * pad });
    shown.forEach((person, index) =>
      place(person, x0 + pad + r + index * (2 * r + gap), cy),
    );
    if (extra)
      more = {
        cx: x0 + pad + r + shown.length * (2 * r + gap),
        cy,
        radius: r,
        count: extra,
      };
  } else if (template === "speaking") {
    const speakers = people
      .filter((person) => speaking.has(person.id))
      .slice(0, maxSpeakers);
    let right = m.width - m.right;
    const cy = baseline - pad - r;
    for (const person of speakers.reverse()) {
      const text = clip(person.name, 14);
      const textWidth = Math.round([...text].length * m.font * 0.62);
      const width = pad * 2 + 2 * r + gap + textWidth;
      const x0 = right - width;
      pills.push({ x: x0, y: cy - r - pad, width, height: 2 * r + 2 * pad });
      place(person, x0 + pad + r, cy, { x: x0 + pad + 2 * r + gap, text });
      right = x0 - gap;
    }
    if (!items.length) return undefined;
    items.reverse();
  } else {
    // Stacked: each circle half over the one before, speakers lifted.
    const step = Math.round(r * 1.6);
    const limit = 7;
    const shownPeople = chooseShown(people, speaking, limit);
    const slots = shownPeople.shown.length;
    const countWidth = shownPeople.extra ? Math.round(m.font * 3) : 0;
    const width =
      pad * 2 +
      (slots - 1) * step +
      2 * r +
      (countWidth ? gap + countWidth : 0);
    const x0 = m.width - m.right - width;
    const cy = baseline - pad - r;
    pills.push({ x: x0, y: cy - r - pad, width, height: 2 * r + 2 * pad });
    shownPeople.shown.forEach((person, index) =>
      place(
        person,
        x0 + pad + r + index * step,
        cy - (speaking.has(person.id) ? Math.round(r * 0.3) : 0),
      ),
    );
    if (shownPeople.extra)
      more = {
        cx: x0 + width - pad - Math.round(countWidth / 2),
        cy,
        radius: r,
        count: shownPeople.extra,
      };
  }

  // Rings and badges reach past the pill by a few pixels.
  const reach = Math.round(r * 0.3);
  const left = Math.min(...pills.map((pill) => pill.x)) - reach;
  const top = Math.min(...pills.map((pill) => pill.y)) - reach;
  const rightEdge =
    Math.max(...pills.map((pill) => pill.x + pill.width)) + reach;
  const bottomEdge =
    Math.max(...pills.map((pill) => pill.y + pill.height)) + reach;
  const x = Math.max(0, even(left));
  const y = Math.max(0, even(top));
  return {
    items,
    pills,
    more,
    box: {
      x,
      y,
      width: Math.min(m.width, even(rightEdge)) - x,
      height: Math.min(m.height, even(bottomEdge)) - y,
    },
  };
}

export type Patch = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA. */
  rgba: Uint8ClampedArray;
};

/** Draws a layout into a patch the size of its box. */
export function drawPeople(layout: Layout, size: Size): Patch {
  const { box } = layout;
  const canvas = createCanvas(box.width, box.height);
  const g = canvas.getContext("2d");
  g.translate(-box.x, -box.y);
  const m = metrics(size);
  const family = fonts();
  g.fillStyle = "rgba(0, 0, 0, 0.55)";
  for (const pill of layout.pills) {
    g.beginPath();
    g.roundRect(pill.x, pill.y, pill.width, pill.height, pill.height / 2);
    g.fill();
  }
  // The circles first, then every ring and mark over them, so a mark is not
  // hidden by the next circle in a stack.
  for (const item of layout.items) {
    const { cx, cy, radius, person } = item;
    g.save();
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.clip();
    if (person.image)
      g.drawImage(
        person.image,
        cx - radius,
        cy - radius,
        2 * radius,
        2 * radius,
      );
    else {
      g.fillStyle = colourFor(person.id);
      g.fillRect(cx - radius, cy - radius, 2 * radius, 2 * radius);
      g.fillStyle = "#ffffff";
      g.font = `600 ${Math.round(radius * 0.85)}px ${family}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(initialsOf(person.name), cx, cy + radius * 0.04);
    }
    g.restore();
    if (item.label) {
      g.fillStyle = "#ffffff";
      g.font = `600 ${m.font}px ${family}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(item.label.text, item.label.x, cy + 1);
    }
  }
  for (const item of layout.items) {
    const { cx, cy, radius } = item;
    if (item.speaking) {
      g.strokeStyle = "#2ecc71";
      g.lineWidth = Math.max(2, Math.round(radius * 0.16));
      g.beginPath();
      g.arc(cx, cy, radius + g.lineWidth, 0, Math.PI * 2);
      g.stroke();
    }
  }
  for (const item of layout.items) {
    const { cx, cy, radius } = item;
    if (!item.muted) continue;
    const badge = Math.max(5, Math.round(radius * 0.36));
    const bx = cx + radius * 0.72;
    const by = cy + radius * 0.72;
    g.fillStyle = "#d63031";
    g.beginPath();
    g.arc(bx, by, badge, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#ffffff";
    g.lineWidth = Math.max(1, Math.round(badge * 0.2));
    g.stroke();
    g.beginPath();
    g.moveTo(bx - badge * 0.5, by + badge * 0.5);
    g.lineTo(bx + badge * 0.5, by - badge * 0.5);
    g.stroke();
  }
  if (layout.more) {
    const { cx, cy, radius, count } = layout.more;
    g.fillStyle = "#4a4f57";
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.font = `600 ${Math.round(radius * 0.75)}px ${family}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(`+${count}`, cx, cy + 1);
  }
  return {
    ...box,
    rgba: g.getImageData(0, 0, box.width, box.height).data,
  };
}

// BT.601 limited range, as ffmpeg's scale leaves the frames.
const toY = (r: number, g: number, b: number) =>
  16 + 0.257 * r + 0.504 * g + 0.098 * b;
const toU = (r: number, g: number, b: number) =>
  128 - 0.148 * r - 0.291 * g + 0.439 * b;
const toV = (r: number, g: number, b: number) =>
  128 + 0.439 * r - 0.368 * g - 0.071 * b;

/**
 * Blends a patch into `frame`, a yuv420p frame of `size`, in place. The patch
 * starts on even coordinates, and takes an even width and height, so every
 * chroma sample it touches is covered by whole pixels.
 */
export function blendPatch(frame: Buffer, size: Size, patch: Patch) {
  const { width, height } = size;
  const uPlane = width * height;
  const chromaWidth = width / 2;
  const vPlane = uPlane + chromaWidth * (height / 2);
  const { rgba } = patch;
  for (let row = 0; row < patch.height; row++) {
    const y = patch.y + row;
    if (y < 0 || y >= height) continue;
    for (let column = 0; column < patch.width; column++) {
      const x = patch.x + column;
      if (x < 0 || x >= width) continue;
      const at = (row * patch.width + column) * 4;
      const alpha = rgba[at + 3]! / 255;
      if (!alpha) continue;
      const index = y * width + x;
      frame[index] = Math.round(
        frame[index]! * (1 - alpha) +
          toY(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!) * alpha,
      );
    }
  }
  for (let row = 0; row < patch.height; row += 2) {
    const y = patch.y + row;
    if (y < 0 || y + 1 >= height) continue;
    for (let column = 0; column < patch.width; column += 2) {
      const x = patch.x + column;
      if (x < 0 || x + 1 >= width) continue;
      let alpha = 0;
      let u = 0;
      let v = 0;
      for (const [dy, dx] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ] as const) {
        const at = ((row + dy) * patch.width + column + dx) * 4;
        const a = rgba[at + 3]! / 255;
        if (!a) continue;
        alpha += a;
        u += toU(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!) * a;
        v += toV(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!) * a;
      }
      if (!alpha) continue;
      const mean = alpha / 4;
      const index = (y >> 1) * chromaWidth + (x >> 1);
      frame[uPlane + index] = Math.round(
        frame[uPlane + index]! * (1 - mean) + (u / alpha) * mean,
      );
      frame[vPlane + index] = Math.round(
        frame[vPlane + index]! * (1 - mean) + (v / alpha) * mean,
      );
    }
  }
}

/**
 * Lays the row over a video's frames. Like the progress bar's overlay, a
 * frame is copied before it is drawn on, and the same frame with the same
 * row comes back as the same buffer, so the feed knows not to send it twice.
 */
export class PeopleOverlay {
  private template: PeopleTemplate = "off";
  private people: Person[] = [];
  private speaking = new Set<string>();
  private muted = new Set<string>();
  private lastSpoke = new Map<string, number>();
  private version = 0;
  private key = "";
  private patch: Patch | undefined;
  private source: Buffer | undefined;
  private drawnFor = "";
  private drawn: Buffer | undefined;
  private memory: ArrayBuffer[] = [];
  private turn = 0;

  constructor(
    private size: Size,
    private now: () => number = Date.now,
    private hold = ringHoldMs,
  ) {}

  setTemplate(template: PeopleTemplate) {
    this.template = template;
  }

  setPeople(people: Person[]) {
    this.people = people;
    this.version++;
  }

  /** Who is speaking and who is muted, as the meeting last reported. */
  setState(speaking: Iterable<string>, muted: Iterable<string>) {
    this.speaking = new Set(speaking);
    this.muted = new Set(muted);
    const now = this.now();
    for (const id of this.speaking) this.lastSpoke.set(id, now);
  }

  /** Whoever is speaking now, or was a moment ago. */
  private ringed() {
    const now = this.now();
    return new Set(
      this.people
        .map((person) => person.id)
        .filter(
          (id) =>
            this.speaking.has(id) ||
            now - (this.lastSpoke.get(id) ?? -Infinity) < this.hold,
        ),
    );
  }

  /** The frame with the row over it, or the frame itself with nothing to draw. */
  over(frame: Buffer) {
    if (this.template === "off" || !this.people.length) return frame;
    const ringed = this.ringed();
    const key = [
      this.template,
      this.version,
      [...ringed].sort().join(","),
      [...this.muted].sort().join(","),
    ].join("|");
    if (key !== this.key) {
      this.key = key;
      const layout = layoutPeople(
        this.template,
        this.people,
        ringed,
        this.muted,
        this.size,
      );
      this.patch = layout ? drawPeople(layout, this.size) : undefined;
    }
    if (!this.patch) return frame;
    if (frame === this.source && this.key === this.drawnFor && this.drawn)
      return this.drawn;
    this.turn = 1 - this.turn;
    let memory = this.memory[this.turn];
    if (memory?.byteLength !== frame.length)
      memory = this.memory[this.turn] = new ArrayBuffer(frame.length);
    const drawn = Buffer.from(memory);
    frame.copy(drawn);
    blendPatch(drawn, this.size, this.patch);
    this.source = frame;
    this.drawnFor = this.key;
    this.drawn = drawn;
    return drawn;
  }

  clear() {
    this.key = "";
    this.patch = undefined;
    this.source = undefined;
    this.drawn = undefined;
    this.drawnFor = "";
    this.memory = [];
    this.lastSpoke.clear();
  }
}
