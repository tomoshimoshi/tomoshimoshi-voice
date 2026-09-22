import parser from "@typescript-eslint/parser";
import plugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";
export default [
  { ignores: ["node_modules/**", ".callori/**"] },
  { files: ["**/*.ts"], languageOptions: { parser, globals: globals.node },
    plugins: { "@typescript-eslint": plugin }, rules: plugin.configs.recommended.rules },
  { files: ["tests/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];
