import { expect } from 'vitest';
import { configureAxe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';

expect.extend(matchers);

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}

// jsdom computes no colors or layout, so color-contrast is off here; contrast was verified separately from computed values.
export const axe = configureAxe({
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
  rules: { 'color-contrast': { enabled: false } },
});
