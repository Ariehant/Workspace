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
  type CropHandle,
  type CropRect,
  type Rotation,
} from '@workspace/core';
import { Button, Dialog, DialogContent, IconButton, cn } from '@workspace/ui';
import { RotateCcw, RotateCw } from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';

/** The `style` objects from core, for React. */
const css = (style: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(style).map(([k, v]) => [
      k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  ) as CSSProperties;

/** The image as the block shows it: cropped and turned (or whole). */
export function CroppedImage({
  src,
  alt,
  attrs,
}: {
  src: string;
  alt: string;
  attrs: Record<string, unknown>;
}) {
  const crop = parseCrop(attrs.crop);
  const rotation = parseRotation(attrs.rotate);
  const aspect = Number(attrs.aspect);
  if ((!crop && !rotation) || !(aspect > 0)) {
    return <img src={src} alt={alt} draggable={false} data-drag-handle />;
  }
  const styles = imageViewStyles(crop ?? FULL_CROP, rotation, aspect);
  return (
    <div
      className="ws-image-cropped"
      style={css(styles.frame)}
      data-drag-handle
      data-testid="cropped-image"
    >
      <div style={css(styles.turned)}>
        <img src={src} alt={alt} draggable={false} style={css(styles.image)} />
      </div>
    </div>
  );
}

const SHAPES: { label: string; ratio: number | 'original' | null }[] = [
  { label: 'Free', ratio: null },
  { label: 'Original', ratio: 'original' },
  { label: 'Square', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '3:4', ratio: 3 / 4 },
];

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_NAMES: Record<CropHandle, string> = {
  n: 'top',
  s: 'bottom',
  e: 'right',
  w: 'left',
  ne: 'top right',
  nw: 'top left',
  se: 'bottom right',
  sw: 'bottom left',
};
const STAGE_W = 520;
const STAGE_H = 340;

export interface ImageCropResult {
  crop: string | null;
  rotate: number | null;
  aspect: number | null;
}

/**
 * Crop and turn an image: the turned image with a frame to drag (or move with the arrow keys;
 * Shift resizes), shapes to keep, and quarter turns. Nothing changes until Apply.
 */
export function ImageCropDialog({
  src,
  attrs,
  onApply,
  onClose,
}: {
  src: string;
  attrs: Record<string, unknown>;
  onApply(result: ImageCropResult): void;
  onClose(): void;
}) {
  const [rotation, setRotation] = useState<Rotation>(parseRotation(attrs.rotate));
  // The crop as seen on the turned image.
  const [rect, setRect] = useState<CropRect>(() =>
    toRotated(parseCrop(attrs.crop) ?? FULL_CROP, parseRotation(attrs.rotate)),
  );
  const [shape, setShape] = useState<number | 'original' | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  // The turned image's width over height, and the stage size that fits it.
  const fullAspect = natural ? shownAspect(FULL_CROP, rotation, natural.w, natural.h) : 1;
  const size =
    fullAspect > STAGE_W / STAGE_H
      ? { width: STAGE_W, height: STAGE_W / fullAspect }
      : { width: STAGE_H * fullAspect, height: STAGE_H };
  /** A shape (pixels, width over height) as a ratio of fractions of the turned image. */
  const fractionRatio = (s: number | 'original' | null) =>
    s === null ? null : (s === 'original' ? fullAspect : s) / fullAspect;

  const pickShape = (s: number | 'original' | null) => {
    setShape(s);
    const ratio = fractionRatio(s);
    if (ratio) setRect((r) => fitCrop(r, ratio));
  };

  const rotate = (by: 90 | -90) => {
    // The frame turns with the image.
    const original = fromRotated(rect, rotation);
    const next = turn(rotation, by);
    setRotation(next);
    setRect(toRotated(original, next));
    setShape(null);
  };

  const drag = (mode: CropHandle | 'move') => (down: React.PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const start = rect;
    const ratio = fractionRatio(shape);
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - down.clientX) / box.width;
      const dy = (e.clientY - down.clientY) / box.height;
      setRect(mode === 'move' ? moveCrop(start, dx, dy) : resizeCrop(start, mode, dx, dy, ratio));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.altKey ? 0.002 : 0.01;
    const d = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[e.key];
    if (!d) return;
    e.preventDefault();
    const [dx, dy] = d as [number, number];
    // Shift: the bottom-right corner moves (the frame grows or shrinks).
    setRect((r) =>
      e.shiftKey ? resizeCrop(r, 'se', dx, dy, fractionRatio(shape)) : moveCrop(r, dx, dy),
    );
  };

  const apply = () => {
    if (!natural) return;
    const original = fromRotated(rect, rotation);
    const crop = formatCrop(original);
    const parsed = parseCrop(crop) ?? FULL_CROP;
    onApply({
      crop,
      rotate: rotation || null,
      aspect:
        crop || rotation
          ? Math.round(shownAspect(parsed, rotation, natural.w, natural.h) * 10_000) / 10_000
          : null,
    });
  };

  const whole = imageViewStyles(FULL_CROP, rotation, fullAspect);
  const pct = (n: number) => `${n * 100}%`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Crop image"
        className="top-[8vh] w-[min(600px,calc(100vw-32px))]"
        data-testid="image-crop-dialog"
      >
        <div className="flex flex-col gap-3 p-4 pt-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Shape">
            {SHAPES.map((s) => (
              <Button
                key={s.label}
                aria-pressed={shape === s.ratio}
                className={cn('h-7 px-2 text-xs', shape === s.ratio && 'bg-hover text-fg')}
                onClick={() => pickShape(s.ratio)}
              >
                {s.label}
              </Button>
            ))}
            <span className="flex-1" />
            <IconButton label="Rotate left" onClick={() => rotate(-90)}>
              <RotateCcw size={16} />
            </IconButton>
            <IconButton label="Rotate right" onClick={() => rotate(90)}>
              <RotateCw size={16} />
            </IconButton>
          </div>
          <div className="flex justify-center rounded-md bg-black/5 p-2">
            <div
              ref={stage}
              className="relative touch-none select-none"
              style={{ width: size.width, height: size.height }}
              data-testid="crop-stage"
              data-rotation={rotation}
            >
              <div style={{ ...css(whole.frame), height: '100%' }}>
                <div style={css(whole.turned)}>
                  <img
                    src={src}
                    alt=""
                    draggable={false}
                    style={css(whole.image)}
                    onLoad={(e) =>
                      setNatural({
                        w: e.currentTarget.naturalWidth || 1,
                        h: e.currentTarget.naturalHeight || 1,
                      })
                    }
                  />
                </div>
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Crop area (arrow keys move it, Shift with arrow keys resizes it)"
                aria-valuetext={`${Math.round(rect.w * 100)}% by ${Math.round(rect.h * 100)}%, at ${Math.round(rect.x * 100)}%, ${Math.round(rect.y * 100)}%`}
                aria-valuenow={Math.round(rect.w * 100)}
                data-testid="crop-frame"
                data-rect={[rect.x, rect.y, rect.w, rect.h].map((n) => n.toFixed(4)).join(' ')}
                className="absolute cursor-move outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{
                  left: pct(rect.x),
                  top: pct(rect.y),
                  width: pct(rect.w),
                  height: pct(rect.h),
                  boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.5)',
                  border: '1px solid white',
                }}
                onPointerDown={drag('move')}
                onKeyDown={onKeyDown}
              >
                {HANDLES.map((h) => (
                  <span
                    key={h}
                    aria-hidden
                    data-handle={h}
                    title={`Drag the ${HANDLE_NAMES[h]} edge`}
                    onPointerDown={drag(h)}
                    className="absolute size-3 rounded-sm border border-black/40 bg-white"
                    style={{
                      left: h.includes('w')
                        ? -6
                        : h.includes('e')
                          ? 'calc(100% - 6px)'
                          : 'calc(50% - 6px)',
                      top: h.includes('n')
                        ? -6
                        : h.includes('s')
                          ? 'calc(100% - 6px)'
                          : 'calc(50% - 6px)',
                      cursor: `${h}-resize`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setRect(FULL_CROP);
                setRotation(0);
                setShape(null);
              }}
            >
              Reset
            </Button>
            <span className="flex-1" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!natural} onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
