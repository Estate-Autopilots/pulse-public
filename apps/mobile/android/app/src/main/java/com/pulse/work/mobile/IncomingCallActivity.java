package com.pulse.work.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.lang.ref.WeakReference;

/**
 * CALLS-NATIVE: the full-screen ring, over the lock screen: who is calling, voice or video, Decline and Answer, like a
 * phone call. Drawn in code (no web view: it shows instantly, even before Pulse has loaded). Answer opens the call in
 * Pulse (the page answers it); on a locked phone Pulse then shows over the lock screen for the call (MainActivity).
 */
public class IncomingCallActivity extends Activity {

    private String call;
    private boolean test;
    private String href;

    String call() {
        return call;
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        bind(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bind(intent);
    }

    private void bind(Intent intent) {
        call = intent.getStringExtra(CallRinger.EXTRA_CALL);
        test = intent.getBooleanExtra(CallRinger.EXTRA_TEST, false);
        href = intent.getStringExtra(CallRinger.EXTRA_HREF);
        if (!RingPolicy.validId(call) || !CallRinger.isRinging(call)) { finish(); return; }
        CallRinger.screen = new WeakReference<>(this);
        String who = intent.getStringExtra(CallRinger.EXTRA_CALLER);
        boolean video = intent.getBooleanExtra(CallRinger.EXTRA_VIDEO, false);
        setContentView(layout(who == null ? "Someone" : who, test ? "Pulse test call" : video ? "Pulse video call" : "Pulse voice call"));
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private View layout(String who, String what) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xFF121219);
        root.setPadding(dp(24), dp(96), dp(24), dp(64));

        TextView initial = new TextView(this);
        initial.setText(who.isEmpty() ? "?" : who.substring(0, 1).toUpperCase());
        initial.setTextColor(Color.WHITE);
        initial.setTextSize(TypedValue.COMPLEX_UNIT_SP, 40);
        initial.setGravity(Gravity.CENTER);
        GradientDrawable avatar = new GradientDrawable();
        avatar.setShape(GradientDrawable.OVAL);
        avatar.setColor(0xFF5B45D6);
        initial.setBackground(avatar);
        root.addView(initial, new LinearLayout.LayoutParams(dp(112), dp(112)));

        TextView name = new TextView(this);
        name.setText(who);
        name.setTextColor(Color.WHITE);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = dp(24);
        root.addView(name, nameLp);

        TextView sub = new TextView(this);
        sub.setText(what);
        sub.setTextColor(0xB3FFFFFF);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(8);
        root.addView(sub, subLp);

        View space = new View(this);
        root.addView(space, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(button("Decline", 0xFFE5484D, v -> decline()), weight());
        buttons.addView(button("Answer", 0xFF22B35E, v -> answer()), weight());
        root.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return root;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(dp(12), 0, dp(12), 0);
        return lp;
    }

    private Button button(String label, int color, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setMinHeight(dp(64));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(32));
        bg.setColor(color);
        b.setBackground(bg);
        b.setContentDescription(label + " call");
        b.setOnClickListener(click);
        return b;
    }

    private void decline() {
        CallRinger.stop(this, call);
        if (!test) CallAction.decline(getApplicationContext(), call, null);
        finish();
    }

    private void answer() {
        CallRinger.stop(this, call);
        Intent open = CallRinger.answerIntent(this, call, RingPolicy.answerHref(href));
        // On a locked phone: Pulse opens over the lock screen for the call; unlocking is asked only if needed after.
        startActivity(open);
        if (Build.VERSION.SDK_INT >= 26) {
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            if (km != null && km.isKeyguardLocked() && test) km.requestDismissKeyguard(this, null);
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        if (CallRinger.screen.get() == this) CallRinger.screen = new WeakReference<>(null);
        super.onDestroy();
    }
}
