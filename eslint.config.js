// ESLint flat config: TypeScript + security linting + the AGENTS.md naming rule.
import eslintJs from "@eslint/js";
import securityPlugin from "eslint-plugin-security";
import globalsCatalog from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", ".venv/", "public/"] },
  eslintJs.configs.recommended,
  ...tseslint.configs.recommended,
  securityPlugin.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      globals: { ...globalsCatalog.browser, ...globalsCatalog.worker },
    },
    rules: {
      // AGENTS.md: identifiers are at least 8 characters (object keys follow external formats).
      "id-length": ["error", { min: 8, properties: "never", exceptions: ["earcut", "_", "NaN"] }],
      // AGENTS.md: no dynamic code execution.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      // AGENTS.md: never render untrusted content as HTML.
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Use textContent or DOM nodes instead." },
        { property: "outerHTML", message: "Use textContent or DOM nodes instead." },
        { property: "insertAdjacentHTML", message: "Use DOM nodes instead." },
        { object: "document", property: "write", message: "Use DOM nodes instead." },
      ],
      // Indexed array access with numeric loop variables is not user-controlled here;
      // the rule only produces false positives on typed-array math.
      "security/detect-object-injection": "off",
    },
  }
);
