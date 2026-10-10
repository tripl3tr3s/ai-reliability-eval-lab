import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

// Core directories hold domain-free code. They must not reach into the Mexican fiscal domain pack
// (fixtures, synthetic tools, efos-risk-graph) or into the experiment loop that wires it in.
// See docs/architecture.md.
const domainPack = {
  group: ['**/fixtures.js', '**/tools.js', '**/experiment.js', '**/mock/**', 'efos-risk-graph', 'efos-risk-graph/*'],
  message: 'Core code must stay independent of the fiscal domain pack. See docs/architecture.md.',
}

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**', 'coverage/**', 'reports/**', 'site/**'] },
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  },
  {
    files: ['src/gate/**/*.ts', 'src/monitor/**/*.ts', 'src/providers/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [domainPack] }] }
  },
  {
    // Statistics and the audit log are leaf libraries: they import nothing from the rest of the project.
    files: ['src/stats/**/*.ts', 'src/audit/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [domainPack, { group: ['../*'], message: 'This directory is a leaf library and must not import from other project modules.' }]
      }]
    }
  }
)
