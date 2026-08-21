// Minimal vitest config: the "@/*" -> "./src/*" alias mirrors tsconfig.json's
// paths mapping, which vitest doesn't read on its own. Needed so that lib
// files under test can transitively import other "@/..." modules (e.g.
// musicbrainz.ts -> "@/lib/db", "@/generated/prisma/client") the same way
// the app code does — every prior *.test.ts avoided this by only importing
// same-directory relative modules.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
