package com.pulse.work.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The device credential in Keystore-backed storage: values are AES-GCM encrypted with a non-exportable Android
 * Keystore key. App data is excluded from backups, so a restored copy can never carry a usable credential.
 */
final class ShellStore {

    private static final String KEY_ALIAS = "pulse_shell_device_v1";
    private static final String PREFS = "pulse_shell";
    static final String REFRESH = "refresh";
    static final String DEVICE = "device";
    static final String PERSON = "person";

    private ShellStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    static synchronized void put(Context context, String name, String value) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String packed = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            if (!prefs(context).edit().putString(name, packed).commit()) throw new IllegalStateException("Could not save");
        } catch (Exception e) {
            throw new IllegalStateException("Secure storage unavailable", e);
        }
    }

    static synchronized String get(Context context, String name) {
        String packed = prefs(context).getString(name, null);
        if (packed == null) return null;
        try {
            String[] parts = packed.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // A value that cannot be opened (key lost, restored data) is treated as signed out.
            prefs(context).edit().remove(name).commit();
            return null;
        }
    }

    static boolean enrolled(Context context) {
        return prefs(context).contains(REFRESH) && prefs(context).contains(DEVICE);
    }

    /** Non-secret bookkeeping (the inbox cursor, the downloaded update) lives beside the sealed values. */
    static String plain(Context context, String name) {
        return prefs(context).getString("plain." + name, null);
    }

    static void plain(Context context, String name, String value) {
        if (value == null) prefs(context).edit().remove("plain." + name).apply();
        else prefs(context).edit().putString("plain." + name, value).apply();
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().clear().commit();
    }
}
