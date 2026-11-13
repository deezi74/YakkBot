/**
 * YakkBot's avatar silhouettes, drawn in code. Each is a closed outline around the middle of a
 * 55.2-unit square with two eyes cut out of it; the eyes are holes (even-odd fill), so they show
 * white over the white underlay whatever the bot's colour.
 */
export interface ShapeDef { viewBox: string; d: string; outline: string }

const SIZE = 55.2;
const C = SIZE / 2;
const R = 16.6;
type Pt = [number, number];

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const path = (pts: Pt[]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;

/** A closed curve from a radius function of the angle (0 = up, clockwise). */
function polar(radius: (t: number) => number, steps = 96, sy = 1): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * Math.PI * 2;
    const r = radius(t) * R;
    return [C + Math.sin(t) * r, C - Math.cos(t) * r * sy] as Pt;
  });
}

/** Round a polygon's corners by cutting them (Chaikin), which keeps it inside the original. */
function rounded(pts: Pt[], passes = 3): Pt[] {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out = next;
  }
  return out;
}

const poly = (pts: Pt[], passes = 3) => rounded(pts.map(([x, y]) => [C + x * R, C + y * R] as Pt), passes);
const ngon = (n: number, r0 = 1, r1 = r0, turn = 0): Pt[] => {
  const count = n * (r0 === r1 ? 1 : 2);
  return Array.from({ length: count }, (_v, i): Pt => {
    const t = turn + (i / count) * Math.PI * 2;
    const r = r0 === r1 || i % 2 === 0 ? r0 : r1;
    return [Math.sin(t) * r, -Math.cos(t) * r];
  });
};
/** |x|^n + |y|^n = 1: from a circle (2) towards a square. */
const superellipse = (n: number, a = 1, b = 1) => polar((t) => {
  const s = Math.abs(Math.sin(t)) / a, c = Math.abs(Math.cos(t)) / b;
  return 1 / Math.pow(Math.pow(s, n) + Math.pow(c, n), 1 / n);
});

const OUTLINES: Record<string, Pt[]> = {
  blob: polar(() => 1),
  pebble: polar((t) => 1 + 0.07 * Math.sin(t * 2 + 0.6) + 0.04 * Math.cos(t * 3)),
  egg: polar((t) => 1.04 - 0.1 * Math.cos(t), 96, 1.08),
  bean: polar((t) => 1 + 0.12 * Math.cos(t * 2 - 0.5) - 0.08 * Math.sin(t)),
  squircle: superellipse(4),
  square: superellipse(7, 0.94, 0.94),
  tablet: superellipse(5, 1.08, 0.82),
  capsule: superellipse(2.6, 1.12, 0.74),
  cylinder: superellipse(6, 0.84, 1.04),
  hex: poly(ngon(6, 1.08), 2),
  gem: poly([[0, -1.05], [0.95, -0.35], [0.6, 1], [-0.6, 1], [-0.95, -0.35]], 2),
  crystal: poly([[0, -1.15], [0.85, -0.1], [0, 1.15], [-0.85, -0.1]], 2),
  wedge: poly([[-1, 0.9], [1, 0.9], [1, -0.2], [-0.2, -1], [-1, -0.6]], 3),
  shield: poly([[-0.95, -0.95], [0.95, -0.95], [0.95, 0.15], [0, 1.15], [-0.95, 0.15]], 3),
  dome: poly([[-1, 0.95], [1, 0.95], [1, 0], [0.7, -0.75], [0, -1.05], [-0.7, -0.75], [-1, 0]], 3),
  arch: poly([[-0.9, 1], [0.9, 1], [0.9, -0.2], [0.55, -0.9], [0, -1.1], [-0.55, -0.9], [-0.9, -0.2]], 3),
  house: poly([[-0.95, 1], [0.95, 1], [0.95, -0.15], [0, -1.15], [-0.95, -0.15]], 3),
  cloud: polar((t) => 1 + 0.09 * Math.cos(t * 5), 120, 0.9),
  clover: polar((t) => 0.86 + 0.2 * Math.abs(Math.cos(t * 2 + Math.PI / 2)), 160),
  flower: polar((t) => 0.92 + 0.13 * Math.cos(t * 6), 144),
  sparkle: poly(ngon(4, 1.2, 0.62), 3),
  star: poly(ngon(5, 1.2, 0.68), 3),
  teardrop: polar((t) => 0.98 + 0.26 * Math.pow(Math.max(Math.cos(t), 0), 5) - 0.04 * Math.cos(t), 120),
  leaf: polar((t) => 0.9 + 0.24 * Math.pow(Math.abs(Math.cos(t - 0.7)), 4), 120),
  heart: polar((t) => {
    const x = Math.abs(Math.sin(t)), up = Math.cos(t);
    return 0.96 + 0.14 * x - (up > 0 ? 0.3 * Math.pow(up, 6) : 0) + (up < 0 ? 0.2 * Math.pow(-up, 8) : 0);
  }, 160),
};

/** Two tall rounded eyes, a little above centre. */
function eyes(): string {
  const w = 3.3, h = 6.6, gap = 4.5, top = C - 5.4, r = w / 2;
  const one = (x: number) =>
    `M${f(x)} ${f(top + r)}a${f(r)} ${f(r)} 0 0 1 ${f(w)} 0v${f(h - w)}a${f(r)} ${f(r)} 0 0 1 ${f(-w)} 0Z`;
  return one(C - gap / 2 - w) + one(C + gap / 2);
}

const EYES = eyes();
export const SHAPES: Record<string, ShapeDef> = Object.fromEntries(
  Object.entries(OUTLINES).map(([name, pts]) => {
    const outline = path(pts);
    return [name, { viewBox: `0 0 ${SIZE} ${SIZE}`, outline, d: outline + EYES }];
  }),
);
