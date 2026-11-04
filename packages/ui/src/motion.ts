/** `smooth`, unless the system asks for reduced motion (then scrolling jumps). */
export function scrollBehavior(): ScrollBehavior {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}
