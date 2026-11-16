package com.pulse.work.mobile;
import static org.junit.Assert.*;
import org.junit.Test;
/** POLISH-2 (QA-E2E P1-15): the picker asks for every type a field accepts, not only the first. */
public class UploadTypesTest {
    @Test public void everyAcceptedTypeReachesThePicker() {
        assertArrayEquals(new String[]{"application/pdf", "image/jpeg", "image/png", "image/webp"},
            UploadTypes.mimeTypes(new String[]{"application/pdf", "image/jpeg", "image/png", "image/webp"}));
        assertArrayEquals("one attribute string is split too", new String[]{"application/pdf", "image/*"}, UploadTypes.mimeTypes(new String[]{"application/pdf,image/*"}));
        assertArrayEquals("extensions become types", new String[]{"application/pdf", "image/jpeg", "image/heic"}, UploadTypes.mimeTypes(new String[]{".PDF", " .jpg", ".heic"}));
    }
    @Test public void anythingMeansNoFilter() {
        assertEquals(0, UploadTypes.mimeTypes(null).length);
        assertEquals(0, UploadTypes.mimeTypes(new String[]{""}).length);
        assertEquals(0, UploadTypes.mimeTypes(new String[]{"image/*", "*/*"}).length);
    }
}
