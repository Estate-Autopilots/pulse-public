package com.pulse.work.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONTokener;

/**
 * Downloads (payslips, policy PDFs, exports) are fetched with the page's own sign-in and opened in a viewer, or
 * offered to share when no viewer exists. Files stay in the app's private cache, never in shared storage.
 */
final class ShellDownloads implements DownloadListener {

    private static final String TAG = "PulseDownload";
    private static final long MAX = 50L * 1024 * 1024;
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    private final Activity activity;
    private final WebView web;

    ShellDownloads(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        // Files the page made itself. POLISH-2 (QA-E2E P2-7): such a link carries no file name (Android made
        // "pdf_base64_JVBERi0x….pdf" of it): the link's own download name when it is on the page, else
        // "Pulse file <date>.<type>".
        String link = "[...document.querySelectorAll('a[download]')].find(x=>x.href===" + quote(url) + ")";
        if ("data".equals(scheme)) {
            // EST-1742: a data: link carries its bytes, so the shell saves them itself. Through the page bridge nothing
            // arrived where the WebView has no document-start scripts (the Android 10 and 12 emulators): Capacitor is
            // then missing on a page it did not serve, and the download failed without a word.
            Log.i(TAG, "page file: data " + mimetype);
            web.evaluateJavascript("(()=>{const a=" + link + ";return a&&a.getAttribute('download')||null})()", given -> saveData(url, mimetype, given));
            return;
        }
        if ("blob".equals(scheme)) {
            // A blob: link's bytes live only in the page: the page hands them over through the bridge (PulseShell.saveFile).
            Log.i(TAG, "page file: blob " + mimetype);
            String name = pageFileName(mimetype);
            // A failure after this answer (fetch, FileReader, the save itself) comes back as saveFile({failed:true}).
            web.evaluateJavascript("(()=>{const s=window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.PulseShell;if(!s)return false;"
                + "const no=e=>{console.error('page file',e);s.saveFile({failed:true}).catch(()=>{})};"
                + "(async()=>{try{const b=await (await fetch(" + quote(url) + ")).blob();const r=new FileReader();"
                + "const a=" + link + ";const n=a&&a.getAttribute('download')||" + quote(name) + ";"
                + "r.onerror=()=>no(r.error);r.onload=()=>s.saveFile({name:n,mime:b.type||" + quote(mimetype == null ? "" : mimetype)
                + ",base64:String(r.result).split(',')[1]}).catch(no);r.readAsDataURL(b);}catch(e){no(e)}})();return true})()",
                ok -> { if (!"true".equals(ok)) failed(activity, "page file: blob without the bridge"); });
            return;
        }
        if (!"https".equals(scheme) || !MainActivity.HOST.equals(uri.getHost())) {
            PulseShellPlugin.openExternal(activity, uri);
            return;
        }
        final String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
        final String cookies = CookieManager.getInstance().getCookie(url);
        Toast.makeText(activity, "Downloading " + name + "…", Toast.LENGTH_SHORT).show();
        WORK.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                // The page's session cookie belongs only to Pulse; never carry it through a download redirect.
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                if (cookies != null) c.setRequestProperty("Cookie", cookies);
                c.setRequestProperty("User-Agent", userAgent);
                if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
                String type = c.getContentType() != null ? c.getContentType().split(";")[0].trim() : mimetype;
                File file = target(activity, name);
                long total = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[65536];
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        total += n;
                        if (total > MAX) throw new IllegalStateException("Too large");
                        out.write(buffer, 0, n);
                    }
                } finally {
                    c.disconnect();
                }
                activity.runOnUiThread(() -> open(activity, file, type));
            } catch (Exception e) {
                activity.runOnUiThread(() -> Toast.makeText(activity, "The download did not finish. Check your connection and try again.", Toast.LENGTH_LONG).show());
            }
        });
    }

    /** A data: link's own bytes, saved and opened like any download; {@code given} is the link's download name (JSON). */
    private void saveData(String url, String mimetype, String given) {
        WORK.execute(() -> {
            try {
                int comma = url.indexOf(',');
                if (comma < 0) throw new IllegalArgumentException("Not a data URL");
                String head = url.substring(0, comma).toLowerCase(Locale.ROOT);
                String body = Uri.decode(url.substring(comma + 1));
                // Before decoding: no longer than a 50 MB file needs in either encoding (Base64 pads to 4 per 3 bytes).
                if (body.length() > (MAX + 2) / 3 * 4) throw new IllegalStateException("Too large");
                byte[] bytes = head.endsWith(";base64") ? Base64.decode(body, Base64.DEFAULT) : body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX) throw new IllegalStateException("Too large");
                Object name = given == null ? null : new JSONTokener(given).nextValue();
                File file = target(activity, name instanceof String && !((String) name).isEmpty() ? (String) name : pageFileName(mimetype));
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                activity.runOnUiThread(() -> open(activity, file, mimetype));
            } catch (Exception e) {
                failed(activity, "page file: data not saved: " + e.getClass().getSimpleName());
            }
        });
    }

    static void failed(Activity activity, String why) {
        Log.w(TAG, why);
        activity.runOnUiThread(() -> Toast.makeText(activity, "Pulse could not save the file.", Toast.LENGTH_LONG).show());
    }

    /** A readable name for a file the page made, from its type: "Pulse file 2026-10-12 14.05.pdf". */
    static String pageFileName(String mime) {
        String ext = mime == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(mime.split(";")[0].trim());
        String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH.mm", java.util.Locale.US).format(new java.util.Date());
        return "Pulse file " + stamp + (ext == null ? "" : "." + ext);
    }

    static File target(Context context, String name) {
        File dir = new File(context.getCacheDir(), "downloads");
        dir.mkdirs();
        String safe = name.replaceAll("[^A-Za-z0-9._ -]", "_");
        if (safe.isEmpty() || safe.startsWith(".")) safe = "Pulse download" + safe;
        return new File(dir, safe);
    }

    /** Open in a viewer; without one, offer the share sheet. */
    static void open(Activity activity, File file, String mime) {
        String type = mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)
            ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(file).toString()))
            : mime;
        if (type == null) type = "application/octet-stream";
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            // POLISH-2 (QA-E2E P2-8): not through a chooser, which never throws and dead-ends at "No apps can perform
            // this action" when no viewer exists; Android picks or asks itself, and with no viewer the share sheet opens.
            activity.startActivity(view);
        } catch (ActivityNotFoundException e) {
            share(activity, uri, type, file.getName());
        }
    }

    static void share(Activity activity, Uri uri, String type, String name) {
        Intent send = new Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(Intent.createChooser(send, "Share " + name));
    }

    private static String quote(String s) {
        return org.json.JSONObject.quote(s == null ? "" : s);
    }
}
