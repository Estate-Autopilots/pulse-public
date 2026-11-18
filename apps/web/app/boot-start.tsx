import { headers } from "next/headers";
import { BOOT_SHIM } from "./lib/boot.mjs";

/** SPEED-NET: the shell's start-up reads in one call, started by the first HTML before the app's code arrives
 *  (lib/boot.mjs). Placed after TabBoot, so the call carries this tab's company. Carries the request's CSP nonce like
 *  the e-mail guard (email-guard.tsx). */
export async function BootStart({ keys, rail }: { keys: string[]; rail: boolean }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <script id="pulse-boot" nonce={nonce} data-keys={JSON.stringify(keys)} data-rail={rail ? "1" : undefined} suppressHydrationWarning
    dangerouslySetInnerHTML={{ __html: BOOT_SHIM }} />;
}
