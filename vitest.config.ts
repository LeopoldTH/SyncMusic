import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Le moteur de synchronisation doit tourner sans navigateur (R22): l'environnement
    // par defaut est donc node, et jsdom n'est charge que pour les tests de composants.
    environment: "node",
    environmentMatchGlobs: [["client/components/**", "jsdom"]],
    include: ["{shared,server,client}/**/*.test.{ts,tsx}"],
  },
});
