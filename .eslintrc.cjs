/**
 * Root ESLint config for the monorepo (ESLint 8, legacy `.eslintrc`).
 *
 * Applies to the plain-TypeScript packages (`apps/workers`, `packages/shared`,
 * `packages/db`) which lint via `eslint src --ext .ts`. The Next.js app
 * (`apps/web`) has its own `.eslintrc.json` (extends `next/core-web-vitals`)
 * and is marked `root`, so it does not inherit this file.
 *
 * Ruleset philosophy: correctness rules stay as errors; stylistic / advisory
 * rules are warnings so they surface without being hidden or blocking CI.
 * Nothing is blanket-disabled.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true,
    browser: true,
  },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/*.d.ts',
  ],
  rules: {
    // TypeScript understands globals/types; the base rule false-positives on TS.
    'no-undef': 'off',
    // Advisory, not blocking — surfaced as warnings.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
};
