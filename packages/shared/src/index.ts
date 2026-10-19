/**
 * The public surface of `@hexpayroll/shared`.
 *
 * Everything the API, the web app and the desktop shell is allowed to import is
 * re-exported here, so a consumer never reaches into an individual module path.
 *
 * The `.js` extensions are deliberate and must not be "tidied away": this
 * package is ESM (`"type": "module"`) and is compiled with
 * `moduleResolution: NodeNext`, which expects the specifier to name the file as
 * it will exist after compilation. `./money.js` therefore refers to
 * `src/money.ts` in source and to `dist/money.js` in the published build —
 * TypeScript performs that mapping, Node does not.
 */
export * from './money.js';
export * from './primitives.js';
export * from './health.js';
export * from './auth.js';
export * from './foundation.js';
export * from './timekeeping.js';
export * from './payroll.js';
export * from './sync.js';
export * from './conflicts.js';
