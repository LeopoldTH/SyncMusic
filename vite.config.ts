import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Configuration de build du client uniquement. Les tests ont leur propre fichier:
// melanger les deux fait resoudre la racine de vitest par rapport a `root` ci-dessous,
// et la suite part chercher ses fichiers en dehors du projet.
export default defineConfig({
  root: "client",
  plugins: [react()],
  // Sortie a la racine du projet: c est le serveur qui la sert, pas Vite.
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    // En developpement le client et le serveur vivent sur deux ports. Le renvoi evite
    // de coder une adresse en dur, ce que U10 interdit.
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true } },
  },
});
