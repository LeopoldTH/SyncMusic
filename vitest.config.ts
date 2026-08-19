import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    /*
     * Tout tourne sans navigateur, y compris les composants: ils sont rendus en chaine
     * par renderToStaticMarkup. C est ce qui garde la suite sous la seconde, et c est
     * une exigence du plan pour le moteur (R22).
     */
    environment: "node",
    include: ["{shared,server,client}/**/*.test.{ts,tsx}"],
  },
});
