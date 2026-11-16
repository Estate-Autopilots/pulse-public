package com.pulse.work.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.lang.ref.WeakReference;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * CALLS-NATIVE: a Pulse call rings this phone like a phone call, with Pulse closed or the phone locked. A ring arrives
 * as a high-priority FCM data message (CallPushService) and shows on the Calls channel full screen (Android 14 asks
 * the person once: Settings → Calls ring), with the phone's ringtone repeating until it is answered, declined or over.
 * Answer opens the call in Pulse (the page answers it: answer=1); Decline tells Pulse with the phone's own credential.
 * The ring stops on a "stop" push (answered on another device, the caller hung up), when Pulse says it no longer rings
 * for this person (asked every 3 s while it rings), or after its time (45 s at most). Calls ring only for the person
 * signed in on this phone.
 */
final class CallRinger {

    static final String EXTRA_CALL = "pulse.call";
    static final String EXTRA_CALLER = "pulse.caller";
    static final String EXTRA_VIDEO = "pulse.video";
    static final String EXTRA_TEST = "pulse.test";
    static final String EXTRA_HREF = MainActivity.EXTRA_HREF;
    static final String EXTRA_UNTIL = "pulse.until";
    private static final int ID = 7101;

    private static final Map<String, Long> ringing = new ConcurrentHashMap<>();
    private static HandlerThread thread;
    private static Handler worker;
    static WeakReference<Activity> screen = new WeakReference<>(null);

    private CallRinger() {}

    /** What one push asks for. Data keys: pulseType, notificationId, callId, title, caller, href, expiresAt, video. */
    static void handle(Context context, Map<String, String> d) {
        String type = d.get("pulseType");
        String call = d.get("callId");
        if (type == null) return;
        switch (type) {
            case "call.call":
            case "call.test":
                if (call == null || !RingPolicy.validId(call)) return;
                // A ring for someone else (this phone was signed out and in again) is not shown.
                ring(context, call, d.get("caller"), d.get("title"), "1".equals(d.get("video")), "call.test".equals(type),
                    RingPolicy.href(d.get("href"), call, "call.test".equals(type)), RingPolicy.until(d.get("expiresAt"), System.currentTimeMillis()));
                break;
            case "call.stop":
                if (call != null) stop(context, call);
                break;
            case "call.missed":
                Notifier.post(context, d.get("notificationId"), d.get("title"), "Tap to call back", d.get("href"), "chat.missed_call");
                break;
            default:
        }
    }

    static String tag(String call) {
        return "call-" + call;
    }

    static boolean isRinging(String call) {
        Long until = ringing.get(call);
        return until != null && until > System.currentTimeMillis();
    }

    static synchronized Handler worker() {
        if (worker == null) {
            thread = new HandlerThread("pulse-call-ring");
            thread.start();
            worker = new Handler(thread.getLooper());
        }
        return worker;
    }

