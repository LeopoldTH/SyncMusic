import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("element #root introuvable");
createRoot(container).render(
  <StrictMode>
    {/* Vraies adresses plutot qu un etat d ecran maison: le retour du navigateur et le
        rafraichissement marchent sans code de notre part. Le serveur rend deja la page
        sur toute adresse inconnue, ce que ce choix exige. */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
