/**
 * How an image block shows its image: a crop and a rotation, kept as display settings (the
 * stored file doesn't change). The crop is a rectangle in fractions of the original image
 * (before rotating); the rotation is clockwise, in quarter turns.
 */

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** The smallest crop side, as a fraction of the image. */
export const MIN_CROP = 0.02;

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A crop kept inside the image and at least `MIN_CROP` on each side. */
export function clampCrop(rect: CropRect): CropRect {
  const w = clamp(rect.w, MIN_CROP, 1);
  const h = clamp(rect.h, MIN_CROP, 1);
  return { x: clamp(rect.x, 0, 1 - w), y: clamp(rect.y, 0, 1 - h), w, h };
}

export const isFullCrop = (rect: CropRect) =>
  rect.x <= 0.0001 && rect.y <= 0.0001 && rect.w >= 0.9999 && rect.h >= 0.9999;

/** The attribute's form: `"x y w h"`. */
export function formatCrop(rect: CropRect): string | null {
  const c = clampCrop(rect);
  return isFullCrop(c) ? null : [c.x, c.y, c.w, c.h].map(round).join(' ');
}

export function parseCrop(value: unknown): CropRect | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return clampCrop({ x, y, w, h });
}

export function parseRotation(value: unknown): Rotation {
  const n = (((Math.round(Number(value) / 90) * 90) % 360) + 360) % 360;
  return (Number.isFinite(n) ? n : 0) as Rotation;
}

export const turn = (rotation: Rotation, by: 90 | -90): Rotation => parseRotation(rotation + by);

const sideways = (rotation: Rotation) => rotation === 90 || rotation === 270;

/**
 * A crop of the original image as seen in the rotated image, both in fractions of their own
 * image (the crop dialog shows the image turned and draws the crop on it).
 */
export function toRotated(rect: CropRect, rotation: Rotation): CropRect {
  const { x, y, w, h } = rect;
  switch (rotation) {
    case 90:
      return { x: 1 - y - h, y: x, w: h, h: w };
    case 180:
      return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 270:
      return { x: y, y: 1 - x - w, w: h, h: w };
    default:
      return { ...rect };
  }
}

/** The reverse of `toRotated`. */
export function fromRotated(rect: CropRect, rotation: Rotation): CropRect {
  const back: Record<Rotation, Rotation> = { 0: 0, 90: 270, 180: 180, 270: 90 };
  return toRotated(rect, back[rotation]);
}

/** Width over height of what's shown: the crop, turned. */
export function shownAspect(
  rect: CropRect,
  rotation: Rotation,
  naturalWidth: number,
  naturalHeight: number,
): number {
  const w = rect.w * naturalWidth;
  const h = rect.h * naturalHeight;
  return sideways(rotation) ? h / w : w / h;
}

export interface ImageViewStyles {
  /** The frame: the shown aspect, clipping the rest. */
  frame: Record<string, string>;
  /** The crop, turned about its centre. */
  turned: Record<string, string>;
  /** The whole image, placed so the crop fills its box. */
  image: Record<string, string>;
}

const pct = (n: number) => `${round(n * 100)}%`;

/**
 * Inline styles that show a crop and rotation with nothing but CSS (no need to load the image
 * first): the editor, published pages and HTML / PDF exports use the same ones. `aspect` is
 * `shownAspect` of the crop, kept with the block.
 */
export function imageViewStyles(
  rect: CropRect,
  rotation: Rotation,
  aspect: number,
): ImageViewStyles {
  const turnedSize = sideways(rotation)
    ? // The crop box before turning is the frame's height wide and its width high.
      { width: pct(1 / aspect), height: pct(aspect) }
    : { width: '100%', height: '100%' };
  return {
    frame: {
      position: 'relative',
      overflow: 'hidden',
      width: '100%',
      'aspect-ratio': String(round(aspect)),
    },
    turned: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      overflow: 'hidden',
      ...turnedSize,
      transform: `translate(-50%, -50%)${rotation ? ` rotate(${rotation}deg)` : ''}`,
    },
    image: {
      position: 'absolute',
      'max-width': 'none',
      width: pct(1 / rect.w),
      height: pct(1 / rect.h),
      left: pct(-rect.x / rect.w),
      top: pct(-rect.y / rect.h),
    },
  };
}

/** The styles as a `style` attribute. */
export const cssText = (style: Record<string, string>) =>
  Object.entries(style)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');

/** A side or corner of the crop frame being dragged. */
export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The crop moved by `dx`, `dy` (fractions), staying inside the image. */
export const moveCrop = (rect: CropRect, dx: number, dy: number): CropRect =>
  clampCrop({ ...rect, x: rect.x + dx, y: rect.y + dy });

/**
 * The crop with a side or corner dragged by `dx`, `dy` (fractions of the image). With a
 * `ratio` (width over height, in fractions) the frame keeps that shape, anchored at the
 * opposite side or corner.
 */
export function resizeCrop(
  rect: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null = null,
): CropRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  if (!ratio) return { x: left, y: top, w: right - left, h: bottom - top };

  // Keep the shape: the dragged width decides (the height for top and bottom sides), then
  // both shrink to fit inside the image.
  const horizontal = handle.includes('e') || handle.includes('w');
  let w = horizontal ? right - left : (bottom - top) * ratio;
  let h = w / ratio;
  const anchorTop = !handle.includes('n');
  const anchorLeft = !handle.includes('w');
  const centreX = rect.x + rect.w / 2;
  const centreY = rect.y + rect.h / 2;
  const roomW = horizontal ? (anchorLeft ? 1 - left : right) : 2 * Math.min(centreX, 1 - centreX);
  const roomH =
    handle === 'e' || handle === 'w'
      ? 2 * Math.min(centreY, 1 - centreY)
      : anchorTop
        ? 1 - top
        : bottom;
  const scale = Math.min(1, roomW / w, roomH / h);
  w *= scale;
  h *= scale;
  const x = horizontal ? (anchorLeft ? left : right - w) : centreX - w / 2;
  const y = handle === 'e' || handle === 'w' ? centreY - h / 2 : anchorTop ? top : bottom - h;
  return clampCrop({ x, y, w, h });
}

/** The largest crop of this shape centred on `rect`'s centre (for picking a shape). */
export function fitCrop(rect: CropRect, ratio: number): CropRect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = Math.min(1, ratio);
  let h = w / ratio;
  if (h > 1) {
    h = 1;
    w = ratio;
  }
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
}
