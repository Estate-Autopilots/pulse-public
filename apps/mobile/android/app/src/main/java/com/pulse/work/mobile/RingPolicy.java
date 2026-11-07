package com.pulse.work.mobile;

/** CALLS-NATIVE: the pure rules of a ring (unit-tested in RingPolicyTest): which ids, which page, how long. */
final class RingPolicy {

    /** Pulse stops a ring after 45 seconds; a push never makes a phone ring longer. */
    static final long MAX_RING_MS = 45_000;

    private RingPolicy() {}

    static boolean validId(String id) {
        return id != null && id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }

    /** The page a ring opens: the call in its conversation (the page answers it), or the ringing check for a test. */
    static String href(String href, String call, boolean test) {
        if (test) return "/settings?tab=devices&ringtest=" + call;
        if (href != null && href.startsWith("/chats?") && !href.contains("//") && href.contains("call=" + call)) return href;
        return "/chats";
    }

    /** The page Answer opens: the call, answered (answer=1). */
    static String answerHref(String href) {
        if (href == null || !href.startsWith("/chats?")) return href;
        return href.contains("answer=1") ? href : href + "&answer=1";
    }

    /** Until when this ring may ring, from the push's expiresAt (ISO, UTC), never beyond 45 s from now. */
    static long until(String expiresAt, long now) {
        long cap = now + MAX_RING_MS;
        if (expiresAt == null || expiresAt.isEmpty()) return cap;
        String s = expiresAt.replaceAll("\\.(\\d{3})\\d+", ".$1");
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX" }) {
            try {
                java.text.SimpleDateFormat f = new java.text.SimpleDateFormat(pattern, java.util.Locale.US);
                f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
                f.setLenient(false);
                return Math.min(cap, f.parse(s).getTime());
            } catch (Exception ignored) {
                // Try the next form.
            }
        }
        return cap;
    }
}
