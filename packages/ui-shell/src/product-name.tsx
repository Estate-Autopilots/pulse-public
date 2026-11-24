"use client";
import { createContext, useContext } from "react";

/** VITALS-SHIP (24 Nov 2026): the product this address wears, for a page's own words: "Vitals OS" on the platform's
 *  addresses (app.vitalsos.ai), "Pulse" elsewhere. PulseShell provides it from its `product`, so a page says
 *  "Welcome to Vitals OS" where the top bar and the tab title already do (new users saw "Welcome to Pulse"). */
export const ProductNameContext = createContext("Pulse");
export const useProductName = () => useContext(ProductNameContext);
