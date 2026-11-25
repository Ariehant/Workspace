/// <reference types="vite/client" />
import type { CalendarApi } from '../preload';

declare global {
  interface Window {
    calendar: CalendarApi;
  }
}
