// The current API branch predates the organization flag. Browser-render tests that verify
// enabled attendance opt in explicitly here; direct app.inject API assertions remain untouched.
const ENABLED_WEB_PATH = /^\/api\/v0\/(?:hr\/(?:self|desk|attendance|person\/[^/?]+)|me\/hr|home|insights|people(?:\/[^/?]+)?|performance|companion)(?:\?|$)/;

export function enableAttendanceForWebFixture(app) {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.headers["user-agent"] !== "node" || reply.statusCode >= 400 || !ENABLED_WEB_PATH.test(request.url)) return payload;
    try {
      const data = JSON.parse(String(payload));
      if (data && typeof data === "object" && !Array.isArray(data)) return JSON.stringify({ ...data, attendanceEnabled: true });
    } catch {}
    return payload;
  });
}
