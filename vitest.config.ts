import { configDefaults, defineConfig } from "vitest/config";

// Skill ECC berisi file contoh *.test.mjs yang bukan suite vitest —
// jangan sampai runner ikut menjalankannya. Skill tetap dibaca loader
// (tests/skills.test.ts), bukan oleh runner.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "skills/**"],
  },
});
