import type { KeplerkApi } from '../shared/api.ts';

declare global {
  interface Window {
    readonly keplerk: KeplerkApi;
  }
}
