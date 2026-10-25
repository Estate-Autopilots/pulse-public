package com.pulse.work.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingEvent;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * PRESENCE-ONBOARD: noticing arrival at an office, only with the person's own agreement (the server's presence choice
 * for this phone, or their onboarding agreement while the phone has none).
 *
 * - Geofences around the person's offices are watched by Android (Play services), which wakes Pulse only when the
 *   phone has stayed inside for HR's dwell time, or leaves. Pulse then sends "entered/left office X": never a
 *   position, never a journey. Android's own geofencing is battery-friendly (no polling by Pulse).
 * - Joining a Wi-Fi network wakes Pulse; if it is an office network (by name), Pulse sends its name and access
 *   point. Android reveals these only with location permission. The network callback alone woke Pulse only when it
 *   was registered (QA-E2E P1-14), so Android's job scheduler hands off too: on Wi-Fi a job waits for mobile data
 *   (the phone left Wi-Fi), which arms one that waits for Wi-Fi (the phone joined) and checks the network; and about
 *   every 15 minutes while on Wi-Fi.
 *
 * The server decides what happens (it asks "Check in?" or, with HR's setting, the person's consent and two signals,
 * checks in). Check-out is never automatic. Withdrawing consent removes the geofences and the Wi-Fi callback.
 */
final class OfficeArrival {
    static final String GEOFENCE = "com.pulse.work.mobile.OFFICE_GEOFENCE";
    static final String NETWORK = "com.pulse.work.mobile.OFFICE_NETWORK";
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    /** Log tag: what woke Pulse and whether a report went out (never a network name or a position). */
    private static final String TAG = "PulseArrival";
    static final String WIFI_CHECK = "pulse-office-wifi";
    static final String WIFI_JOIN = "pulse-office-wifi-join";
    static final String WIFI_LEAVE = "pulse-office-wifi-leave";
    /** Android allows 100 geofences per app; a person has a handful of offices at most. */
    private static final int LIMIT = 20;

    private OfficeArrival() {}

    static boolean located(Context c) {
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    /** Geofences fire while Pulse is closed only with "Allow all the time" (Android 10+). */
    static boolean background(Context c) {
        return Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent intent(Context c, String action, int code, int flags) {
        Intent i = new Intent(c, Receiver.class).setAction(action).setPackage(c.getPackageName());
        return PendingIntent.getBroadcast(c, code, i, flags | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    // Android fills in the triggering geofence and the network, so these intents are mutable (and explicit).
    private static int mutable() { return Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0; }

    /** Match the server's current choice and offices: register, refresh or remove. Safe to call often. */
    static void sync(Context context) {
        Context c = context.getApplicationContext();
        WORK.execute(() -> {
            try {
                if (!ShellStore.enrolled(c)) { stop(c); return; }
                JSONObject presence = Gateway.get("companion/presence", Gateway.accessToken(c));
                if (!presence.optBoolean("enabled") || !located(c)) { stop(c); ShellStore.put(c, "arrival-auto", "off"); return; }
                ShellStore.put(c, "arrival-auto", presence.optBoolean("auto") ? "on" : "off");
                ShellStore.put(c, "arrival-offices", presence.optJSONArray("offices") == null ? "[]" : presence.getJSONArray("offices").toString());
                fences(c, presence.optJSONArray("offices"), presence.optInt("dwellMinutes", 3));
                network(c);
                wifiCheck(c);
            } catch (Exception e) {
                // Offline or signed out: keep what is registered; the next app start or network change tries again.
                android.util.Log.w(TAG, "sync skipped: " + e.getClass().getSimpleName());
            }
        });
    }

    @SuppressLint("MissingPermission")
    private static void fences(Context c, JSONArray offices, int dwellMinutes) throws Exception {
        GeofencingClient client = LocationServices.getGeofencingClient(c);
        PendingIntent pi = intent(c, GEOFENCE, 3101, mutable());
        client.removeGeofences(pi);
        if (offices == null || offices.length() == 0 || !background(c)) return;
        List<Geofence> list = new ArrayList<>();
        for (int i = 0; i < offices.length() && list.size() < LIMIT; i++) {
            JSONObject o = offices.getJSONObject(i);
            if (!o.has("lat") || !o.has("lng")) continue;
            list.add(new Geofence.Builder().setRequestId(o.getString("id"))
                .setCircularRegion(o.getDouble("lat"), o.getDouble("lng"), (float) Math.max(100, o.optDouble("radius", 150)))
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setLoiteringDelay(Math.max(1, Math.min(30, dwellMinutes)) * 60_000)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_DWELL | Geofence.GEOFENCE_TRANSITION_EXIT).build());
        }
        if (list.isEmpty()) return;
        GeofencingRequest request = new GeofencingRequest.Builder().setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_DWELL).addGeofences(list).build();
        client.addGeofences(request, pi);
    }

    private static void network(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        PendingIntent pi = intent(c, NETWORK, 3102, mutable());
        try { cm.unregisterNetworkCallback(pi); } catch (Exception ignored) {}
        cm.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), pi);
    }

