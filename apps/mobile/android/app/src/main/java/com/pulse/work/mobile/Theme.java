package com.pulse.work.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Status and navigation bars follow Pulse's theme (the page reports its light/dark choice through the bridge). */
final class Theme {
    static final int LIGHT_CANVAS = 0xFFF6F6FA;
    static final int DARK_CANVAS = 0xFF121219;
    static volatile boolean chosenByPage = false;

    private Theme() {}

    static boolean systemDark(Context context) {
        return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    static int canvas(Context context, boolean dark) {
        return dark ? DARK_CANVAS : LIGHT_CANVAS;
    }

    /** Light bars get dark icons and the reverse; the window behind the bars is Pulse's canvas colour. */
    static void apply(Activity activity, boolean dark) {
        activity.getWindow().setBackgroundDrawable(new ColorDrawable(dark ? DARK_CANVAS : LIGHT_CANVAS));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
    }
}
