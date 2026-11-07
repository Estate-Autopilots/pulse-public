package com.pulse.work.mobile;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * CALLS-NATIVE: Pulse's pushes (Firebase Cloud Messaging). A call's ring, stop and missed call are data messages this
 * service handles itself, so the phone rings with Pulse closed; everything else goes on to Capacitor's push plugin as
 * before (work updates arrive as plain notifications Android shows itself). Replaces the plugin's own service
 * (AndroidManifest.xml), which would otherwise receive the messages instead.
 */
public class CallPushService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String type = data.get("pulseType");
        if (type != null && type.startsWith("call.")) {
            CallRinger.handle(this, data);
            return;
        }
        PushNotificationsPlugin.sendRemoteMessage(message);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
        CallPush.send(getApplicationContext(), token);
    }
}
