import { fileURLToPath } from 'node:url'
import { includeIgnoreFile } from '@eslint/compat'
import pluginJs from '@eslint/js'
import globals from 'globals'
import pluginTs from 'typescript-eslint'

export default pluginTs.config(
    includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
    includeIgnoreFile(
        fileURLToPath(new URL('.git/info/exclude', import.meta.url))
    ),
    { files: ['**/*.{js,mjs,cjs,ts,tsx,jsx}'] },
    { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
    pluginJs.configs.recommended,
    {
        extends: pluginTs.configs.recommended,
        rules: {
            '@typescript-eslint/array-type': ['warn', { default: 'generic' }],
            // Allow unused vars if prefixed with `_` (https://typescript-eslint.io/rules/no-unused-vars/)
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
        },
    }
)
