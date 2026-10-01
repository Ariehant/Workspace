import type { DesktopApi } from '../src/preload';

declare global {
  interface Window {
    workspace: DesktopApi;
  }
}
