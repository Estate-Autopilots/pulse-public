package com.pulse.work.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.io.File;

/**
 * Uploads: an image field offers the camera next to Photos and Files in one chooser. The camera app takes the
 * picture, so Pulse never asks for camera permission. Other fields use Capacitor's file picker.
 * POLISH-2 (QA-E2E P1-15): WebView's own picker intent asks only for the field's first type, so a field accepting
 * "application/pdf,image/*" (ID documents, task proof) offered Files with PDFs and no gallery. The picker now asks for
 * every accepted type, so a photo already in the gallery can be chosen there too.
 */
final class ShellChromeClient extends BridgeWebChromeClient {

    private final MainActivity activity;
    private ValueCallback<Uri[]> pending;

    ShellChromeClient(Bridge bridge, MainActivity activity) {
        super(bridge);
        this.activity = activity;
    }

    private static boolean acceptsImages(FileChooserParams params) {
        String[] types = UploadTypes.mimeTypes(params.getAcceptTypes());
        if (types.length == 0) return true;
        for (String t : types) if (t.startsWith("image/")) return true;
        return false;
    }

    /** Files, Photos and the gallery for every accepted type: one type sets it, several go in EXTRA_MIME_TYPES. */
    static Intent pickIntent(String[] accept) {
        String[] types = UploadTypes.mimeTypes(accept);
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE);
        if (types.length == 1) pick.setType(types[0]);
        else {
            pick.setType("*/*");
            if (types.length > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
        }
        return pick;
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (params.isCaptureEnabled() || !acceptsImages(params)) return super.onShowFileChooser(webView, callback, params);
        if (pending != null) pending.onReceiveValue(null);
        pending = callback;
        Intent pick = pickIntent(params.getAcceptTypes());
        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        Intent chooser = Intent.createChooser(pick, "Add a photo or file");
        Uri photo = null;
        try {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
            File file = File.createTempFile("Pulse_", ".jpg", dir);
            photo = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, photo)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            camera.setClipData(ClipData.newRawUri("Pulse photo", photo));
            if (camera.resolveActivity(activity.getPackageManager()) != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
            else photo = null;
        } catch (Exception e) {
            photo = null;
        }
        final Uri taken = photo;
        try {
            activity.launchChooser(chooser, result -> {
                Uri[] uris = null;
                if (result.getResultCode() == Activity.RESULT_OK) {
                    Intent data = result.getData();
                    if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0 && data.getData() == null) {
                        ClipData clip = data.getClipData();
                        uris = new Uri[clip.getItemCount()];
                        for (int i = 0; i < clip.getItemCount(); i++) uris[i] = clip.getItemAt(i).getUri();
                    } else if (data != null && data.getData() != null) {
                        uris = new Uri[] { data.getData() };
                    } else if (taken != null) {
                        uris = new Uri[] { taken };
                    }
                }
                ValueCallback<Uri[]> done = pending;
                pending = null;
                if (done != null) done.onReceiveValue(uris);
            });
        } catch (Exception e) {
            pending = null;
            callback.onReceiveValue(null);
        }
        return true;
    }
}
