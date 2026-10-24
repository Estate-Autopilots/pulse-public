package com.pulse.work.mobile;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

/** This installation's version, read from the package (no generated BuildConfig needed). */
final class Shell {

    private static String version = "1.1.4";
    private static long code = 1001004;

    private Shell() {}

    static void init(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            version = info.versionName;
            code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (PackageManager.NameNotFoundException ignored) {}
    }

    static String version() {
        return version;
    }

    static long code() {
        return code;
    }

    /** "Pulse app · Redmi M1906G7G": how the phone appears in Settings → Devices. */
    static String deviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "phone" : Build.MODEL;
        String name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker + " " + model).trim();
        name = name.isEmpty() ? "Android phone" : Character.toUpperCase(name.charAt(0)) + name.substring(1);
        String label = "Pulse app · " + name;
        return label.length() > 80 ? label.substring(0, 80) : label;
    }
}
