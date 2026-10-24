package com.pulse.work.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Pulse for Android: the production Pulse web app in a native window. The shell adds what a browser cannot do —
 * Android back, the offline screen, Pulse links, downloads, uploads from the camera, notifications and updates.
 */
public class MainActivity extends BridgeActivity {

    static final String HOST = "pulse.estateautopilots.com";
    static final String ORIGIN = "https://" + HOST;
    static final String EXTRA_HREF = "pulse.href";
    static final String EXTRA_ASK = "pulse.ask";
    private static final int ASK_NOTIFICATIONS = 4701;
    static volatile boolean foreground = false;

    private ActivityResultLauncher<Intent> chooser;
    private ActivityResultCallback<ActivityResult> chooserResult;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PulseShellPlugin.class);
        registerPlugin(AttendancePlugin.class);
        // Registered before the activity starts; ShellChromeClient uses it for "Camera, Photos or Files".
        chooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ActivityResultCallback<ActivityResult> done = chooserResult;
            chooserResult = null;
            if (done != null) done.onActivityResult(result);
        });
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        // POLISH-1: Pulse draws edge to edge on every Android version, as Android 15 already requires. Before, Android 14
        // and older padded the window under the status bar and the page added the inset again (an empty band above the
        // header on the owner's Android 13 phone). Now the page's own header sits under a transparent status bar, so its
        // colour runs to the top; the page pads by env(safe-area-inset-*) exactly once. After BridgeActivity has set its
        // theme and content, so the launch theme is never kept.
        EdgeToEdge.enable(this);
        WebView web = getBridge().getWebView();
        WebSettings settings = web.getSettings();
        // Large system text is honoured a little, never enough to break Pulse's layouts.
        settings.setTextZoom(Math.min(115, Math.max(100, Math.round(getResources().getConfiguration().fontScale * 100))));
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        web.setBackgroundColor(Theme.canvas(this, Theme.systemDark(this)));
        web.setOverScrollMode(WebView.OVER_SCROLL_IF_CONTENT_SCROLLS);
        getBridge().setWebViewClient(new ShellWebViewClient(getBridge()));
        web.setWebChromeClient(new ShellChromeClient(getBridge(), this));
        web.setDownloadListener(new ShellDownloads(this, web));
        Theme.apply(this, Theme.systemDark(this));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                back();
            }
        });
        Notifier.channels(this);
        if (ShellStore.enrolled(this)) { InboxWorker.schedule(this); OfficeArrival.sync(this); }
        // Capacitor records the first intent but does not navigate to it. App Links and notification taps must
        // also open their target when Android creates the activity, not just when it reuses a running one.
        open(getIntent());
    }

    void launchChooser(Intent intent, ActivityResultCallback<ActivityResult> done) {
        chooserResult = done;
        chooser.launch(intent);
    }

    /** Android back: close the page's open sheet, then go back through Pulse, and at the start minimise. */
    private void back() {
        WebView web = getBridge().getWebView();
        web.evaluateJavascript("(function(){try{return !!(window.__pulseBack&&window.__pulseBack())}catch(e){return false}})()", handled -> {
            if ("true".equals(handled)) return;
            String url = web.getUrl();
            if (url != null && url.startsWith("https://localhost/")) {
                moveTaskToBack(true);
            } else if (web.canGoBack()) {
                web.goBack();
            } else {
                moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent);
    }

    /** A Pulse link (App Link) or a tapped notification opens its page inside the app. */
    private void open(Intent intent) {
        if (intent == null || getBridge() == null) return;
        AttendanceSurfaces.accept(this, intent);
        // The same notification permission flow as Settings → Notifications → Turn on (used by the emulator acceptance).
        if ("notifications".equals(intent.getStringExtra(EXTRA_ASK))) {
            intent.removeExtra(EXTRA_ASK);
            askNotifications();
        }
        String target = null;
        String href = intent.getStringExtra(EXTRA_HREF);
        if (href != null && href.startsWith("/") && !href.startsWith("//")) target = ORIGIN + href;
        Uri data = intent.getData();
        if (target == null && data != null && "https".equals(data.getScheme()) && HOST.equals(data.getHost())) target = data.toString();
        if (target == null) return;
        intent.removeExtra(EXTRA_HREF);
        intent.setData(null);
        getBridge().getWebView().loadUrl(target);
    }

    void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_NOTIFICATIONS);
        } else {
            Notifier.confirm(this);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == ASK_NOTIFICATIONS && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) Notifier.confirm(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    public void onPause() {
        foreground = false;
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (getBridge() != null && !Theme.chosenByPage) {
            boolean dark = Theme.systemDark(this);
            getBridge().getWebView().setBackgroundColor(Theme.canvas(this, dark));
            Theme.apply(this, dark);
        }
    }
}
