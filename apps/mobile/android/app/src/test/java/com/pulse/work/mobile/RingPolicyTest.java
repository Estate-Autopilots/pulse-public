package com.pulse.work.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RingPolicyTest {

    private static final String CALL = "0f8fad5b-d9cb-469f-a165-70867728950e";

    @Test
    public void onlyCallIdsRing() {
        assertTrue(RingPolicy.validId(CALL));
        assertFalse(RingPolicy.validId("../calls"));
        assertFalse(RingPolicy.validId(null));
    }

    @Test
    public void aRingOpensItsOwnCallOrTheCheck() {
        assertEquals("/chats?channel=c&call=" + CALL, RingPolicy.href("/chats?channel=c&call=" + CALL, CALL, false));
        assertEquals("/chats", RingPolicy.href("https://evil.example/chats?call=" + CALL, CALL, false));
        assertEquals("/chats", RingPolicy.href("/chats?channel=c&call=other", CALL, false));
        assertEquals("/settings?tab=devices&ringtest=" + CALL, RingPolicy.href(null, CALL, true));
        assertEquals("/chats?channel=c&call=" + CALL + "&answer=1", RingPolicy.answerHref("/chats?channel=c&call=" + CALL));
        assertEquals("/settings?tab=devices&ringtest=" + CALL, RingPolicy.answerHref("/settings?tab=devices&ringtest=" + CALL));
    }

    @Test
    public void aRingNeverOutlastsFortyFiveSeconds() {
        long now = 1_800_000_000_000L; // 2027-01-15T08:00:00Z
        assertEquals(now + 45_000, RingPolicy.until(null, now));
        assertEquals(now + 45_000, RingPolicy.until("2027-01-15T09:00:00.000Z", now));
        assertEquals(now + 20_000, RingPolicy.until("2027-01-15T08:00:20.000Z", now));
        assertEquals(now + 20_123, RingPolicy.until("2027-01-15T08:00:20.123456+00:00", now));
        assertEquals(now - 5_000, RingPolicy.until("2027-01-15T07:59:55Z", now));
    }
}