    /** A periodic check that runs only on an unmetered network (Wi-Fi), and a hand-off that wakes Pulse soon after the
     *  phone joins Wi-Fi: on Wi-Fi a one-time job waits for mobile data (leaving); when it runs, it arms a one-time job
     *  that waits for Wi-Fi again (joining). Android's job scheduler keeps both across Pulse being closed. */
    private static void wifiCheck(Context c) {
        Constraints wifi = new Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build();
        PeriodicWorkRequest every = new PeriodicWorkRequest.Builder(WifiCheck.class, 15, TimeUnit.MINUTES).setConstraints(wifi).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(WIFI_CHECK, ExistingPeriodicWorkPolicy.KEEP, every);
        watchLeave(c);
    }

    private static void watchLeave(Context c) {
        Constraints metered = new Constraints.Builder().setRequiredNetworkType(NetworkType.METERED).build();
        WorkManager.getInstance(c).enqueueUniqueWork(WIFI_LEAVE, ExistingWorkPolicy.KEEP, new OneTimeWorkRequest.Builder(WifiLeft.class).setConstraints(metered).build());
    }

    private static void watchJoin(Context c) {
        Constraints wifi = new Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build();
        WorkManager.getInstance(c).enqueueUniqueWork(WIFI_JOIN, ExistingWorkPolicy.KEEP, new OneTimeWorkRequest.Builder(WifiCheck.class).setConstraints(wifi).build());
    }

    static void stop(Context c) {
        try { WorkManager wm = WorkManager.getInstance(c); wm.cancelUniqueWork(WIFI_CHECK); wm.cancelUniqueWork(WIFI_JOIN); wm.cancelUniqueWork(WIFI_LEAVE); } catch (Exception ignored) {}
        try { LocationServices.getGeofencingClient(c).removeGeofences(intent(c, GEOFENCE, 3101, mutable())); } catch (Exception ignored) {}
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        try { if (cm != null) cm.unregisterNetworkCallback(intent(c, NETWORK, 3102, mutable())); } catch (Exception ignored) {}
    }

    /** What happened, sent with the phone's own credential. The body never carries a position. The person's choice
     *  is read again first: a withdrawal elsewhere (web, another device) stops this phone before anything is sent. */
    private static void send(Context c, JSONObject body) throws Exception {
        String token = Gateway.accessToken(c);
        JSONObject choice = Gateway.get("companion/presence", token);
        if (!choice.optBoolean("enabled")) { stop(c); return; }
        body.put("consent", true).put("autoConsent", choice.optBoolean("auto"));
        Gateway.post("companion/presence", body, token);
    }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    static JSONObject wifi(Context c) throws Exception {
        if (!located(c)) return null;
        WifiManager wm = (WifiManager) c.getSystemService(Context.WIFI_SERVICE);
        WifiInfo info = wm == null ? null : wm.getConnectionInfo();
        String ssid = info == null ? null : info.getSSID();
        if (ssid != null) ssid = ssid.replaceAll("^\"|\"$", "");
        if (ssid == null || ssid.isEmpty() || "<unknown ssid>".equals(ssid)) return null;
        String bssid = info.getBSSID();
        JSONArray offices = new JSONArray(ShellStore.get(c, "arrival-offices") == null ? "[]" : ShellStore.get(c, "arrival-offices"));
        for (int i = 0; i < offices.length(); i++) {
            JSONObject o = offices.getJSONObject(i);
            JSONArray nets = o.optJSONArray("wifi");
            for (int j = 0; nets != null && j < nets.length(); j++) {
                if (ssid.equals(nets.getJSONObject(j).optString("ssid"))) {
                    JSONObject w = new JSONObject().put("ssid", ssid);
                    if (bssid != null && !"02:00:00:00:00:00".equals(bssid)) w.put("bssid", bssid.toLowerCase());
                    return new JSONObject().put("officeId", o.getString("id")).put("wifi", w);
                }
            }
        }
        return null;   // Not an office network: nothing is sent.
    }

