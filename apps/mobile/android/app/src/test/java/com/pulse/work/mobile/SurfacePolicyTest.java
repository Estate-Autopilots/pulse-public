package com.pulse.work.mobile;
import static org.junit.Assert.*;
import org.junit.Test;
public class SurfacePolicyTest {
    @Test public void cacheExpiresAndNeverSurvivesRebootOrClockRegression() {
        assertTrue(SurfacePolicy.fresh(4, 4, 1000, 1001));
        assertFalse(SurfacePolicy.fresh(4, 4, 1000, 301000));
        assertFalse(SurfacePolicy.fresh(4, 5, 1000, 1001));
        assertFalse(SurfacePolicy.fresh(4, 4, 1000, 999));
        assertFalse(SurfacePolicy.fresh(4, 4, -1, 1000));
    }
    @Test public void onlyCurrentEnabledStatesOfferSafeConfirmation() {
        assertEquals("check-in", SurfacePolicy.primary("out", true));
        assertEquals("check-in", SurfacePolicy.primary("done", true));
        assertEquals("check-out", SurfacePolicy.primary("in", true));
        assertEquals("check-out", SurfacePolicy.primary("break", true));
        for (String state : new String[]{"out", "in", "break", "holiday", "off", "signed-out", "unknown"})
            assertEquals("open", SurfacePolicy.primary(state, false));
        assertEquals("open", SurfacePolicy.primary("holiday", true));
        assertEquals("open", SurfacePolicy.primary("unknown", true));
    }
    // POLISH-1: time worked as of the last confirmation, and a check-out forgotten yesterday.
    @Test public void workedCountsTheSessionLessBreaksAsOfTheLastConfirmation() {
        long in = 1_000_000_000L, hour = 3_600_000L;
        assertEquals(4 * 3600 + 7 * 60, SurfacePolicy.worked(in, -1, 0, -1, in + 4 * hour + 7 * 60_000));
        assertEquals("a finished break and one still running are not work", 3 * 3600, SurfacePolicy.worked(in, -1, 1800, in + 3 * hour + 1_800_000, in + 4 * hour));
        assertEquals("checked out: the session ends there", 8 * 3600, SurfacePolicy.worked(in, in + 8 * hour, 0, -1, in + 20 * hour));
        assertEquals(0, SurfacePolicy.worked(-1, -1, 0, -1, in));
        assertEquals("35 min", SurfacePolicy.words(35 * 60)); assertEquals("4 h", SurfacePolicy.words(4 * 3600)); assertEquals("4 h 07 min", SurfacePolicy.words(4 * 3600 + 7 * 60));
    }
    @Test public void aSessionOpenSinceYesterdayOrFarPastTheShiftIsForgotten() {
        long in = 1_000_000_000L, hour = 3_600_000L;
        assertTrue(SurfacePolicy.forgotten("2026-10-10", "2026-10-11", "10:00", "19:00", in, in + 10 * hour));
        assertFalse(SurfacePolicy.forgotten("2026-10-11", "2026-10-11", "10:00", "19:00", in, in + 12 * hour));
        assertTrue(SurfacePolicy.forgotten("2026-10-11", "2026-10-11", "10:00", "19:00", in, in + 13 * hour + 60_000));
        assertFalse("a night shift crossing midnight is normal", SurfacePolicy.forgotten("2026-10-10", "2026-10-11", "22:00", "06:00", in, in + 7 * hour));
        assertTrue(SurfacePolicy.forgotten("2026-10-10", "2026-10-11", "22:00", "06:00", in, in + 12 * hour + 60_000));
    }
}
