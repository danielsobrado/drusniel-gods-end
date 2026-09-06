// Deliberately minimal. The value here is dead-code and typo detection, not
// style enforcement -- reformatting 5,200 lines would make every subsequent
// visual-parity review unreadable. Formatting is left to .editorconfig.
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        HTMLElement: 'readonly',
        Element: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        AudioContext: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    // .history/ is the IDE's local-history snapshots (often mid-keystroke and
    // unparseable) and .tmp-* are throwaway debugging scratch files. Neither is
    // source, and linting them only produces noise that masks real findings.
    ignores: ['dist/', 'node_modules/', 'public/', '.history/', '.tmp-*'],
  },
];
