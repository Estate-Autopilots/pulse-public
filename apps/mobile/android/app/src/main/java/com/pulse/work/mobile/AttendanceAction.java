package com.pulse.work.mobile;

import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * PRESENCE-ONBOARD: one tap on a Pulse attendance notification ("You're at the office. Check in?", "Ready to check
 * in?", "Still on your break?", "Done for the day?"). The action carries this installation's sealed nonce, works only
 * on an unlocked phone, rechecks the signed-in person and device, and posts with an idempotent id derived from the
 * notification, so a double tap or a retry is one check-in. The server still refuses a double check-in. Anything that
 * cannot complete here opens My desk instead, where the same action is one tap.
 */
public class AttendanceAction extends BroadcastReceiver {
    static final String ACTION = "com.pulse.work.mobile.ATTENDANCE_ACTION";
    static final String EXTRA_ACTION = "pulse.attendance.action";
    static final String EXTRA_ID = "pulse.attendance.notification";
    static final String EXTRA_NONCE = "pulse.attendance.nonce";
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();

    /** The notification action's intent: explicit, immutable, sealed with this installation's nonce. */
    static PendingIntent intent(Context c, String action, String notification) {
        Intent i = new Intent(c, AttendanceAction.class).setAction(ACTION + "." + action + "." + notification).setPackage(c.getPackageName())
            .putExtra(EXTRA_ACTION, action).putExtra(EXTRA_ID, notification).putExtra(EXTRA_NONCE, AttendanceSurfaces.nonce(c));
        return PendingIntent.getBroadcast(c, (action + notification).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static String path(String action) {
        switch (action) {
            case "check-in": return "attendance/check-in";
            case "check-out": return "attendance/check-out";
            case "break-end": return "attendance/break";
            default: return null;
        }
    }

    @Override
    public void onReceive(Context context, Intent i) {
        Context c = context.getApplicationContext();
        Shell.init(c);
        String action = i.getStringExtra(EXTRA_ACTION), id = i.getStringExtra(EXTRA_ID), nonce = i.getStringExtra(EXTRA_NONCE);
        if (action == null || id == null || nonce == null || !nonce.equals(ShellStore.get(c, AttendanceSurfaces.NONCE)) || path(action) == null) return;
        PendingResult done = goAsync();
        WORK.execute(() -> {
            try {
                KeyguardManager keyguard = c.getSystemService(KeyguardManager.class);
                if (keyguard != null && keyguard.isDeviceLocked()) { open(c, id); return; }
                String person = ShellStore.get(c, ShellStore.PERSON);
                JSONObject day = AttendanceSurfaces.current(c, person);   // rechecks the device and the person
                if (!day.optBoolean("attendanceEnabled")) { open(c, id); return; }
                String state = day.optString("state");
                boolean fits = "check-in".equals(action) ? ("out".equals(state) || "done".equals(state)) : "break-end".equals(action) ? "break".equals(state) : ("in".equals(state) || "break".equals(state));
                if (!fits) { Notifier.attendanceDone(c, id, "in".equals(state) ? "You’re already checked in" : "Nothing to do: Pulse is up to date", null); return; }
                String queue = ("n-" + action + "-" + id).replaceAll("[^A-Za-z0-9-]", "");
                if (queue.length() > 64) queue = queue.substring(0, 64);
                JSONObject body = new JSONObject().put("via", "mobile").put("trigger", "notification").put("expectedPersonId", person).put("queueId", queue);
                if ("break-end".equals(action)) body.put("action", "end");
                Gateway.post(path(action), body, Gateway.accessToken(c));
                JSONObject after = AttendanceSurfaces.current(c, person);
                JSONObject entry = after.optJSONObject("entry");
                String at = entry == null ? null : Notifier.clock("check-out".equals(action) ? entry.optString("out") : entry.optString("in"), after.optInt("utcOffsetMinutes", 330));
                Notifier.attendanceDone(c, id, "check-in".equals(action) ? "Checked in" + (at != null ? " at " + at : "") : "break-end".equals(action) ? "Welcome back" : "Checked out" + (at != null ? " at " + at : ""),
                    "check-in".equals(action) ? "Not right? Open your day in Pulse." : null);
            } catch (Exception e) {
                open(c, id);
            } finally { done.finish(); }
        });
    }

    /** Fall back to My desk, where the same action is one tap. */
    private static void open(Context c, String id) {
        Notifier.attendanceDone(c, id, "Open Pulse to finish", "Tap to open My desk.");
    }
}
