// Sample library for the Store and website screenshots: `?showcase=en` or `?showcase=de` in
// browser mode (scripts/store-screenshots.mjs). The mock backend's everyday library gives
// every model the same height field, which is fine for tests and useless as a picture of
// the app. Here each project gets a small procedural model that looks like the thing its
// title names, and titles, folders and tags exist in both listing languages. The models are
// made up for this purpose: no downloaded files, no real designers.

type P2 = [number, number];
type V3 = [number, number, number];
type Tri = [V3, V3, V3];

const TAU = Math.PI * 2;

// ---- geometry ---------------------------------------------------------------------------

/** Points of a contour at the given angles. */
const atAngles = (angles: number[], radius: (a: number, i: number) => number): P2[] =>
  angles.map((a, i) => [radius(a, i) * Math.cos(a), radius(a, i) * Math.sin(a)]);
const angles = (n: number, from = 0, to = TAU): number[] =>
  Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (to - from >= TAU ? n : n - 1));
const circle = (r: number, n = 48): P2[] => atAngles(angles(n), () => r);

/** Surface of revolution around Z. `profile` is [radius, z]; `shape` scales the radius by angle and height (lobes, twist). */
function lathe(profile: P2[], segments = 56, shape: (a: number, z: number) => number = () => 1): Tri[] {
  const tris: Tri[] = [];
  const pt = (r: number, z: number, i: number): V3 => {
    const a = (i / segments) * TAU;
    const k = r * shape(a, z);
    return [k * Math.cos(a), k * Math.sin(a), z];
  };
  for (let j = 0; j < profile.length - 1; j++) {
    const [r0, z0] = profile[j]!;
    const [r1, z1] = profile[j + 1]!;
    for (let i = 0; i < segments; i++) {
      const a = pt(r0, z0, i), b = pt(r0, z0, i + 1), c = pt(r1, z1, i + 1), d = pt(r1, z1, i);
      if (r0 > 0) tris.push([a, b, c]);
      if (r1 > 0) tris.push([a, c, d]);
    }
  }
  return tris;
}

/** A hollow vessel: the outer profile, a wall of `wall` and a floor of `floor` above the first point. */
function vessel(outer: P2[], wall: number, floor: number, segments = 56, shape?: (a: number, z: number) => number): Tri[] {
  const z0 = outer[0]![1];
  const inner = outer.slice().reverse().map(([r, z]): P2 => [Math.max(r - wall, 0.5), Math.max(z, z0 + floor)]);
  return lathe([[0, z0], ...outer, ...inner, [0, z0 + floor]], segments, shape);
}

/** Wall between two contours with the same number of points, with top and bottom. `open` leaves the loop unclosed and caps both ends. */
function ring(outer: P2[], inner: P2[], z0: number, z1: number, open = false): Tri[] {
  const tris: Tri[] = [];
  const n = outer.length;
  const v = (p: P2, z: number): V3 => [p[0], p[1], z];
  const quad = (a: V3, b: V3, c: V3, d: V3) => { tris.push([a, b, c], [a, c, d]); };
  for (let i = 0; i < (open ? n - 1 : n); i++) {
    const o0 = outer[i]!, o1 = outer[(i + 1) % n]!, i0 = inner[i]!, i1 = inner[(i + 1) % n]!;
    quad(v(o0, z0), v(o1, z0), v(o1, z1), v(o0, z1));
    quad(v(i0, z0), v(i0, z1), v(i1, z1), v(i1, z0));
    quad(v(o0, z1), v(o1, z1), v(i1, z1), v(i0, z1));
    quad(v(o0, z0), v(i0, z0), v(i1, z0), v(o1, z0));
  }
  if (open) for (const i of [0, n - 1]) quad(v(outer[i]!, z0), v(inner[i]!, z0), v(inner[i]!, z1), v(outer[i]!, z1));
  return tris;
}

/** Solid prism over a polygon that is convex or star-shaped around its centroid. */
function prism(poly: P2[], z0: number, z1: number): Tri[] {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const tris: Tri[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    tris.push([[cx, cy, z1], [a[0], a[1], z1], [b[0], b[1], z1]], [[cx, cy, z0], [b[0], b[1], z0], [a[0], a[1], z0]]);
    tris.push([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]], [[a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]]);
  }
  return tris;
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Tri[] =>
  prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1);
