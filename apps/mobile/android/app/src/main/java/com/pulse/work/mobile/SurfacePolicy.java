package com.pulse.work.mobile;

import java.util.Locale;

/** Minimal presentation policy. Never projects attendance or runs an independent work timer. */
final class SurfacePolicy {
    static final long FRESH_MS = 5 * 60_000;
    /** POLISH-1: hours past a shift's length after which an open session is a forgotten check-out (as the web chip). */
    static final int FORGOTTEN_AFTER_HOURS = 4;
    static boolean fresh(long savedBoot, long boot, long savedElapsed, long elapsed) {
        return savedBoot == boot && savedElapsed >= 0 && elapsed >= savedElapsed && elapsed - savedElapsed < FRESH_MS;
    }
    static String primary(String state, boolean enabled) {
        if (!enabled) return "open";
        if ("in".equals(state) || "break".equals(state)) return "check-out";
        if ("out".equals(state) || "done".equals(state)) return "check-in";
        return "open";
    }
    static String title(String state) {
        switch (state) {
            case "in": return "Checked in";
            case "break": return "On a break";
            case "done": return "Checked out";
            case "out": return "Not checked in";
            default: return "Open My desk";
        }
    }

    /**
     * Seconds worked by `at` (the last confirmed read, never "now"): from check-in to check-out or `at`, less finished
     * breaks and a break still running. Times in milliseconds; 0 or less means absent.
     */
    static long worked(long in, long out, long closedBreakSeconds, long breakStarted, long at) {
        if (in <= 0) return 0;
        long end = out > 0 ? out : at;
        long running = out <= 0 && breakStarted > 0 ? Math.max(0, end - breakStarted) : 0;
        return Math.max(0, (end - in - running) / 1000 - Math.max(0, closedBreakSeconds));
    }
    /** "35 min", "4 h", "4 h 07 min". */
    static String words(long seconds) {
        long m = Math.max(0, Math.round(seconds / 60.0));
        return m < 60 ? m + " min" : (m / 60) + " h" + (m % 60 != 0 ? String.format(Locale.US, " %02d min", m % 60) : "");
    }
    /** "HH:MM" as minutes of the day, or -1. */
    static int minutes(String hhmm) {
        if (hhmm == null || !hhmm.matches("\\d{1,2}:\\d{2}.*")) return -1;
        String[] p = hhmm.split(":");
        return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1].substring(0, 2));
    }
    /**
     * POLISH-1: a check-out forgotten yesterday. True when an open session began on an earlier day and the shift does
     * not run overnight, or it has run longer than the shift plus {@link #FORGOTTEN_AFTER_HOURS}. Such a session is not
     * offered a widget check-out (that would record now); the app asks for the right time instead.
     */
    static boolean forgotten(String entryDate, String today, String shiftStart, String shiftEnd, long in, long at) {
        if (in <= 0) return false;
        int start = minutes(shiftStart), end = minutes(shiftEnd);
        boolean overnight = start >= 0 && end >= 0 && end <= start;
        int length = start >= 0 && end >= 0 ? ((end - start + 1440) % 1440 == 0 ? 1440 : (end - start + 1440) % 1440) : 9 * 60;
        boolean earlierDay = entryDate != null && today != null && !entryDate.isEmpty() && !today.isEmpty() && entryDate.compareTo(today) < 0;
        boolean tooLong = at - in > (length + FORGOTTEN_AFTER_HOURS * 60L) * 60_000L;
        return (earlierDay && !overnight) || tooLong;
    }
}
