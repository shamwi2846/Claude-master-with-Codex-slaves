// ESLint, run by CI only (the setup itself has no npm dependencies). Only rules that catch real mistakes:
// undefined or misspelled names, unused code, unreachable code, duplicate keys, always-true/false tests.
// No style rules. ES built-ins come from ecmaVersion; Node's own globals are listed here.
const node = Object.fromEntries([
  'require', 'module', 'exports', 'process', '__dirname', '__filename', 'console', 'Buffer', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone', 'fetch',
].map(n => [n, 'readonly']));

export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: node },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-dupe-else-if': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'no-redeclare': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-constant-binary-expression': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-loss-of-precision': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'getter-return': 'error',
    },
  },
];
