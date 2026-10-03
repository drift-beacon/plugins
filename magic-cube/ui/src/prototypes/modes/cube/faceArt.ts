import * as THREE from "three";

/** Everything a face shows. Colours are resolved hex, icons are MDI path data (viewBox 0 0 24 24). */
export interface FaceArt {
  face: string;
  color: string | null;
  iconPath: string | null;
  label: string | null;
  sublabel: string | null;
  isCategory: boolean;
  tag: "should" | "feel" | null;
}

const SIZE = 512;
const SHUFFLE =
  "M17,3L22.25,7.5L17,12L22.25,16.5L17,21V18H14.26L11.44,15.18L13.56,13.06L15.5,15H17V12L17,9H15.5L6.5,18H2V15H5.26L14.26,6H17V3M2,6H6.5L9.32,8.82L7.2,10.94L5.26,9H2V6Z";
const PLUS = "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z";

// Die pips, anchored top-left like a printed index (3x3 grid positions).
const PIPS: Record<string, number[]> = { "1": [4], "2": [2, 6], "3": [2, 4, 6], "4": [0, 2, 6, 8], "5": [0, 2, 4, 6, 8], "6": [0, 3, 6, 2, 5, 8] };

const FONT = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";

function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function drawIcon(ctx: CanvasRenderingContext2D, path: string, cx: number, cy: number, size: number, fill: string) {
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - 12 * s, cy - 12 * s);
  ctx.scale(s, s);
  ctx.fillStyle = fill;
  ctx.fill(new Path2D(path));
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, art: FaceArt) {
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Panel: the face's own inset plate. Transparent outside the rounded rect so the body's bevel shows.
  roundRect(ctx, 10, 10, SIZE - 20, SIZE - 20, 64);
  ctx.fillStyle = "#1c1c21";
  ctx.fill();

  if (art.color) {
    const g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, alpha(art.color, 0.32));
    g.addColorStop(1, alpha(art.color, 0.08));
    ctx.fillStyle = g;
    ctx.fill();
    roundRect(ctx, 26, 26, SIZE - 52, SIZE - 52, 50);
    ctx.lineWidth = 5;
    ctx.strokeStyle = alpha(art.color, 0.5);
    ctx.stroke();
  } else {
    roundRect(ctx, 30, 30, SIZE - 60, SIZE - 60, 46);
    ctx.setLineDash([22, 16]);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Pips, top-left.
  const pip = 11;
  const gap = 30;
  ctx.fillStyle = art.color ? alpha(art.color, 0.75) : "rgba(255,255,255,0.35)";
  for (const i of PIPS[art.face] ?? []) {
    ctx.beginPath();
    ctx.arc(66 + (i % 3) * gap, 66 + Math.floor(i / 3) * gap, pip, 0, Math.PI * 2);
    ctx.fill();
  }

  // Side tag, top-right.
  if (art.tag) {
    ctx.font = `800 30px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = art.tag === "should" ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.78)";
    ctx.letterSpacing = "4px";
    ctx.fillText(art.tag === "should" ? "SHOULD" : "FEEL", SIZE - 60, 94);
    ctx.letterSpacing = "0px";
  }

  if (!art.iconPath || !art.color) {
    drawIcon(ctx, PLUS, SIZE / 2, SIZE / 2, 120, "rgba(255,255,255,0.28)");
    ctx.font = `600 34px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText("Empty face", SIZE / 2, 400);
    return;
  }

  // Icon with a soft glow of its own colour.
  ctx.save();
  ctx.shadowColor = alpha(art.color, 0.65);
  ctx.shadowBlur = 36;
  drawIcon(ctx, art.iconPath, SIZE / 2, 222, 188, art.color);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `650 40px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(fitText(ctx, art.label ?? "", SIZE - 110), SIZE / 2, 392);

  if (art.sublabel) {
    ctx.font = `500 28px ${FONT}`;
    const text = fitText(ctx, art.sublabel, SIZE - 170);
    const w = ctx.measureText(text).width;
    const icon = art.isCategory ? 30 : 0;
    const x = SIZE / 2 - (w + icon + (icon ? 10 : 0)) / 2;
    if (art.isCategory) drawIcon(ctx, SHUFFLE, x + icon / 2, 432, icon, "rgba(255,255,255,0.5)");
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(text, x + icon + (icon ? 10 : 0), 442);
  }
}

const cache = new Map<string, THREE.CanvasTexture>();

/** A face texture, cached by content so re-renders with fresh objects reuse the GPU upload. */
export function faceTexture(art: FaceArt): THREE.CanvasTexture {
  const key = JSON.stringify(art);
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  draw(canvas.getContext("2d")!, art);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

export const faceKey = (art: FaceArt) => JSON.stringify(art);

let ringTex: THREE.CanvasTexture | null = null;
/** A white rounded-rect outline, for selection and hover rims. */
export function ringTexture() {
  if (ringTex) return ringTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  roundRect(ctx, 10, 10, SIZE - 20, SIZE - 20, 64);
  ctx.lineWidth = 14;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ringTex = new THREE.CanvasTexture(canvas);
  return ringTex;
}

let dotTex: THREE.CanvasTexture | null = null;
/** A soft round sprite for particles. */
export function dotTexture() {
  if (dotTex) return dotTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(canvas);
  return dotTex;
}

let glowTex: THREE.CanvasTexture | null = null;
/** A radial falloff for the floor spotlight. */
export function glowTexture() {
  if (glowTex) return glowTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  glowTex = new THREE.CanvasTexture(canvas);
  return glowTex;
}

let blobTex: THREE.CanvasTexture | null = null;
/** A soft round shadow: the wide penumbra under the cube. */
export function blobTexture() {
  if (blobTex) return blobTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0.75)");
  g.addColorStop(0.45, "rgba(0,0,0,0.35)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  blobTex = new THREE.CanvasTexture(canvas);
  return blobTex;
}

let coreTex: THREE.CanvasTexture | null = null;
/** A blurred rounded square: the tight contact shadow right under the cube, turned with its yaw. */
export function coreShadowTexture() {
  if (coreTex) return coreTex;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = "blur(18px)";
  ctx.fillStyle = "rgba(0,0,0,0.9)";
  ctx.beginPath();
  ctx.roundRect(58, 58, 140, 140, 22);
  ctx.fill();
  coreTex = new THREE.CanvasTexture(canvas);
  return coreTex;
}
