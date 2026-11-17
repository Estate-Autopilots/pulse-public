"use client";
import { useSyncExternalStore } from "react";
import { shell } from "./lib/native-shell";

const never = () => () => {};
/** True inside the Pulse phone app; false in a browser and while the server renders. */
export function useInShell() {
  return useSyncExternalStore(never, () => !!shell(), () => false);
}