    /** The Wi-Fi check (see {@link #wifiCheck}): sends the office network only when the phone is on one. */
    public static class WifiCheck extends Worker {
        public WifiCheck(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

        @NonNull
        @Override
        public Result doWork() {
            Context c = getApplicationContext();
            Shell.init(c);
            try {
                if (!ShellStore.enrolled(c)) return Result.success();
                JSONObject w = wifi(c);
                android.util.Log.i(TAG, w != null ? "wifi check: an office Wi-Fi, reporting" : "wifi check: not an office Wi-Fi (or Android hides its name)");
                if (w != null) send(c, w);
            } catch (Exception e) {
                android.util.Log.w(TAG, "wifi check not sent: " + e.getClass().getSimpleName());
            } finally {
                if (ShellStore.enrolled(c)) watchLeave(c);   // on Wi-Fi now: wait for the phone to leave it
            }
            return Result.success();
        }
    }

    /** The phone left Wi-Fi (it is on mobile data): wait for it to join Wi-Fi again. Reads and sends nothing. */
    public static class WifiLeft extends Worker {
        public WifiLeft(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

        @NonNull
        @Override
        public Result doWork() {
            Context c = getApplicationContext();
            Shell.init(c);
            if (ShellStore.enrolled(c)) { android.util.Log.i(TAG, "wifi watch: off Wi-Fi, waiting to join"); watchJoin(c); }
            return Result.success();
        }
    }

    /** Android's wake-ups: a geofence transition, a Wi-Fi network, or a reboot (geofences are cleared on boot). */
    public static class Receiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent i) {
            Context c = context.getApplicationContext();
            Shell.init(c);
            String action = i.getAction();
            android.util.Log.i(TAG, "woken: " + action);
            if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) { sync(c); return; }
            PendingResult done = goAsync();
            WORK.execute(() -> {
                try {
                    if (!ShellStore.enrolled(c)) return;
                    if (GEOFENCE.equals(action)) {
                        GeofencingEvent event = GeofencingEvent.fromIntent(i);
                        if (event == null || event.hasError() || event.getTriggeringGeofences() == null) return;
                        String region = event.getGeofenceTransition() == Geofence.GEOFENCE_TRANSITION_EXIT ? "exit" : "enter";
                        for (Geofence g : event.getTriggeringGeofences()) {
                            JSONObject body = new JSONObject().put("officeId", g.getRequestId()).put("region", region);
                            // POLISH-2: a dwell transition means the person already stayed HR's dwell; the server does
                            // not make them wait it again.
                            if ("enter".equals(region)) body.put("dwelled", event.getGeofenceTransition() == Geofence.GEOFENCE_TRANSITION_DWELL);
                            // Arriving on the office Wi-Fi as well: send both kinds of signal together.
                            JSONObject w = "enter".equals(region) ? wifi(c) : null;
                            if (w != null && g.getRequestId().equals(w.optString("officeId"))) body.put("wifi", w.getJSONObject("wifi"));
                            send(c, body);
                        }
                    } else if (NETWORK.equals(action)) {
                        JSONObject w = wifi(c);
                        android.util.Log.i(TAG, w != null ? "network: an office Wi-Fi, reporting" : "network: not an office Wi-Fi (or Android hides its name)");
                        if (w != null) send(c, w);
                    }
                } catch (Exception e) {
                    // Signed out, revoked or offline: the next event or app start tries again.
                    android.util.Log.w(TAG, "report not sent: " + e.getClass().getSimpleName());
                } finally { done.finish(); }
            });
        }
    }
}
