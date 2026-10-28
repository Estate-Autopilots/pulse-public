package com.pulse.work.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/** CALLS-NATIVE: Decline from the ring (notification or ring screen): stop ringing here and tell Pulse. Explicit only. */
public class CallAction extends BroadcastReceiver {

    static final String DECLINE = "com.pulse.work.mobile.CALL_DECLINE";

    static Intent intent(Context context, String action, String call, boolean test) {
        return new Intent(context, CallAction.class).setAction(action).putExtra(CallRinger.EXTRA_CALL, call).putExtra(CallRinger.EXTRA_TEST, test);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String call = intent.getStringExtra(CallRinger.EXTRA_CALL);
        if (!DECLINE.equals(intent.getAction()) || !RingPolicy.validId(call)) return;
        CallRinger.stop(context, call);
        if (intent.getBooleanExtra(CallRinger.EXTRA_TEST, false)) return;
        decline(context.getApplicationContext(), call, goAsync());
    }

    static void decline(Context app, String call, PendingResult done) {
        CallRinger.worker().post(() -> {
            try {
                if (ShellStore.enrolled(app)) Gateway.post("calls/" + call + "/decline", new JSONObject(), Gateway.accessToken(app));
            } catch (Exception ignored) {
                // Offline: the caller's ring ends by itself after 45 s and reads as missed.
            } finally {
                if (done != null) done.finish();
            }
        });
    }
}
