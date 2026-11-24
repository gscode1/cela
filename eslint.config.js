import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The desktop image's helpers are dependency-free scripts run by the image's Node, outside every tsconfig; tests cover them
  // (packages/orchestrator/test/desktop-*.test.ts).
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/vendor/**",
      ".claude/**",
      "images/sandbox-desktop/files/**",
      "images/sandbox-desktop/test-pages/**", // pages for the desktop-web suite: browser scripts
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Node scripts that are not TypeScript: the MCP release smoke test.
    files: ["packages/mcp/scripts/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    // Node scripts that are not TypeScript: the browser suite's local server.
    files: ["packages/admin-ui/e2e/*.mjs"],
    languageOptions: { globals: { process: "readonly", URL: "readonly" } },
  },
);