const map = (tris: Tri[], fn: (v: V3) => V3): Tri[] => tris.map(([a, b, c]) => [fn(a), fn(b), fn(c)]);
const move = (tris: Tri[], dx: number, dy: number, dz = 0): Tri[] => map(tris, ([x, y, z]) => [x + dx, y + dy, z + dz]);
/** Stands a shape drawn in XY and extruded along Z upright: its XY becomes XZ, its height runs along Y. */
const upright = (tris: Tri[]): Tri[] => map(tris, ([x, y, z]) => [x, z, y]);

function roundedRect(w: number, d: number, r: number, perCorner = 6): P2[] {
  const pts: P2[] = [];
  const corners: P2[] = [[w / 2 - r, d / 2 - r], [-w / 2 + r, d / 2 - r], [-w / 2 + r, -d / 2 + r], [w / 2 - r, -d / 2 + r]];
  corners.forEach(([cx, cy], k) => {
    for (let i = 0; i <= perCorner; i++) {
      const a = (k + i / perCorner) * (TAU / 4);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  });
  return pts;
}

/** Four points per tooth: root, tip, tip, root. The same angles serve the matching bore or rim. */
function gearAngles(teeth: number): number[] {
  const p = TAU / teeth;
  return Array.from({ length: teeth }, (_, t) => [0, 0.18, 0.42, 0.6].map((k) => (t + k) * p)).flat();
}
const toothed = (a: number[], root: number, tip: number): P2[] => atAngles(a, (_, i) => (i % 4 === 1 || i % 4 === 2 ? tip : root));

function gear(teeth: number, root: number, tip: number, bore: number, height: number): Tri[] {
  const a = gearAngles(teeth);
  return [
    ...ring(toothed(a, root, tip), atAngles(a, () => bore), 0, height),
    ...ring(circle(root * 0.62), circle(bore), height, height * 1.45),
  ];
}

// ---- models -----------------------------------------------------------------------------

const lobes = (count: number, depth: number, twist: number, height: number) => (a: number, z: number) =>
  1 + depth * Math.cos(count * (a + (twist * z) / height));

const models = {
  vase: () => vessel([[19, 0], [27, 10], [31, 34], [23, 64], [15, 84], [18, 98], [22, 104]], 2, 3, 72, lobes(6, 0.07, 1.4, 104)),
  bottleVase: () => vessel([[16, 0], [24, 6], [26, 40], [12, 66], [9, 92], [13, 98]], 1.8, 3, 64, lobes(10, 0.035, -0.9, 98)),
  lampShade: () => vessel([[26, 0], [46, 42], [34, 86], [30, 92]], 1.6, 0, 96, lobes(12, 0.06, 1.8, 92)).filter((t) => t.some((v) => v[2] > 0.01)),
  planter: () => [
    ...move(vessel([[30, 0], [40, 58], [43, 58], [43, 63]], 2.4, 3), 0, 0, 5),
    ...lathe([[0, 0], [47, 0], [51, 9], [48, 9], [45, 3], [0, 3]]),
  ],
  herbPots: () => [-1, 0, 1].flatMap((k) => move(vessel([[17, 0], [23, 34], [25, 34], [25, 38]], 1.8, 2.5, 40), k * 56, 0)),
  funnel: () => vessel([[6, 0], [6, 28], [40, 66], [43, 66], [43, 70]], 1.6, 0).filter((t) => t.some((v) => v[2] > 0.01)),
  gearbox: () => {
    const a = gearAngles(36);
    return [
      ...prism(circle(46, 72), -3, 0),
      ...ring(atAngles(a, () => 46), toothed(a, 38, 34), 0, 12),
      ...gear(12, 10, 14, 4, 12),
      ...[0, 1, 2].flatMap((k) => move(gear(12, 10, 14, 3, 12), 24 * Math.cos((k * TAU) / 3 + 0.26), 24 * Math.sin((k * TAU) / 3 + 0.26))),
    ];
  },
  gearPair: () => [...gear(24, 26, 31, 5, 9), ...move(gear(12, 12, 17, 4, 9), 45.5, 0)],
  bin: (w = 84, d = 42, h = 44, dividers = 1) => [
    ...prism(roundedRect(w, d, 5), 0, 2.4),
    ...ring(roundedRect(w, d, 5), roundedRect(w - 3.6, d - 3.6, 3.2), 2.4, h),
    ...Array.from({ length: dividers }, (_, i) => box(-w / 2 + ((i + 1) * w) / (dividers + 1) - 0.9, -d / 2 + 1, 2.4, -w / 2 + ((i + 1) * w) / (dividers + 1) + 0.9, d / 2 - 1, h - 6)).flat(),
  ],
  organizer: () => [
    ...prism(roundedRect(130, 84, 6), 0, 2.4),
    ...ring(roundedRect(130, 84, 6), roundedRect(126, 80, 4), 2.4, 24),
    ...box(-22, -40, 2.4, -20, 40, 21), ...box(24, -40, 2.4, 26, 40, 21),
    ...box(-64, -1, 2.4, -22, 1, 21), ...box(26, 12, 2.4, 64, 14, 21), ...box(26, -16, 2.4, 64, -14, 21),
  ],
  boxWithLid: () => [
    ...prism(roundedRect(70, 50, 6), 0, 2.4),
    ...ring(roundedRect(70, 50, 6), roundedRect(66, 46, 4), 2.4, 36),
    ...move([...prism(roundedRect(73, 53, 7), 0, 3), ...ring(roundedRect(73, 53, 7), roundedRect(70.6, 50.6, 6), 3, 9)], 0, 66),
  ],
  cableClips: () => [8, 11, 14].flatMap((r, k) => {
    const a = angles(28, 0.75, TAU - 0.75);
    return move([...ring(atAngles(a, () => r), atAngles(a, () => r - 2.4), 0, 11, true), ...box(-r - 9, -5, 0, -r + 1, 5, 2.4)], [0, 34, 76][k]!, 0);
  }),
  hook: () => {
    const a = angles(24, Math.PI, TAU);
    return [
      ...box(0, -17, 0, 4.5, 17, 74),
      ...move(upright(ring(atAngles(a, () => 21), atAngles(a, () => 14.5), -9, 9, true)), 25.5, 0, 34),
      ...box(4.5, -9, 34, 6, 9, 48),
    ];
  },
  bracket: () => [
    ...box(0, -17, 0, 64, 17, 4.5),
    ...box(0, -17, 0, 4.5, 17, 52),
    ...upright(prism([[4.5, 4.5], [46, 4.5], [4.5, 40]], -2.2, 2.2)),
  ],
  phoneStand: () => [
    ...prism(roundedRect(84, 72, 8), 0, 5),
    ...move(upright(prism([[18, 5], [26, 5], [2, 82], [-6, 82]], -30, 30)), 20, 0),
    ...box(-34, -30, 5, -27, 30, 17),
  ],
  boltAndNut: () => {
    const thread: P2[] = Array.from({ length: 31 }, (_, i) => [i % 2 ? 4.3 : 5, 12 + i]);
    const hex = atAngles(angles(24), (a) => 9 * Math.cos(TAU / 12) / Math.cos(((a + TAU / 12) % (TAU / 6)) - TAU / 12));
    return [
      ...prism(atAngles(angles(6), () => 9), 0, 6.5),
      ...lathe([[5, 6.5], [5, 12], ...thread, [3.6, 44], [0, 44]], 32),
      ...move(ring(hex, circle(4.6, 24), 0, 7.5), 27, 0),
    ];
  },
  knob: () => [
    ...lathe([[0, 0], [7, 0], [7, 9], [0, 9]], 32),
    ...lathe([[7, 9], [17, 9], [19, 12], [19, 22], [15, 26], [0, 26]], 80, lobes(8, 0.09, 0, 1)),
  ],
  tower: () => [
    ...lathe([[0, 0], [24, 0], [24, 5], [18, 10], [16, 52], [21, 58], [21, 64], [0, 64]], 64),
    ...Array.from({ length: 6 }, (_, k) => {
      const a = angles(8, (k * TAU) / 6 + 0.12, (k * TAU) / 6 + 0.74);
      return ring(atAngles(a, () => 21), atAngles(a, () => 15), 64, 74, true);
    }).flat(),
  ],
  starCutter: () => {
    const a = angles(10);
    const star = (outer: number, inner: number) => atAngles(a, (_, i) => (i % 2 ? inner : outer));
    return [...ring(star(44, 20.5), star(40, 18), 0, 2.2), ...ring(star(40, 18), star(38, 16.6), 0, 20)];
  },
  spool: () => lathe([[0, 0], [34, 0], [34, 3], [11, 5], [11, 47], [34, 49], [34, 52], [0, 52]], 64),
} satisfies Record<string, (...args: number[]) => Tri[]>;

// ---- library ----------------------------------------------------------------------------

export type ShowcaseLanguage = 'en' | 'de';
type Text = Record<ShowcaseLanguage, string>;
type Model = () => Tri[];

interface Entry {
  root: 'r1' | 'r2';
  folder: Text;
  title: Text;
  creator: string;
  license?: string;
  source?: string;
  tags: Record<ShowcaseLanguage, string[]>;
  material?: string;
  supports?: boolean;
  description?: Text;
  favorite?: boolean;
  offline?: boolean;
  daysAgo: number;
  /** File name, size in MB, model. The first is the largest, so it becomes the preview. */
  files: [string, number, Model][];
}

const t = (en: string, de: string): Text => ({ en, de });
const tags = (en: string[], de: string[]) => ({ en, de });
const STORAGE = t('Storage', 'Aufbewahrung'), HOME = t('Household', 'Haushalt'), MECH = t('Mechanical', 'Mechanik');
const DECOR = t('Decor', 'Deko'), GARDEN = t('Garden', 'Garten'), WORKSHOP = t('Workshop', 'Werkstatt'), GAMES = t('Games', 'Spiele');

const entries: Entry[] = [
  { root: 'r1', folder: MECH, title: t('Planetary Gearbox', 'Planetengetriebe'), creator: 'GearWorks', license: 'CC-BY-SA-4.0', source: 'https://www.printables.com/model/123456', tags: tags(['mechanical', 'functional', 'gears'], ['mechanik', 'funktional', 'zahnräder']), material: 'PETG', supports: false, description: t('Compact 4:1 planetary stage for small geared motors. Print the ring gear with four perimeters; the planets run on 3 mm pins.', 'Kompakte 4:1-Planetenstufe für kleine Getriebemotoren. Das Hohlrad mit vier Perimetern drucken; die Planeten laufen auf 3-mm-Stiften.'), favorite: true, daysAgo: 0, files: [['gearbox_assembly.stl', 18, models.gearbox], ['sun_gear.stl', 2.1, () => gear(12, 10, 14, 4, 12)], ['planet_gear_x3.stl', 2.3, () => gear(12, 10, 14, 3, 12)], ['gear_pair_test.stl', 4.2, models.gearPair]] },
  { root: 'r1', folder: DECOR, title: t('Twisted Vase', 'Gedrehte Vase'), creator: 'Lena Hofer', license: 'CC-BY-4.0', tags: tags(['vase', 'decor', 'vase mode'], ['vase', 'deko', 'vasenmodus']), material: 'PLA', supports: false, description: t('Prints in vase mode with a 0.6 mm nozzle.', 'Druckt im Vasenmodus mit 0,6-mm-Düse.'), favorite: true, daysAgo: 1, files: [['vase_twisted.stl', 9.8, models.vase]] },
  { root: 'r1', folder: STORAGE, title: t('Stackable Bins', 'Stapelbare Boxen'), creator: 'Maker Mia', license: 'CC0-1.0', tags: tags(['storage', 'organizer'], ['aufbewahrung', 'ordnung']), material: 'PLA', daysAgo: 2, files: [['bin_3x1.stl', 8.2, () => models.bin(126, 42, 44, 2)], ['bin_2x1_divided.stl', 6.4, () => models.bin(84, 42, 44, 1)], ['bin_1x1.stl', 3.1, () => models.bin(42, 42, 44, 0)]] },
  { root: 'r1', folder: HOME, title: t('Wall Hook', 'Wandhaken'), creator: 'Studio Nord', license: 'CC-BY-4.0', tags: tags(['household', 'functional'], ['haushalt', 'funktional']), material: 'PETG', daysAgo: 3, files: [['hook_large.stl', 2.6, models.hook]] },
  { root: 'r1', folder: GAMES, title: t('Castle Tower', 'Burgturm'), creator: 'TableTop Forge', license: 'CC-BY-NC-SA-4.0', tags: tags(['tabletop', 'gaming'], ['tabletop', 'spiele']), material: 'PLA', favorite: true, daysAgo: 5, files: [['tower.stl', 12, models.tower]] },
  { root: 'r1', folder: GARDEN, title: t('Self-watering Planter', 'Pflanztopf mit Wasserspeicher'), creator: 'Lena Hofer', license: 'CC-BY-4.0', tags: tags(['garden', 'decor'], ['garten', 'deko']), material: 'PETG', daysAgo: 6, files: [['planter_with_saucer.stl', 14, models.planter]] },
  { root: 'r1', folder: HOME, title: t('Cable Clips', 'Kabelclips'), creator: 'Maker Mia', license: 'CC0-1.0', tags: tags(['cable', 'organizer'], ['kabel', 'ordnung']), material: 'TPU', daysAgo: 8, files: [['clips_8_11_14mm.stl', 1.2, models.cableClips]] },
  { root: 'r1', folder: HOME, title: t('Phone Stand', 'Handyständer'), creator: 'PrintTools', license: 'CC0-1.0', tags: tags(['desk', 'functional'], ['schreibtisch', 'funktional']), material: 'PLA', daysAgo: 9, files: [['stand.stl', 4.1, models.phoneStand]] },
  { root: 'r1', folder: STORAGE, title: t('Drawer Organizer', 'Schubladeneinsatz'), creator: 'Studio Nord', license: 'CC-BY-4.0', tags: tags(['storage', 'organizer'], ['aufbewahrung', 'ordnung']), material: 'PLA', daysAgo: 12, files: [['organizer_130x84.stl', 11, models.organizer]] },
  { root: 'r1', folder: WORKSHOP, title: t('Bolt and Nut M10', 'Schraube und Mutter M10'), creator: 'GearWorks', license: 'MIT', tags: tags(['mechanical', 'calibration'], ['mechanik', 'kalibrierung']), material: 'PETG', daysAgo: 14, files: [['bolt_nut_m10.stl', 3.4, models.boltAndNut]] },
  { root: 'r1', folder: DECOR, title: t('Pendant Lamp Shade', 'Lampenschirm'), creator: 'Lena Hofer', license: 'CC-BY-NC-4.0', tags: tags(['decor', 'lighting', 'vase mode'], ['deko', 'licht', 'vasenmodus']), material: 'PETG', daysAgo: 16, files: [['shade_e27.stl', 16, models.lampShade]] },
  { root: 'r1', folder: STORAGE, title: t('Box with Lid', 'Dose mit Deckel'), creator: 'Maker Mia', license: 'CC0-1.0', tags: tags(['storage'], ['aufbewahrung']), material: 'PLA', daysAgo: 20, files: [['box_and_lid.stl', 7.2, models.boxWithLid]] },
  { root: 'r1', folder: WORKSHOP, title: t('Shelf Bracket', 'Regalwinkel'), creator: 'PrintTools', license: 'CC-BY-4.0', tags: tags(['workshop', 'functional'], ['werkstatt', 'funktional']), material: 'PETG', supports: false, daysAgo: 24, files: [['bracket_64mm.stl', 2.9, models.bracket]] },
  { root: 'r1', folder: GARDEN, title: t('Herb Pots', 'Kräutertöpfe'), creator: 'Studio Nord', license: 'CC-BY-4.0', tags: tags(['garden', 'kitchen'], ['garten', 'küche']), material: 'PLA', daysAgo: 30, files: [['herb_pots_x3.stl', 8.6, models.herbPots]] },
  { root: 'r1', folder: MECH, title: t('Gear Pair 2:1', 'Zahnradpaar 2:1'), creator: 'GearWorks', license: 'MIT', tags: tags(['mechanical', 'gears'], ['mechanik', 'zahnräder']), material: 'PETG', daysAgo: 34, files: [['gear_pair.stl', 4.2, models.gearPair]] },
  { root: 'r1', folder: HOME, title: t('Cookie Cutter Star', 'Ausstechform Stern'), creator: 'Maker Mia', license: 'CC0-1.0', tags: tags(['kitchen'], ['küche']), material: 'PETG', daysAgo: 40, files: [['star_cutter.stl', 1.8, models.starCutter]] },
  { root: 'r1', folder: WORKSHOP, title: t('Thumb Knob M6', 'Sterngriff M6'), creator: 'PrintTools', license: 'CC-BY-4.0', tags: tags(['workshop', 'functional'], ['werkstatt', 'funktional']), material: 'PETG', daysAgo: 46, files: [['knob_m6.stl', 2.2, models.knob]] },
  { root: 'r1', folder: DECOR, title: t('Bottle Vase', 'Flaschenvase'), creator: 'Lena Hofer', license: 'CC-BY-4.0', tags: tags(['vase', 'decor'], ['vase', 'deko']), material: 'PLA', daysAgo: 52, files: [['vase_bottle.stl', 7.4, models.bottleVase]] },
  { root: 'r1', folder: HOME, title: t('Kitchen Funnel', 'Küchentrichter'), creator: 'Studio Nord', license: 'CC0-1.0', tags: tags(['kitchen'], ['küche']), material: 'PETG', daysAgo: 60, files: [['funnel_86mm.stl', 3.9, models.funnel]] },
  { root: 'r1', folder: WORKSHOP, title: t('Filament Spool Core', 'Filamentspulenkern'), creator: 'PrintTools', license: 'CC-BY-4.0', tags: tags(['workshop', 'printer'], ['werkstatt', 'drucker']), material: 'PETG', daysAgo: 75, files: [['spool_core.stl', 5.5, models.spool]] },
  { root: 'r2', folder: t('Archive', 'Archiv'), title: t('Small Parts Bins', 'Kleinteileboxen'), creator: 'Maker Mia', license: 'CC0-1.0', tags: tags(['storage'], ['aufbewahrung']), material: 'PLA', offline: true, daysAgo: 90, files: [['bins_small.stl', 4.8, () => models.bin(42, 42, 30, 0)]] },
];

export interface ShowcaseProject {
  root: 'r1' | 'r2';
  path: string;
  title: string;
  creator: string;
  license: string | null;
  source: string | null;
  tags: string[];
  material: string | null;
  supports: boolean | null;
  description: string | null;
  favorite: boolean;
  offline: boolean;
  daysAgo: number;
  files: { name: string; bytes: number }[];
}

export const showcaseLanguage = (value: string | null): ShowcaseLanguage | null => (value === 'en' || value === 'de' ? value : null);

export function showcaseProjects(lang: ShowcaseLanguage): ShowcaseProject[] {
  return entries.map((e) => ({
    root: e.root,
    path: `${e.root === 'r1' ? (lang === 'de' ? 'Projekte/' : 'Projects/') : ''}${e.folder[lang]}/${e.title[lang]}`,
    title: e.title[lang],
    creator: e.creator,
    license: e.license ?? null,
    source: e.source ?? null,
    tags: e.tags[lang],
    material: e.material ?? null,
    supports: e.supports ?? null,
    description: e.description?.[lang] ?? null,
    favorite: e.favorite ?? false,
    offline: e.offline ?? false,
    daysAgo: e.daysAgo,
    files: e.files.map(([name, mb]) => ({ name, bytes: Math.round(mb * 1024 * 1024) })),
  }));
}

/** Binary STL of the model behind a showcase file, or null when the name is not part of the showcase. */
export function showcaseStl(fileName: string): ArrayBuffer | null {
  const model = entries.flatMap((e) => e.files).find(([name]) => name === fileName)?.[2];
  if (!model) return null;
  const tris = model();
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const, v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (const x of [n[0]! / len, n[1]! / len, n[2]! / len, ...a, ...b, ...c]) { view.setFloat32(off, x, true); off += 4; }
    off += 2;
  }
  return buf;
}

export const showcaseFileNames = (): string[] => entries.flatMap((e) => e.files.map(([name]) => name));
