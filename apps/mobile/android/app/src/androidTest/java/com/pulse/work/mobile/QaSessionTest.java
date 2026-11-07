package com.pulse.work.mobile;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Collection;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * QA-E2E: a remote-controlled session for the emulator QA (apps/mobile/scripts/android-qa.sh). A synthetic Pulse
 * answers the shell's gateway calls inside this process (Gateway.transport), so nothing ever reaches production; the
 * host drives the real OS around the real shell code (spoofed GPS with `adb emu geo fix`, Wi-Fi on and off, the
 * notification shade, the launcher's widget, permission prompts) and reads what the shell did from a journal
 * (files/qa/journal.jsonl). Steps arrive as broadcasts: am broadcast -a com.pulse.work.mobile.QA_STEP --es step NAME.
 * Only this test registers that receiver, and only while it runs. Skipped unless the host passes -e qa 1.
 */
@RunWith(AndroidJUnit4.class)
public class QaSessionTest {
    static final String STEP = "com.pulse.work.mobile.QA_STEP";
    static final String PERSON = "synthetic-qa-person", DEVICE = "synthetic-qa-device", OFFICE = "11111111-2222-4333-8444-555555555555";
    Context c;
    File journal;
    final AtomicInteger refreshes = new AtomicInteger();
    final CountDownLatch stop = new CountDownLatch(1);
    volatile JSONObject presence = new JSONObject();
    volatile JSONArray updates = new JSONArray();
    volatile String dayState = "out";
    volatile boolean updatesOnce = true;
    volatile int total = 0;
    LocationCallback keepAlive;

    synchronized void log(JSONObject line) {
        try (FileWriter w = new FileWriter(journal, true)) { w.write(line.put("t", System.currentTimeMillis()).toString() + "\n"); }
        catch (IOException | JSONException ignored) {}
    }
    void log(String event, Object... kv) {
        JSONObject o = new JSONObject();
        try { o.put("event", event); for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]); } catch (JSONException ignored) {}
        log(o);
    }

    /** The synthetic Pulse: the answers the real server gives, shaped by the current step's settings. */
    JSONObject answer(String method, String url, JSONObject body, String bearer) throws IOException {
        String path = url.startsWith(Gateway.BASE) ? url.substring(Gateway.BASE.length()) : url;
        log("call", "method", method, "path", path, "body", body == null ? null : body, "bearer", bearer != null);
        try {
            if (path.equals("native/refresh")) return new JSONObject().put("refreshToken", "synthetic-rotated-" + refreshes.incrementAndGet()).put("accessToken", "synthetic-access").put("expiresIn", 900);
            if (path.equals("companion/presence") && "GET".equals(method)) return presence;
            if (path.equals("companion/presence")) { log("presence", "body", body); return new JSONObject().put("enabled", true).put("score", 45).put("asked", false); }
            if (path.equals("companion")) return day();
            if (path.startsWith("companion/updates")) {
                JSONArray rows = updates; if (updatesOnce) updates = new JSONArray();
                // The server's unread total stays until the items are read (0 would make the shell clear its notifications).
                return new JSONObject().put("rows", rows).put("counts", new JSONObject().put("total", total).put("chats", 1)).put("cursor", "2026-10-11T00:00:00.000Z").put("hasMore", false);
            }
            if (path.equals("companion/ack")) { log("ack", "ids", body == null ? null : body.optJSONArray("ids")); return new JSONObject().put("ok", true); }
            if (path.startsWith("attendance/")) { log("attendance", "path", path, "body", body); dayState = path.endsWith("check-out") ? "done" : "in"; return new JSONObject().put("id", "synthetic-entry"); }
        } catch (JSONException e) { throw new IOException(e); }
        throw new Gateway.Failed(404, "QA synthetic server has no answer for " + path);
    }

    JSONObject day() throws JSONException {
        JSONObject d = new JSONObject().put("attendanceEnabled", true).put("person", new JSONObject().put("id", PERSON).put("name", "Synthetic QA"))
            .put("state", dayState).put("now", "2026-10-11T05:30:00.000Z").put("today", "2026-10-11").put("utcOffsetMinutes", 330)
            .put("shift", new JSONObject().put("start", "10:00").put("end", "19:00"));
        if (!"out".equals(dayState)) d.put("entry", new JSONObject().put("date", "2026-10-11").put("in", "2026-10-11T04:28:00.000Z").put("out", "done".equals(dayState) ? "2026-10-11T13:40:00.000Z" : JSONObject.NULL).put("closedBreakSeconds", 0).put("breakStartedAt", JSONObject.NULL));
        return d;
    }

    /** What a signed-in phone holds: a sealed device credential and the last confirmed day for the widget. */
    void enrol() {
        ShellStore.put(c, ShellStore.DEVICE, DEVICE);
        ShellStore.put(c, ShellStore.PERSON, PERSON);
        ShellStore.put(c, ShellStore.REFRESH, "synthetic-placeholder-never-transported");
    }

    void fixture(String state) throws JSONException {
        enrol();
        JSONObject s = new JSONObject().put("state", state.equals("forgotten") ? "in" : state).put("enabled", true).put("person", PERSON).put("device", DEVICE)
            .put("boot", AttendanceSurfaces.boot(c)).put("elapsed", SystemClock.elapsedRealtime()).put("today", "2026-10-11").put("offset", 330)
            .put("shiftStart", "10:00").put("shiftEnd", "19:00");
        switch (state) {
            case "in": s.put("updated", "2026-10-11T08:35:00.000Z").put("entryDate", "2026-10-11").put("in", "2026-10-11T04:28:00.000Z").put("out", "").put("closedBreak", 1800).put("breakStarted", ""); break;
            case "break": s.put("updated", "2026-10-11T08:35:00.000Z").put("entryDate", "2026-10-11").put("in", "2026-10-11T04:28:00.000Z").put("out", "").put("closedBreak", 0).put("breakStarted", "2026-10-11T08:20:00.000Z"); break;
            case "done": s.put("updated", "2026-10-11T13:45:00.000Z").put("entryDate", "2026-10-11").put("in", "2026-10-11T04:28:00.000Z").put("out", "2026-10-11T13:40:00.000Z").put("closedBreak", 1800).put("breakStarted", ""); break;
            case "forgotten": s.put("updated", "2026-10-10T22:55:00.000Z").put("entryDate", "2026-10-10").put("in", "2026-10-10T12:16:00.000Z").put("out", "").put("closedBreak", 0).put("breakStarted", ""); break;
            default: s.put("updated", "2026-10-11T03:50:00.000Z").put("nextDate", "2026-10-11").put("nextStart", "10:00");
        }
        dayState = state.equals("forgotten") ? "in" : state;
        ShellStore.put(c, AttendanceSurfaces.KEY, s.toString());
        AttendanceSurfaces.render(c);
    }

    JSONArray notifications() throws JSONException {
        JSONArray list = new JSONArray();
        for (StatusBarNotification n : c.getSystemService(NotificationManager.class).getActiveNotifications()) {
            Notification x = n.getNotification();
            JSONArray actions = new JSONArray();
            if (x.actions != null) for (Notification.Action a : x.actions) actions.put(String.valueOf(a.title));
            list.put(new JSONObject().put("id", n.getId()).put("tag", n.getTag()).put("channel", x.getChannelId()).put("title", String.valueOf(x.extras.getCharSequence(Notification.EXTRA_TITLE)))
                .put("text", String.valueOf(x.extras.getCharSequence(Notification.EXTRA_TEXT))).put("number", x.number).put("actions", actions)
                .put("publicTitle", x.publicVersion == null ? JSONObject.NULL : String.valueOf(x.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE))));
        }
        return list;
    }

    Activity resumed() {
        Activity[] found = { null };
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Collection<Activity> list = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED);
            for (Activity a : list) found[0] = a;
        });
        return found[0];
    }

    String webUrl() {
        Activity a = resumed();
        if (!(a instanceof MainActivity)) return null;
        String[] url = { null };
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { WebView w = ((MainActivity) a).getBridge().getWebView(); url[0] = w.getUrl(); });
        return url[0];
    }

    void handle(Intent i) throws Exception {
        String step = i.getStringExtra("step");
        int seq = i.getIntExtra("seq", 0);
        JSONObject done = new JSONObject().put("event", "done").put("step", step).put("seq", seq);
        switch (step == null ? "" : step) {
            case "presence": {
                JSONArray wifi = new JSONArray(); String ssid = i.getStringExtra("ssid"); if (ssid != null) wifi.put(new JSONObject().put("ssid", ssid).put("bssids", new JSONArray()));
                presence = new JSONObject().put("enabled", i.getBooleanExtra("enabled", true)).put("auto", i.getBooleanExtra("auto", false)).put("dwellMinutes", i.getIntExtra("dwell", 1))
                    .put("offices", new JSONArray().put(new JSONObject().put("id", OFFICE).put("name", "Synthetic HQ").put("lat", i.getDoubleExtra("lat", 18.5204)).put("lng", i.getDoubleExtra("lng", 73.8567))
                        .put("radius", i.getIntExtra("radius", 150)).put("wifi", wifi))).put("sites", new JSONArray());
                break;
            }
            case "gms": done.put("playServices", GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(c) == ConnectionResult.SUCCESS)
                .put("located", OfficeArrival.located(c)).put("background", OfficeArrival.background(c)); break;
            case "enrol": enrol(); break;
            case "sync": OfficeArrival.sync(c); break;
            case "keepalive": {
                // A foreground app asking for positions keeps Android's fused provider on the emulator's GPS fixes.
                FusedLocationProviderClient fused = LocationServices.getFusedLocationProviderClient(c);
                keepAlive = new LocationCallback() {
                    @Override public void onLocationResult(LocationResult r) {
                        android.location.Location l = r.getLastLocation();
                        if (l != null) log("location", "lat", Math.round(l.getLatitude() * 1e4) / 1e4, "lng", Math.round(l.getLongitude() * 1e4) / 1e4, "accuracy", l.getAccuracy());
                    }
                };
                try { fused.requestLocationUpdates(new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000).build(), keepAlive, Looper.getMainLooper()); done.put("ok", true); }
                catch (SecurityException e) { done.put("ok", false).put("error", "permission"); }
                break;
            }
            case "wifi": { JSONObject w = OfficeArrival.wifi(c); done.put("wifi", w == null ? JSONObject.NULL : w); break; }
            case "wifi-raw": {
                // What Android lets this app read right now (the emulator's own network; synthetic names only).
                @SuppressWarnings("deprecation") android.net.wifi.WifiInfo info = ((android.net.wifi.WifiManager) c.getApplicationContext().getSystemService(Context.WIFI_SERVICE)).getConnectionInfo();
                done.put("ssid", info == null ? JSONObject.NULL : info.getSSID()).put("located", OfficeArrival.located(c)).put("background", OfficeArrival.background(c))
                    .put("offices", ShellStore.get(c, "arrival-offices") == null ? JSONObject.NULL : ShellStore.get(c, "arrival-offices"));
                break;
            }
            case "netwatch": {
                // The test's own Wi-Fi callback beside the shell's: when Android says Wi-Fi is up, what would the shell send?
                android.net.ConnectivityManager cm = c.getSystemService(android.net.ConnectivityManager.class);
                android.net.ConnectivityManager.NetworkCallback cb = new android.net.ConnectivityManager.NetworkCallback() {
                    @Override public void onAvailable(android.net.Network n) {
                        try { JSONObject w = OfficeArrival.wifi(c); log("netwatch", "change", "available", "wifi", w == null ? JSONObject.NULL : w); } catch (Exception e) { log("netwatch", "change", "available", "error", String.valueOf(e)); }
                    }
                    @Override public void onLost(android.net.Network n) { log("netwatch", "change", "lost"); }
                };
                cm.registerNetworkCallback(new android.net.NetworkRequest.Builder().addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI).build(), cb);
                break;
            }
            case "updates": updates = new JSONArray(i.getStringExtra("rows")); updatesOnce = i.getBooleanExtra("once", true); total = i.getIntExtra("total", updates.length()); break;
            case "inbox": done.put("total", InboxWorker.check(c, i.getBooleanExtra("notify", true))).put("notifications", notifications()); break;
            case "inbox-work": InboxWorker.runNow(c); break;
            case "notifications": done.put("notifications", notifications()).put("enabled", Notifier.enabled(c)); break;
            case "badge": Notifier.badge(c, i.getIntExtra("count", 0)); done.put("notifications", notifications()); break;
            case "open-notification": {
                String tag = i.getStringExtra("tag");
                for (StatusBarNotification n : c.getSystemService(NotificationManager.class).getActiveNotifications())
                    if (tag != null && tag.equals(n.getTag())) { n.getNotification().contentIntent.send(); done.put("sent", true); }
                break;
            }
            case "notification-action": {
                // Press a notification's own button (as from the shade), e.g. the arrival question's "Check in".
                String title = i.getStringExtra("title");
                for (StatusBarNotification n : c.getSystemService(NotificationManager.class).getActiveNotifications()) {
                    CharSequence t = n.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE);
                    if (title != null && t != null && t.toString().contains(title) && n.getNotification().actions != null && n.getNotification().actions.length > 0) {
                        n.getNotification().actions[0].actionIntent.send(); done.put("pressed", String.valueOf(n.getNotification().actions[0].title));
                    }
                }
                break;
            }
            case "url": done.put("url", webUrl()).put("activity", resumed() == null ? JSONObject.NULL : resumed().getClass().getSimpleName()); break;
            case "fixture": fixture(i.getStringExtra("state")); break;
            case "day": dayState = i.getStringExtra("state"); break;
            case "refresh-widgets": InboxWorker.refreshWidgets(c); break;
            case "pin-widget": {
                AppWidgetManager m = AppWidgetManager.getInstance(c);
                Class<?> kind = "small".equals(i.getStringExtra("size")) ? AttendanceWidgetSmall.class : AttendanceWidget.class;
                done.put("supported", m.isRequestPinAppWidgetSupported()).put("requested", m.requestPinAppWidget(new ComponentName(c, kind), null, null));
                break;
            }
            case "widgets": {
                AppWidgetManager m = AppWidgetManager.getInstance(c);
                done.put("medium", m.getAppWidgetIds(new ComponentName(c, AttendanceWidget.class)).length).put("small", m.getAppWidgetIds(new ComponentName(c, AttendanceWidgetSmall.class)).length);
                break;
            }
            case "pending": { String p = ShellStore.get(c, AttendanceSurfaces.PENDING); done.put("pending", p == null ? JSONObject.NULL : new JSONObject(p)); break; }
            case "inject": {
                // A page with the controls the shell must serve natively: a file field (uploads) and a PDF the page made
                // (downloads go through the bridge's saveFile). Loaded into the real WebView with the shell's own clients.
                Activity a = resumed();
                String accept = i.getStringExtra("accept") == null ? "image/*,application/pdf" : i.getStringExtra("accept");
                String html = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:18px sans-serif;padding:24px'>"
                    + "<h1>QA upload and download</h1><p><input id=f type=file" + (accept.isEmpty() ? "" : " accept='" + accept + "'") + " style='font-size:20px'></p>"
                    + "<p><a id=d download='Payslip-synthetic.pdf' href='data:application/pdf;base64,JVBERi0xLjQKJSBzeW50aGV0aWMgcGF5c2xpcAolJUVPRgo='>Download synthetic payslip</a></p>"
                    + "<p id=o>none</p><script>f.onchange=()=>{o.textContent='picked:'+(f.files[0]?f.files[0].name+':'+f.files[0].size:'none');document.body.dataset.qa=o.textContent}</script>";
                if (a instanceof MainActivity) InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> ((MainActivity) a).getBridge().getWebView().loadDataWithBaseURL(MainActivity.ORIGIN + "/qa", html, "text/html", "utf-8", null));
                done.put("injected", a instanceof MainActivity);
                break;
            }
            case "seed-image": {
                android.content.ContentValues values = new android.content.ContentValues();
                values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "pulse-qa-gallery.jpg");
                values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PulseQA");
                android.net.Uri uri = c.getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                assertNotNull("Synthetic image could not be inserted", uri);
                android.graphics.Bitmap image = android.graphics.Bitmap.createBitmap(64, 48, android.graphics.Bitmap.Config.ARGB_8888);
                image.eraseColor(0xff336699);
                try (java.io.OutputStream out = c.getContentResolver().openOutputStream(uri)) {
                    assertTrue(image.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, out));
                } finally { image.recycle(); }
                done.put("seeded", uri.toString());
                break;
            }
            case "gps-photo": {
                // Test-only page in the real release WebView: no bridge mocks, personal data or network requests.
                Activity a = resumed();
                String html = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:18px sans-serif;padding:24px'>"
                    + "<h1>GPS site photo QA</h1><label>Take site photo<input id=f type=file accept='image/*' capture='environment'></label><p id=v>Photo idle</p>"
                    + "<p><label>Gallery photo<input id=g type=file accept='image/*'></label></p>"
                    + "<p><button id=l>Use location</button></p><p id=o>Location idle</p>"
                    + "<button id=u>Continue without location</button><p id=r>Ready</p><script>"
                    + "const picked=(input,key)=>{const file=input.files[0];if(!file)return;const img=new Image();img.onload=()=>{document.body.dataset[key]=JSON.stringify({name:file.name,size:file.size,type:file.type,width:img.naturalWidth,height:img.naturalHeight});v.textContent=key+' received '+file.size+' bytes '+img.naturalWidth+'x'+img.naturalHeight;URL.revokeObjectURL(img.src)};img.src=URL.createObjectURL(file)};f.onchange=()=>picked(f,'photo');g.onchange=()=>picked(g,'gallery');"
                    + "l.onclick=()=>{o.textContent='Locating';navigator.geolocation.getCurrentPosition(p=>{o.textContent='Location received';document.body.dataset.geo=JSON.stringify({lat:p.coords.latitude,lng:p.coords.longitude})},e=>{o.textContent='Location denied '+e.code;document.body.dataset.geo=JSON.stringify({error:e.code})},{enableHighAccuracy:true,timeout:20000,maximumAge:0})};"
                    + "u.onclick=()=>{r.textContent='Page usable';document.body.dataset.usable='yes'}</script>";
                if (a instanceof MainActivity) InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                    android.webkit.GeolocationPermissions.getInstance().clearAll();
                    ((MainActivity) a).getBridge().getWebView().loadDataWithBaseURL(MainActivity.ORIGIN + "/qa", html, "text/html", "utf-8", null);
                });
                done.put("injected", a instanceof MainActivity);
                break;
            }
            case "eval": {
                Activity a = resumed(); String js = i.getStringExtra("js"); String[] out = { null }; CountDownLatch got = new CountDownLatch(1);
                if (a instanceof MainActivity) InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> ((MainActivity) a).getBridge().getWebView().evaluateJavascript(js, v -> { out[0] = v; got.countDown(); }));
                got.await(10, TimeUnit.SECONDS); done.put("result", out[0] == null ? JSONObject.NULL : out[0]);
                break;
            }
            case "downloads": {
                File dir = new File(c.getCacheDir(), "downloads"); JSONArray files = new JSONArray();
                File[] list = dir.listFiles(); if (list != null) for (File f : list) files.put(f.getName() + ":" + f.length());
                done.put("files", files);
                break;
            }
            case "forget": Gateway.forget(c); break;
            case "watch-pending": {
                // A widget tap stores its pending action before the page loads; catch it as it appears.
                new Thread(() -> {
                    for (int k = 0; k < 200; k++) {
                        String p = ShellStore.get(c, AttendanceSurfaces.PENDING);
                        if (p != null && p.contains("action")) { log("pending-seen", "pending", p); return; }
                        SystemClock.sleep(100);
                    }
                    log("pending-seen", "pending", null);
                }).start();
                break;
            }
            case "stop": stop.countDown(); break;
            default: done.put("error", "unknown step");
        }
        log(done);
    }

    @Test
    public void serve() throws Exception {
        if (!"1".equals(InstrumentationRegistry.getArguments().getString("qa"))) return;   // only for android-qa.sh
        c = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File dir = new File(c.getExternalFilesDir(null), "qa");
        assertTrue(dir.isDirectory() || dir.mkdirs());
        journal = new File(dir, "journal.jsonl");
        if (journal.exists()) assertTrue(journal.delete());
        Gateway.forget(c);
        Gateway.transport = this::answer;
        presence = new JSONObject().put("enabled", false).put("auto", false).put("dwellMinutes", 1).put("offices", new JSONArray()).put("sites", new JSONArray());
        HandlerThread thread = new HandlerThread("qa-steps"); thread.start();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                try { handle(intent); }
                catch (Throwable e) { log("error", "step", intent.getStringExtra("step"), "seq", intent.getIntExtra("seq", 0), "message", String.valueOf(e)); }
            }
        };
        if (Build.VERSION.SDK_INT >= 33) c.registerReceiver(receiver, new IntentFilter(STEP), null, new Handler(thread.getLooper()), Context.RECEIVER_EXPORTED);
        else c.registerReceiver(receiver, new IntentFilter(STEP), null, new Handler(thread.getLooper()));
        log("ready", "sdk", Build.VERSION.SDK_INT, "playServices", GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(c) == ConnectionResult.SUCCESS);
        try {
            stop.await(Long.parseLong(String.valueOf(InstrumentationRegistry.getArguments().getString("minutes", "45"))), TimeUnit.MINUTES);
        } finally {
            c.unregisterReceiver(receiver);
            if (keepAlive != null) LocationServices.getFusedLocationProviderClient(c).removeLocationUpdates(keepAlive);
            Gateway.transport = Gateway::http;
            Gateway.forget(c);
            thread.quitSafely();
            log("stopped");
        }
    }
}
