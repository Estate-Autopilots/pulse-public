package com.pulse.work.mobile;

import android.webkit.MimeTypeMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** POLISH-2: an upload field's accepted types for Android's picker (pure; the common extensions need no Android). */
final class UploadTypes {
    private UploadTypes() {}

    private static String common(String ext) {
        switch (ext) {
            case "pdf": return "application/pdf";
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "webp": return "image/webp";
            case "heic": return "image/heic";
            case "heif": return "image/heif";
            default: return null;
        }
    }

    /** The field's accepted types as MIME types (".pdf" becomes application/pdf); empty means anything. */
    static String[] mimeTypes(String[] accept) {
        Set<String> out = new LinkedHashSet<>();
        if (accept != null) for (String raw : accept) {
            if (raw == null) continue;
            for (String part : raw.split(",")) {
                String t = part.trim().toLowerCase(Locale.ROOT);
                if (t.isEmpty()) continue;
                if (t.startsWith(".")) {
                    String ext = t.substring(1);
                    String mime = common(ext);
                    if (mime == null) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                    if (mime != null) out.add(mime);
                } else if (t.contains("/")) out.add(t);
            }
        }
        if (out.contains("*/*")) out.clear();
        return out.toArray(new String[0]);
    }

}
