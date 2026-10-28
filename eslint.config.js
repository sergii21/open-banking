// @ts-check
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typeAware = {
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
};

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.angular/**',
    '**/node_modules/**',
    '**/coverage/**',
    'playwright-report/**',
    'test-results/**',
    'e2e/.auth/**',
    'apps/api/test/fixtures/**',
    'docs/**',
  ]),

  // ---------------------------------------------------------------- TypeScript (all workspaces)
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
    ...typeAware,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // Value-only imports for runtime code outside Angular (DI tokens in Angular rely on value imports).
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
    },
  },

  // ---------------------------------------------------------------- Angular components, services
  {
    files: ['apps/web/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'll', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'll', style: 'camelCase' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@angular-eslint/prefer-inject': 'error',
      '@angular-eslint/prefer-signals': 'error',
      '@angular-eslint/prefer-service-decorator': 'error',
      '@angular-eslint/prefer-host-metadata-property': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Decorator[expression.callee.name='Component'] Property[key.name='changeDetection']",
          message: 'OnPush is the default in Angular 22. Do not set changeDetection.',
        },
        {
          selector:
            "Decorator[expression.callee.name=/^(Component|Directive|Pipe)$/] Property[key.name='standalone']",
          message: 'standalone is the default. Do not set it.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@angular/common',
              importNames: ['CommonModule', 'NgClass', 'NgStyle', 'NgIf', 'NgFor', 'NgSwitch'],
              message: 'Use class/style bindings and built-in control flow.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------- Angular templates
  {
    files: ['apps/web/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/prefer-class-binding': 'error',
      '@angular-eslint/template/prefer-style-binding': 'error',
      '@angular-eslint/template/prefer-ngsrc': 'error',
      '@angular-eslint/template/button-has-type': 'error',
    },
  },

  // ---------------------------------------------------------------- Node runtime and tooling
  {
    files: ['apps/api/**/*.ts', 'e2e/**/*.ts', 'playwright.config.ts', 'packages/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    // Playwright specs: `page.evaluate` bodies and test helpers use a few dynamic APIs.
    files: ['e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // ---------------------------------------------------------------- Tests
  {
    files: ['**/*.spec.ts', '**/*.test.ts', 'apps/api/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },
);
