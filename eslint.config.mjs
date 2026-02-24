import * as effectEslint from "@effect/eslint-plugin"
import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default [
  { ignores: ["**/dist", "**/node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...effectEslint.configs.dprint,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "@effect/dprint": [
        "error",
        {
          config: {
            indentWidth: 2,
            lineWidth: 120,
            semiColons: "asi",
            quoteStyle: "alwaysDouble",
            trailingCommas: "onlyMultiLine",
            operatorPosition: "maintain",
            "arrowFunction.useParentheses": "force"
          }
        }
      ]
    }
  }
]
