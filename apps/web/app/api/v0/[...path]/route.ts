import { createApiProxy, v0ProxyOptions } from "../../proxy.mjs";

const proxy = createApiProxy(v0ProxyOptions);

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
