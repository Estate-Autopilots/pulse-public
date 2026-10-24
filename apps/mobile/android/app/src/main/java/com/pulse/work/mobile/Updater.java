package com.pulse.work.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Update available" → download → Android's package installer. The Android entry comes from Pulse's existing
 * updater channel; the APK must match its size and SHA-256, be this app, have a higher versionCode and carry the
 * same signing certificate as the installed app, or it is thrown away.
 */
final class Updater {

    static final String MANIFEST = MainActivity.ORIGIN + "/api/app-updates/test/latest.json";
    private static final Pattern NAME = Pattern.compile("^Pulse-(\\d+)\\.(\\d+)\\.(\\d+)-android\\.apk$");
    private static final Pattern RELEASE = Pattern.compile("^/Estate-Autopilots/pulse-companion/releases/download/companion-v\\d+\\.\\d+\\.\\d+-[a-f0-9]{7}" + releaseSuffix() + "/[A-Za-z0-9_.-]+\\.apk$");

    private Updater() {}

    private static String releaseSuffix() {
        if ("https://pulse.estateautopilots.com".equals(MainActivity.ORIGIN)) return "";
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(MainActivity.ORIGIN.getBytes(StandardCharsets.UTF_8))).substring(0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private static boolean trustedRelease(String value) {
        try {
            URL url = new URL(value);
            return "https".equals(url.getProtocol()) && "github.com".equals(url.getHost()) && RELEASE.matcher(url.getPath()).matches();
        } catch (MalformedURLException e) {
            return false;
        }
    }

    static long codeOf(String version) {
        String[] p = version.split("\\.");
        return Long.parseLong(p[0]) * 1_000_000L + Long.parseLong(p[1]) * 1_000L + Long.parseLong(p[2]);
    }

    /** The channel's Android APK, or null when the channel has none. */
    static JSONObject candidate() throws Exception {
        JSONObject manifest = Gateway.call("GET", MANIFEST, null, null);
        JSONArray files = manifest.optJSONArray("files");
        if (files == null) return null;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            if (!"android".equals(f.optString("platform")) || !"apk".equals(f.optString("kind"))) continue;
            Matcher m = NAME.matcher(f.optString("name"));
            if (!m.matches()) continue;
            String version = m.group(1) + "." + m.group(2) + "." + m.group(3);
            long code = f.has("versionCode") ? f.getLong("versionCode") : codeOf(version);
            JSONObject out = new JSONObject();
            out.put("version", version);
            out.put("versionCode", code);
            out.put("url", f.getString("url"));
            out.put("sha256", f.getString("sha256"));
            out.put("size", f.getLong("size"));
            out.put("notes", manifest.optString("notes", ""));
            out.put("available", code > Shell.code() && trustedRelease(f.getString("url")));
            return out;
        }
        return null;
    }

    private static String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder();
        for (byte b : bytes) s.append(String.format("%02x", b));
        return s.toString();
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) {
        Signature[] list = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : info.signatures;
        Set<String> out = new HashSet<>();
        if (list != null) for (Signature s : list) out.add(s.toCharsString());
        return out;
    }

    /** Download and verify; returns the ready file's name. */
    @SuppressWarnings("deprecation")
    static String download(Context context, String url, String sha256, long size) throws Exception {
        if (!trustedRelease(url)) throw new SecurityException("Untrusted update download");
        URL initial = new URL(url);
        if (!sha256.matches("[a-f0-9]{64}") || size <= 0 || size > 200_000_000L) throw new SecurityException("Invalid update entry");
        URL next = initial;
        HttpURLConnection connection = null;
        for (int i = 0; i < 6 && connection == null; i++) {
            if (!"https".equals(next.getProtocol()) || !Arrays.asList("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com").contains(next.getHost())) throw new SecurityException("Untrusted redirect");
            HttpURLConnection c = (HttpURLConnection) next.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(30000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", Gateway.userAgent());
            int code = c.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                next = new URL(next, c.getHeaderField("Location"));
                c.disconnect();
            } else if (code == 200) {
                connection = c;
            } else {
                c.disconnect();
                throw new IllegalStateException("Download refused");
            }
        }
        if (connection == null) throw new IllegalStateException("Too many redirects");
        File dir = new File(context.getCacheDir(), "pulse-updates");
        dir.mkdirs();
        File part = new File(dir, "Pulse-" + sha256 + ".apk.part");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) > 0) {
                bytes += n;
                if (bytes > size) throw new SecurityException("Larger than announced");
                digest.update(buffer, 0, n);
                out.write(buffer, 0, n);
            }
        } finally {
            connection.disconnect();
        }
        if (bytes != size || !hex(digest.digest()).equals(sha256)) {
            part.delete();
            throw new SecurityException("Checksum mismatch");
        }
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = pm.getPackageArchiveInfo(part.getPath(), flags);
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), flags);
        if (candidate == null || !context.getPackageName().equals(candidate.packageName)) { part.delete(); throw new SecurityException("Not Pulse"); }
        long newCode = Build.VERSION.SDK_INT >= 28 ? candidate.getLongVersionCode() : candidate.versionCode;
        long oldCode = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
        Set<String> oldSigners = signers(installed);
        if (newCode <= oldCode || oldSigners.isEmpty() || !oldSigners.equals(signers(candidate))) { part.delete(); throw new SecurityException("Not a newer Pulse from the same publisher"); }
        File ready = new File(dir, "Pulse-" + sha256 + ".apk");
        if (!part.renameTo(ready)) throw new IllegalStateException("Could not keep the download");
        return ready.getName();
    }

    static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls();
    }

    static void openInstallSettings(Context context) {
        context.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** Hand the verified APK to Android's installer; Android asks the person to confirm. */
    static String install(Context context, String name) {
        if (!name.matches("Pulse-[a-f0-9]{64}\\.apk")) throw new SecurityException("Unknown update");
        if (!canInstall(context)) return "permission";
        File file = new File(new File(context.getCacheDir(), "pulse-updates"), name);
        if (!file.isFile()) throw new IllegalStateException("Download the update again");
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        context.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return "installer";
    }
}
