export * from './types/index';
export * from './utils/index';
export * from './engines/index';

// `extractSize` is defined in BOTH ./utils/strings and ./engines/cleaning as two
// different implementations (the engines version normalizes units and is the one
// the cleaning pipeline uses). Both star-exports above would collide on this name
// (TS2308). Re-export the engines version explicitly so the package root resolves
// to it; the utils version stays reachable via the `@malikas/shared/utils` subpath.
export { extractSize } from './engines/cleaning';
