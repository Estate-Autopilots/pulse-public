package com.pulse.work.mobile;

import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.provider.Settings;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.IOException;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/** Cached self-only presentation. All taps open the authenticated web desk; no background attendance writes. */
final class AttendanceSurfaces {
    static final String CHANNEL = "pulse-attendance";
    static final String KEY = "attendance-surface";
    static final String PENDING = "attendance-surface-pending";
    static final String NONCE = "attendance-surface-nonce";
    static final String RIBBON = "attendance-ribbon";
    static final String EXTRA_NONCE = "pulse.surface.nonce";
    static final String EXTRA_ACTION = "pulse.surface.action";
    static final int NOTIFICATION = 2101;

    private AttendanceSurfaces() {}
    static long boot(Context c) { return Settings.Global.getInt(c.getContentResolver(), Settings.Global.BOOT_COUNT, -1); }
    static JSONObject read(Context c) {
        try { String value = ShellStore.get(c, KEY); return value == null ? null : new JSONObject(value); }
        catch (JSONException | IllegalStateException e) { return null; }
    }
    static boolean fresh(Context c, JSONObject s) {
        return s != null && boot(c) >= 0 && SurfacePolicy.fresh(s.optLong("boot", -2), boot(c), s.optLong("elapsed", -1), SystemClock.elapsedRealtime())
            && ShellStore.enrolled(c) && s.optString("device").equals(ShellStore.get(c, ShellStore.DEVICE));
    }
    static String nonce(Context c) {
        String n = ShellStore.get(c, NONCE);
        if (n == null) { n = UUID.randomUUID().toString(); ShellStore.put(c, NONCE, n); }
        return n;
    }
    static PendingIntent tap(Context c, String action) {
        Intent open = new Intent(c, MainActivity.class).setAction("pulse.surface." + action)
            .putExtra(MainActivity.EXTRA_HREF, "/me").putExtra(EXTRA_ACTION, action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!"open".equals(action)) open.putExtra(EXTRA_NONCE, nonce(c));
        return PendingIntent.getActivity(c, 2100 + action.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    /** External links/extras cannot create a pending attendance intent without this installation's sealed nonce. */
    static void accept(Context c, Intent intent) {
        String action = intent.getStringExtra(EXTRA_ACTION), n = intent.getStringExtra(EXTRA_NONCE);
        intent.removeExtra(EXTRA_ACTION); intent.removeExtra(EXTRA_NONCE);
        if (action == null || n == null || !n.equals(ShellStore.get(c, NONCE))) return;
        if ("open".equals(action)) return;
        JSONObject s = read(c);
        if (!fresh(c, s) || !action.equals(SurfacePolicy.primary(s.optString("state"), s.optBoolean("enabled")))) return;
        try {
            JSONObject p = new JSONObject().put("action", action).put("person", s.getString("person")).put("device", s.getString("device"))
                .put("boot", boot(c)).put("elapsed", SystemClock.elapsedRealtime());
            // Repeated taps are one intent; confirmation (not the stale widget time) becomes the queue timestamp.
            ShellStore.put(c, PENDING, p.toString());
        } catch (JSONException ignored) {}
    }
    /** Revalidate the device on a cold tap before exposing a confirmation to the signed-in web person. */
    static JSONObject take(Context c, String person) throws IOException, JSONException {
        synchronized (Gateway.class) {
            if (c.getSystemService(KeyguardManager.class).isDeviceLocked()) return new JSONObject();
            String raw = ShellStore.get(c, PENDING);
            if (raw == null) return new JSONObject();
            JSONObject p = new JSONObject(raw);
            if (!SurfacePolicy.fresh(p.optLong("boot", -2), boot(c), p.optLong("elapsed", -1), SystemClock.elapsedRealtime())
                || !p.optString("person").equals(person) || !p.optString("device").equals(ShellStore.get(c, ShellStore.DEVICE))) {
                clearPending(c); return new JSONObject();
            }
            // Loads/rotates the Keystore-backed credential BEFORE validating current server state.
            JSONObject day = current(c, person);
            String action = p.getString("action");
            clearPending(c);
            if (!action.equals(SurfacePolicy.primary(day.optString("state"), day.optBoolean("attendanceEnabled")))) return new JSONObject();
            return new JSONObject().put("action", action).put("personId", person);
        }
    }
    static JSONObject current(Context c, String person) throws IOException, JSONException {
        synchronized (Gateway.class) {
            if (person == null || !person.equals(ShellStore.get(c, ShellStore.PERSON))) throw new Gateway.Revoked();
            JSONObject day;
            try { day = Gateway.get("companion", Gateway.accessToken(c)); }
            catch (Gateway.Failed e) { if (e.status == 401) { Gateway.forget(c); throw new Gateway.Revoked(); } throw e; }
            JSONObject who = day.optJSONObject("person");
            if (who == null || !person.equals(who.optString("id"))) { Gateway.forget(c); throw new Gateway.Revoked(); }
            JSONObject s = new JSONObject().put("state", day.optBoolean("attendanceEnabled") ? day.optString("state", "unknown") : "unavailable")
                .put("enabled", day.optBoolean("attendanceEnabled")).put("updated", day.optString("now"))
                .put("person", person).put("device", ShellStore.get(c, ShellStore.DEVICE))
                .put("boot", boot(c)).put("elapsed", SystemClock.elapsedRealtime());
            // POLISH-1: what the widget shows beside the status: the session (time worked as of this read, never a
            // running timer), the shift and the next one, on the organisation's clock.
            s.put("today", day.optString("today")).put("offset", day.optInt("utcOffsetMinutes", 330));
            JSONObject shift = day.optJSONObject("shift"), entry = day.optJSONObject("entry"), next = day.optJSONObject("nextShift");
            if (shift != null) s.put("shiftStart", shift.optString("start")).put("shiftEnd", shift.optString("end"));
            if (entry != null && day.optBoolean("attendanceEnabled")) s.put("entryDate", entry.optString("date")).put("in", entry.optString("in"))
                .put("out", entry.isNull("out") ? "" : entry.optString("out")).put("closedBreak", entry.optLong("closedBreakSeconds"))
                .put("breakStarted", entry.isNull("breakStartedAt") ? "" : entry.optString("breakStartedAt"));
            if (next != null) s.put("nextDate", next.optString("date")).put("nextStart", next.optString("start"));
            ShellStore.put(c, KEY, s.toString()); render(c);
            return day;
        }
    }
    static void clearPending(Context c) { ShellStore.put(c, PENDING, "{}"); }
    static boolean ribbon(Context c) { return "on".equals(ShellStore.get(c, RIBBON)); }
    static synchronized void chooseRibbon(Context c, boolean enabled) {
        ShellStore.put(c, RIBBON, enabled ? "on" : "off"); render(c);
    }
    static synchronized void clear(Context c) {
        NotificationManagerCompat.from(c).cancel(NOTIFICATION);
        renderWidget(c);
    }
    static void render(Context c) { renderWidget(c); renderRibbon(c); }
    /** Both widget sizes (small 2×1, medium 3×2), each drawn for the size the launcher gives it. */
    static synchronized void renderWidget(Context c) {
        JSONObject s = read(c);
        AppWidgetManager manager = AppWidgetManager.getInstance(c);
        for (Class<?> kind : new Class<?>[] { AttendanceWidget.class, AttendanceWidgetSmall.class })
            for (int id : manager.getAppWidgetIds(new ComponentName(c, kind))) manager.updateAppWidget(id, view(c, s, small(manager, id, kind)));
    }
    /** A launcher reports the size it gave the widget; without one, each kind keeps its own size. */
    static boolean small(AppWidgetManager manager, int id, Class<?> kind) {
        Bundle size = manager.getAppWidgetOptions(id);
        int width = size == null ? 0 : size.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0), height = size == null ? 0 : size.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        if (width <= 0 || height <= 0) return kind == AttendanceWidgetSmall.class;
        return width < 180 || height < 100;
    }
    static long instant(String iso) {
        if (iso == null || iso.isEmpty()) return -1;
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" }) {
            try {
                java.text.SimpleDateFormat parser = new java.text.SimpleDateFormat(pattern, java.util.Locale.US);
                parser.setTimeZone(java.util.TimeZone.getTimeZone("UTC")); parser.setLenient(false);
                return parser.parse(iso).getTime();
            } catch (java.text.ParseException ignored) {}
        }
        return -1;
    }
    /** "17:46" on the organisation's clock (offset in minutes), whatever the phone's time zone. */
    static String clock(long ms, int offset) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(ms + offset * 60_000L));
    }
    static String dayName(String date, String today) {
        if (date == null || date.isEmpty()) return "";
        if (date.equals(today)) return "today";
        try {
            java.text.SimpleDateFormat parser = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US); parser.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            java.util.Date d = parser.parse(date), t = parser.parse(today);
            if (t != null && d != null && d.getTime() - t.getTime() == 86_400_000L) return "tomorrow";
            if (t != null && d != null && t.getTime() - d.getTime() == 86_400_000L) return "yesterday";
            java.text.SimpleDateFormat out = new java.text.SimpleDateFormat("EEE d MMM", java.util.Locale.ENGLISH); out.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return out.format(d);
        } catch (Exception e) { return date; }
    }
    static RemoteViews view(Context c, JSONObject s, boolean small) {
        boolean valid = fresh(c, s);
        RemoteViews view = new RemoteViews(c.getPackageName(), small ? R.layout.attendance_widget_small : R.layout.attendance_widget);
        String state = s == null ? "" : s.optString("state");
        long updatedAt = s == null ? -1 : instant(s.optString("updated"));
        int offset = s == null ? 330 : s.optInt("offset", 330);
        long in = s == null ? -1 : instant(s.optString("in"));
        boolean open = "in".equals(state) || "break".equals(state);
        boolean forgotten = s != null && open && updatedAt > 0 && SurfacePolicy.forgotten(s.optString("entryDate"), s.optString("today"), s.optString("shiftStart"), s.optString("shiftEnd"), in, updatedAt);
        // Status: what Pulse last confirmed (R21), with the check-in time; a forgotten check-out says so plainly.
        // The small widget says the same in fewer words (its updated line is hidden, so the as-of time sits with the hours).
        String since = s == null ? "" : dayName(s.optString("entryDate"), s.optString("today")) + " " + clock(in, offset);
        // POLISH-2 (QA-E2E P2-6): a break says when the break began, not the check-in ("On a break since 09:58").
        long from = "break".equals(state) && s != null && instant(s.optString("breakStarted")) > 0 ? instant(s.optString("breakStarted")) : in;
        String status = s == null ? (small ? "Open Pulse" : "Open Pulse to sign in")
            : forgotten ? (small ? "Since " + since : "Still checked in since " + since)
            : small ? SurfacePolicy.title(state) + (open && from > 0 ? " · " + clock(from, offset) : "")
            : "Last confirmed: " + SurfacePolicy.title(state) + (open && from > 0 ? " since " + clock(from, offset) : "");
        view.setTextViewText(R.id.attendance_status, status);
        // Time worked today, as of that confirmation (no timer runs on the home screen).
        String worked = "";
        if (forgotten) worked = small ? "Still checked in" : "Check out at the right time?";
        else if (s != null && in > 0 && (open || "done".equals(state)) && updatedAt > 0) {
            long seconds = SurfacePolicy.worked(in, instant(s.optString("out")), s.optLong("closedBreak"), instant(s.optString("breakStarted")), updatedAt);
            worked = SurfacePolicy.words(seconds) + (small ? "" : " worked") + (open ? " by " + clock(updatedAt, offset) : " today");
        }
        view.setTextViewText(R.id.attendance_worked, worked);
        view.setViewVisibility(R.id.attendance_worked, worked.isEmpty() ? View.GONE : View.VISIBLE);
        String next = s == null || s.optString("nextDate").isEmpty() || open ? "" : "Next shift " + dayName(s.optString("nextDate"), s.optString("today")) + ", " + s.optString("nextStart");
        view.setTextViewText(R.id.attendance_next, next);
        view.setViewVisibility(R.id.attendance_next, next.isEmpty() || small ? View.GONE : View.VISIBLE);
        String stamp = updatedAt > 0 ? new java.text.SimpleDateFormat("MMM d, HH:mm", java.util.Locale.getDefault()).format(new java.util.Date(updatedAt)) : "unknown";
        String updated = s == null ? "No saved status" : "Updated " + stamp;
        view.setTextViewText(R.id.attendance_updated, updated + (valid ? " · Open to refresh" : " · Stale, open to refresh"));
        // One action, always confirmed in Pulse. A forgotten check-out opens Pulse to send the right time instead.
        String action = valid && !forgotten ? SurfacePolicy.primary(state, s.optBoolean("enabled")) : "open";
        String known = s == null || forgotten ? "open" : SurfacePolicy.primary(state, s.optBoolean("enabled"));
        String label = forgotten ? (small ? "Fix time" : "Fix the check-out") : "check-in".equals(action) ? "Check in" : "check-out".equals(action) ? "Check out"
            : "check-in".equals(known) ? (small ? "Check in" : "Open to check in") : "check-out".equals(known) ? (small ? "Check out" : "Open to check out") : small ? "Open" : "Open Workspace";
        view.setTextViewText(R.id.attendance_primary, label);
        view.setOnClickPendingIntent(R.id.attendance_primary, tap(c, action));
        view.setOnClickPendingIntent(R.id.attendance_root, tap(c, "open"));
        return view;
    }
    static boolean ribbonAllowed(Context c) {
        if (!Notifier.enabled(c)) return false;
        if (Build.VERSION.SDK_INT < 26) return true;
        NotificationChannel channel = c.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static synchronized void renderRibbon(Context c) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(c);
        JSONObject s = read(c);
        if (!ribbon(c) || !ribbonAllowed(c) || !fresh(c, s)) { manager.cancel(NOTIFICATION); return; }
        NotificationManager nativeManager = c.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Attendance shortcuts", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Optional, dismissible shortcuts to confirm attendance in Pulse."); channel.setShowBadge(false);
            nativeManager.createNotificationChannel(channel);
        }
        Intent dismiss = new Intent(c, AttendanceWidget.class).setAction(AttendanceWidget.DISMISS);
        PendingIntent deleted = PendingIntent.getBroadcast(c, 2101, dismiss, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pulse).setContentTitle("Pulse Workspace")
            .setContentText("Attendance shortcuts · Open to confirm")
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(new NotificationCompat.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_stat_pulse)
                .setContentTitle("Pulse Workspace").setContentText("Open Workspace").setContentIntent(tap(c, "open")).build()).setOnlyAlertOnce(true).setAutoCancel(false).setOngoing(false)
            .setContentIntent(tap(c, "open")).setDeleteIntent(deleted);
        String action = SurfacePolicy.primary(s.optString("state"), s.optBoolean("enabled"));
        if (!"open".equals(action)) b.addAction(0, "check-in".equals(action) ? "Check in" : "Done / check out", tap(c, action));
        b.addAction(0, "Open Workspace", tap(c, "open"));
        try { manager.notify(NOTIFICATION, b.build()); } catch (SecurityException ignored) {}
    }
}
