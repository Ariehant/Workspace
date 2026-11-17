import { describe, expect, it } from 'vitest';
import {
  FULL_CROP,
  fitCrop,
  formatCrop,
  fromRotated,
  imageViewStyles,
  moveCrop,
  parseCrop,
  parseRotation,
  resizeCrop,
  shownAspect,
  toRotated,
  turn,
  type CropRect,
  type Rotation,
} from './image-view';

const rect: CropRect = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };

describe('image view', () => {
  it('stores a crop as text, and the whole image as none', () => {
    expect(formatCrop(rect)).toBe('0.1 0.2 0.5 0.3');
    expect(parseCrop('0.1 0.2 0.5 0.3')).toEqual(rect);
    expect(formatCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    // Kept inside the image.
    expect(parseCrop('0.9 -1 0.5 2')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(parseCrop('nonsense')).toBeNull();
    expect(parseCrop(null)).toBeNull();
  });

  it('turns in quarter turns', () => {
    expect(parseRotation(450)).toBe(90);
    expect(parseRotation(-90)).toBe(270);
    expect(parseRotation('x')).toBe(0);
    expect(turn(0, -90)).toBe(270);
    expect(turn(270, 90)).toBe(0);
  });

  it('maps a crop to the turned image and back', () => {
    // The top-left corner of the image goes to the top right when turned clockwise.
    expect(toRotated({ x: 0, y: 0, w: 0.25, h: 0.5 }, 90)).toEqual({
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 0.25,
    });
    expect(toRotated({ x: 0, y: 0, w: 0.25, h: 0.5 }, 270)).toEqual({
      x: 0,
      y: 0.75,
      w: 0.5,
      h: 0.25,
    });
    expect(toRotated({ x: 0, y: 0, w: 0.25, h: 0.5 }, 180)).toEqual({
      x: 0.75,
      y: 0.5,
      w: 0.25,
      h: 0.5,
    });
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      const back = fromRotated(toRotated(rect, r), r);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(rect[k]);
    }
  });

  it('works out the shown aspect and the styles', () => {
    // A 1000×500 image, cropped to its left half (500×500), turned: square.
    const half = { x: 0, y: 0, w: 0.5, h: 1 };
    expect(shownAspect(half, 0, 1000, 500)).toBe(1);
    expect(shownAspect(rect, 90, 1000, 500)).toBeCloseTo(150 / 500);
    const styles = imageViewStyles(rect, 0, 500 / 150);
    expect(styles.image).toMatchObject({ width: '200%', left: '-20%', top: '-66.6667%' });
    expect(styles.turned).toMatchObject({ width: '100%', height: '100%' });
    // Turned sideways, the crop's box swaps its sides.
    const sideways = imageViewStyles(rect, 90, 0.3);
    expect(sideways.turned).toMatchObject({
      width: '333.3333%',
      height: '30%',
      transform: 'translate(-50%, -50%) rotate(90deg)',
    });
  });
});

const r4 = (c: CropRect) => ({
  x: Math.round(c.x * 1e4) / 1e4,
  y: Math.round(c.y * 1e4) / 1e4,
  w: Math.round(c.w * 1e4) / 1e4,
  h: Math.round(c.h * 1e4) / 1e4,
});

describe('dragging the crop frame', () => {
  const start: CropRect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  it('moves inside the image', () => {
    expect(r4(moveCrop(start, 0.1, -0.1))).toEqual({ x: 0.3, y: 0.1, w: 0.4, h: 0.4 });
    expect(r4(moveCrop(start, 1, 1))).toEqual({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
  });

  it('resizes from a side or corner, not past the image or the other side', () => {
    expect(resizeCrop(start, 'e', 0.1, 0)).toMatchObject({ x: 0.2, w: 0.5 });
    expect(r4(resizeCrop(start, 'nw', -0.5, -0.5))).toEqual({ x: 0, y: 0, w: 0.6, h: 0.6 });
    expect(resizeCrop(start, 'w', 0.9, 0).w).toBeCloseTo(0.02);
  });

  it('keeps a shape', () => {
    const square = resizeCrop(start, 'se', 0.2, 0, 1);
    expect(square.w).toBeCloseTo(0.6);
    expect(square.h).toBeCloseTo(0.6);
    expect(square).toMatchObject({ x: 0.2, y: 0.2 });
    // Too big to fit: shrinks to the room there is.
    const big = resizeCrop(start, 'se', 0.9, 0, 1);
    expect(big.w).toBeCloseTo(0.8);
    expect(big.h).toBeCloseTo(0.8);
    expect(fitCrop(FULL_CROP, 2)).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
    expect(fitCrop(FULL_CROP, 0.5)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
  });
});
