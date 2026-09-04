// One job: catch identifiers that resolve to nothing — the class of bug the
// test suite structurally cannot see (a missed import only explodes when the
// click handler runs). Style stays out of scope on purpose.
import globals from "globals";

export default [
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
    rules: { "no-undef": "error" },
  },
  {
    files: ["server/**/*.js", "scripts/**/*.mjs", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error" },
  },
];
