package com.pulse.work.mobile;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pulse's token-only native gateway (/api/native/v0). The shell's device credential never reaches the page:
 * a 15-minute access token in memory, and a single-use rotating refresh token in {@link ShellStore}.
 */
final class Gateway {

    static final String BASE = MainActivity.ORIGIN + "/api/native/v0/";

    /** The server ended this device (revoked, signed out on the web, replaced): forget it locally. */
    static final class Revoked extends IOException {
        Revoked() {
            super("Device sign-in ended");
        }
    }

    static final class Failed extends IOException {
        final int status;

        Failed(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private static String access;
    private static long accessUntil;

    private Gateway() {}

    static String userAgent() {
        return "PulseShell/" + Shell.version() + " (android)";
    }

    interface Transport { JSONObject call(String method, String url, JSONObject body, String bearer) throws IOException; }
    // Package-private adapter for hosted instrumentation; no bridge/config setting can replace the production transport.
    static Transport transport = Gateway::http;
    static JSONObject call(String method, String url, JSONObject body, String bearer) throws IOException {
        return transport.call(method, url, body, bearer);
    }
    static JSONObject http(String method, String url, JSONObject body, String bearer) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", userAgent());
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = "";
            if (in != null) {
                try (InputStream stream = in) {
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = stream.read(chunk)) > 0 && buffer.size() < 2_000_000) buffer.write(chunk, 0, n);
                    text = buffer.toString("UTF-8");
                }
            }
            if (status == 204) return new JSONObject();
            JSONObject json;
            try {
                json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                throw new Failed(status, "Pulse sent an unexpected answer");
            }
            if (status >= 400) throw new Failed(status, json.optString("error", "Pulse did not answer"));
            return json;
        } finally {
            c.disconnect();
        }
    }

    static JSONObject post(String path, JSONObject body, String bearer) throws IOException {
        return call("POST", BASE + path, body == null ? new JSONObject() : body, bearer);
    }

    static JSONObject get(String path, String bearer) throws IOException {
        return call("GET", BASE + path, null, bearer);
    }

    /** A current access token, rotating the refresh token when needed. Rotation is serialised for the whole app. */
    static synchronized String accessToken(Context context) throws IOException {
        if (access != null && System.currentTimeMillis() < accessUntil - 60_000) return access;
        String refresh = ShellStore.get(context, ShellStore.REFRESH);
        if (refresh == null) throw new Revoked();
        JSONObject r;
        try {
            r = post("native/refresh", json("refreshToken", refresh), null);
        } catch (Failed e) {
            if (e.status == 401) {
                forget(context);
                throw new Revoked();
            }
            throw e;
        }
        try {
            ShellStore.put(context, ShellStore.REFRESH, r.getString("refreshToken"));
            access = r.getString("accessToken");
            accessUntil = System.currentTimeMillis() + r.optLong("expiresIn", 900) * 1000;
        } catch (JSONException e) {
            throw new IOException("Unexpected sign-in answer");
        }
        return access;
    }

    /** Store a freshly issued device credential (enrolment). */
    static synchronized void remember(Context context, JSONObject tokens) throws JSONException {
        ShellStore.put(context, ShellStore.REFRESH, tokens.getString("refreshToken"));
        ShellStore.put(context, ShellStore.DEVICE, tokens.getString("deviceId"));
        JSONObject person = tokens.optJSONObject("person");
        if (person != null) ShellStore.put(context, ShellStore.PERSON, person.optString("id"));
        access = tokens.getString("accessToken");
        accessUntil = System.currentTimeMillis() + tokens.optLong("expiresIn", 900) * 1000;
    }

    static synchronized void forget(Context context) {
        access = null;
        accessUntil = 0;
        ShellStore.clear(context);
        InboxWorker.cancel(context);
        AttendanceSurfaces.clear(context);
    }

    static JSONObject json(String key, Object value) {
        JSONObject o = new JSONObject();
        try {
            o.put(key, value);
        } catch (JSONException ignored) {}
        return o;
    }
}
