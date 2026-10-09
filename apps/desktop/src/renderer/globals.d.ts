import type { OrbitreeApi } from '../shared/api.ts';

declare global {
  interface Window {
    readonly orbitree: OrbitreeApi;
  }
}