    static void ring(Context context, String call, String caller, String title, boolean video, boolean test, String href, long until) {
        Context app = context.getApplicationContext();
        long now = System.currentTimeMillis();
        if (until <= now + 1000 || ringing.containsKey(call) || !Notifier.enabled(app)) return;
        // Pulse open in front rings the call itself (its own incoming-call screen): no second ring on top of it.
        if (MainActivity.foreground && !test) return;
        Notifier.channels(app);
        ringing.put(call, until);
        String who = caller != null && !caller.isEmpty() ? caller : title != null && !title.isEmpty() ? title : "Someone";
        String what = test ? "Pulse test call" : video ? "Pulse video call" : "Pulse voice call";

        Intent full = new Intent(app, IncomingCallActivity.class).setAction("com.pulse.work.mobile.RING." + call)
            .putExtra(EXTRA_CALL, call).putExtra(EXTRA_CALLER, who).putExtra(EXTRA_VIDEO, video).putExtra(EXTRA_TEST, test)
            .putExtra(EXTRA_HREF, href).putExtra(EXTRA_UNTIL, until)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent screenIntent = PendingIntent.getActivity(app, ("ring" + call).hashCode(), full, flags);
        PendingIntent answer = PendingIntent.getActivity(app, ("answer" + call).hashCode(), answerIntent(app, call, RingPolicy.answerHref(href)), flags);
        PendingIntent decline = PendingIntent.getBroadcast(app, ("decline" + call).hashCode(), CallAction.intent(app, CallAction.DECLINE, call, test), flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(app, Notifier.CALLS)
            .setSmallIcon(R.drawable.ic_stat_pulse).setColor(0xFF22B35E)
            .setContentTitle(who).setContentText(what)
            .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true).setAutoCancel(false)
            .setContentIntent(screenIntent).setFullScreenIntent(screenIntent, true)
            .setTimeoutAfter(Math.max(1000, until - now));
        // Android 12+ draws a call's own Decline / Answer buttons (CallStyle), which it allows with a full-screen ring.
        if (Build.VERSION.SDK_INT >= 31 && fullScreenAllowed(app)) {
            b.setStyle(NotificationCompat.CallStyle.forIncomingCall(new androidx.core.app.Person.Builder().setName(who).setImportant(true).build(), decline, answer));
        } else {
            b.addAction(new NotificationCompat.Action.Builder(0, "Decline", decline).build())
             .addAction(new NotificationCompat.Action.Builder(0, "Answer", answer).build());
        }
        Notification n = b.build();
        // The ringtone and the vibration repeat until the ring is answered, declined or over (like a phone call).
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(app).notify(tag(call), ID, n);
        } catch (SecurityException e) {
            ringing.remove(call);
            return;
        }
        wake(app);
        if (!test) watch(app, call, until);
        else worker().postDelayed(() -> stop(app, call), Math.max(0, until - now));
    }

    static Intent answerIntent(Context context, String call, String href) {
        return new Intent(context, MainActivity.class).setAction("com.pulse.work.mobile.ANSWER." + call)
            .putExtra(MainActivity.EXTRA_HREF, href).putExtra(EXTRA_CALL, call)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    /** Turn the screen on for a moment so the full-screen ring shows on a phone lying dark on a desk. */
    @SuppressWarnings("deprecation")
    private static void wake(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isInteractive()) return;
            PowerManager.WakeLock lock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "pulse:ring");
            lock.acquire(5000);
        } catch (Exception ignored) {}
    }

    /** Ask Pulse every 3 s whether this call still rings for this person; stop when not, or when its time is up. */
    private static void watch(Context app, String call, long until) {
        Handler h = worker();
        h.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!ringing.containsKey(call)) return;
                if (System.currentTimeMillis() >= until) { stop(app, call); return; }
                Boolean still = stillRinging(app, call);
                if (Boolean.FALSE.equals(still)) { stop(app, call); return; }
                h.postDelayed(this, 3000);
            }
        }, 3000);
    }

    /** True or false from Pulse; null when Pulse could not be asked (keep ringing until its time). */
    static Boolean stillRinging(Context context, String call) {
        try {
            if (!ShellStore.enrolled(context)) return false;
            JSONObject r = Gateway.get("calls/" + call + "/ring", Gateway.accessToken(context));
            return r.optBoolean("ringing", false);
        } catch (Gateway.Revoked e) {
            return false;
        } catch (Gateway.Failed e) {
            return e.status == 403 || e.status == 404 ? Boolean.FALSE : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** The ring is over here: the notification, the sound and the ring screen go. */
    static void stop(Context context, String call) {
        ringing.remove(call);
        try { NotificationManagerCompat.from(context).cancel(tag(call), ID); } catch (Exception ignored) {}
        Activity a = screen.get();
        if (a instanceof IncomingCallActivity && call.equals(((IncomingCallActivity) a).call())) a.runOnUiThread(a::finish);
    }

    /** Settings → Calls ring: the Calls channel rings ("on"), is silent, or is switched off. */
    static String channelState(Context context) {
        if (Build.VERSION.SDK_INT < 26) return Notifier.enabled(context) ? "on" : "off";
        NotificationManager m = context.getSystemService(NotificationManager.class);
        NotificationChannel c = m == null ? null : m.getNotificationChannel(Notifier.CALLS);
        if (c == null) return "on";
        if (c.getImportance() == NotificationManager.IMPORTANCE_NONE) return "off";
        return c.getImportance() < NotificationManager.IMPORTANCE_HIGH || c.getSound() == null ? "silent" : "on";
    }

    /** Android 14+: whether a call may fill the locked screen (granted by the person in Settings). */
    static boolean fullScreenAllowed(Context context) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager m = context.getSystemService(NotificationManager.class);
        return m != null && m.canUseFullScreenIntent();
    }
}
