package com.pulse.work.mobile;

import android.content.Context;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;

/**
 * CALLS-NATIVE: this phone's push token reaches Pulse by itself (no page needed): on app start, after this phone is
 * registered to someone (sign-in) and whenever Firebase renews it. Signing out revokes the device on the server
 * (its token goes with it) and deletes the token here. Without the owner's google-services.json Firebase is not set
 * up in the build and nothing happens: calls then ring only while Pulse is open.
 */
final class CallPush {

    private CallPush() {}

    static boolean available(Context context) {
        try {
            return !com.google.firebase.FirebaseApp.getApps(context).isEmpty();
        } catch (Throwable e) {
            return false;
        }
    }

    static void register(Context context) {
        Context app = context.getApplicationContext();
        if (!ShellStore.enrolled(app) || !available(app)) return;
        try {
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> send(app, token));
        } catch (Throwable ignored) {
            // Firebase not set up in this build.
        }
    }

    static void send(Context app, String token) {
        if (token == null || token.isEmpty()) return;
        CallRinger.worker().post(() -> {
            try {
                if (!ShellStore.enrolled(app)) return;
                String device = ShellStore.get(app, ShellStore.DEVICE);
                if (device == null) return;
                if (token.equals(ShellStore.plain(app, "push")) && device.equals(ShellStore.plain(app, "pushDevice"))) return;
                Gateway.post("devices/" + device + "/push", new JSONObject().put("token", token), Gateway.accessToken(app));
                ShellStore.plain(app, "push", token);
                ShellStore.plain(app, "pushDevice", device);
            } catch (Exception ignored) {
                // Offline or signed out: the next app start tries again.
            }
        });
    }

    static void unregister(Context context) {
        ShellStore.plain(context, "push", null);
        ShellStore.plain(context, "pushDevice", null);
        if (!available(context)) return;
        try {
            FirebaseMessaging.getInstance().deleteToken();
        } catch (Throwable ignored) {
            // Firebase not set up in this build.
        }
    }
}
