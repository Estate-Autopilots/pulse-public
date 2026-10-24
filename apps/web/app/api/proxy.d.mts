import type { NextRequest } from "next/server";

export interface ApiProxyContext {
  params: Promise<{ path: string[] }>;
}

export interface ApiProxyOptions {
  upstreamPrefix: string;
  methods: string[];
  allowPublicAuthPaths?: boolean;
  legacyV0?: boolean;
  fetchImpl?: typeof fetch;
  /** UX-TENANT: how people sign in at an address (tests inject it; default: app/lib/host-mode.mjs). */
  hostLookup?: (host: string | null) => Promise<{ signIn: "password" | "access"; own: boolean; name: string | null; status: string; rehearsal: boolean }>;
}

export function fileRoute(path: string[]): boolean;
export function ownCsp(path: string[]): boolean;
export function isOperatorPath(upstreamPrefix: string, path: string[]): boolean;
export function createApiProxy(options: ApiProxyOptions): (request: NextRequest, context: ApiProxyContext) => Promise<Response>;
export function v1Area(path: string[]): boolean;
export function v1BearerProxy(request: Request, context: ApiProxyContext, fetchImpl?: typeof fetch): Promise<Response>;
export const v0ProxyOptions: ApiProxyOptions;
export const v1ProxyOptions: ApiProxyOptions;
export const v1FlowProxyOptions: ApiProxyOptions;
