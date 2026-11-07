import type { NextRequest } from "next/server";
import { createApiProxy, v1Area, v1BearerProxy, v1FlowProxyOptions, v1ProxyOptions, type ApiProxyContext } from "../../proxy.mjs";

const person = createApiProxy(v1ProxyOptions);
// FLOW-B: processes, runs and steps are edited from the browser as the signed-in person.
const flow = createApiProxy(v1FlowProxyOptions);
// EST-1611: API v1 operations and their reference take a bearer key only; the claim routes keep the person proxy.
const proxy = async (request: NextRequest, context: ApiProxyContext) => {
  const path = (await context.params).path;
  return v1Area(path) ? v1BearerProxy(request, context) : path[0] === "flow" ? flow(request, context) : person(request, context);
};
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
