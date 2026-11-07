package com.pulse.work.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android-only thin surface bridge; browser/iOS and older shells feature-detect its absence. */
@CapacitorPlugin(name = "PulseAttendance")
public class AttendancePlugin extends Plugin {
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    @PluginMethod public void refresh(PluginCall call) {
        WORK.execute(() -> {
            try { AttendanceSurfaces.current(getContext(), call.getString("personId")); call.resolve(); }
            catch (Exception e) { call.reject("Open My desk when connected to refresh attendance shortcuts.", "unavailable"); }
        });
    }
    @PluginMethod public void takeAction(PluginCall call) {
        WORK.execute(() -> {
            try { call.resolve(new JSObject(AttendanceSurfaces.take(getContext(), call.getString("personId")).toString())); }
            catch (Exception e) { call.reject("Connect and sign in before confirming this attendance action.", "unavailable"); }
        });
    }
    @PluginMethod public void ribbon(PluginCall call) {
        WORK.execute(() -> {
            try {
                Boolean enabled = call.getBoolean("enabled");
                if (enabled != null) AttendanceSurfaces.chooseRibbon(getContext(), enabled);
                JSObject out = new JSObject(); out.put("enabled", AttendanceSurfaces.ribbon(getContext()));
                out.put("permission", AttendanceSurfaces.ribbonAllowed(getContext())); call.resolve(out);
            } catch (Exception e) { call.reject("Could not save attendance shortcut choice.", "storage"); }
        });
    }
}
