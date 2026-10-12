// --- Zoom ----------------------------------------------------------------------------

/** The zoom levels Zoom In and Zoom Out step through (as in Chromium). */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** A zoom factor from anywhere (a setting, IPC), within the steps' range; 1 if not a number. */
export function clampZoom(factor: unknown): number {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
}

/**
 * The next step in `direction` from `factor`, which needn't be a step itself (it moves to
 * the nearest step that way); the same factor at either end.
 */
export function stepZoom(factor: number, direction: 'in' | 'out'): number {
  const current = clampZoom(factor);
  const epsilon = 0.001;
  if (direction === 'in') return ZOOM_STEPS.find((step) => step > current + epsilon) ?? current;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon) ?? current;
}

/** A zoom factor as people read it: "110%". */
export const formatZoom = (factor: number): string => `${Math.round(factor * 100)}%`;
