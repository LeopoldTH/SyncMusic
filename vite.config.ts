import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuration de build du client uniquement. Les tests ont leur propre fichier:
// melanger les deux fait resoudre la racine de vitest par rapport a `root` ci-dessous,
// et la suite part chercher ses fichiers en dehors du projet.
export default defineConfig({
  root: "client",
  plugins: [react()],
  server: { port: 5173 },
});
