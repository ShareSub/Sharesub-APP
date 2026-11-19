package ru.sharesub.vpn;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class UpdateManager {
    private static final String SITE = "https://app.sharesub.ru";
    private static final int LIMIT = 256 * 1024 * 1024;
    private static final ExecutorService DOWNLOAD = Executors.newSingleThreadExecutor();
    private static volatile Release release;
    private static volatile String state = "idle";
    private static volatile int progress;
    private static volatile String error;
    private static final String APK = "update.apk";

    private record Release(String version, long code, String url, String hash, long size) {}

    private UpdateManager() {}

    static JSONObject status() throws Exception {
        JSONObject value = new JSONObject().put("state", state);
        Release latest = release;
        if (latest != null) value.put("version", latest.version());
        if (state.equals("downloading")) value.put("progress", progress);
        if (error != null) value.put("error", error);
        return value;
    }

    static synchronized JSONObject check(Context context) throws Exception {
        if (state.equals("downloading") || state.equals("ready")) return status();
        try {
            String body;
            HttpURLConnection connection = open(SITE + "/api/latest.json");
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                byte[] block = new byte[2048];
                for (int count; (count = stream.read(block)) != -1;) {
                    if (buffer.size() + count > 16000) throw new IOException();
                    buffer.write(block, 0, count);
                }
                body = buffer.toString("UTF-8");
            } finally { connection.disconnect(); }
            JSONObject envelope = new JSONObject(body);
            byte[] payload = Base64.decode(envelope.getString("payload"), Base64.DEFAULT);
            byte[] publicKey;
            try (InputStream key = context.getAssets().open("update-public.pem"); ByteArrayOutputStream pem = new ByteArrayOutputStream()) {
                byte[] block = new byte[1024];
                for (int count; (count = key.read(block)) != -1;) pem.write(block, 0, count);
                publicKey = Base64.decode(pem.toString("US-ASCII")
                    .replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", ""), Base64.DEFAULT);
            }
            Signature signature = Signature.getInstance("SHA256withRSA");
            signature.initVerify(KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(publicKey)));
            signature.update(payload);
            if (!signature.verify(Base64.decode(envelope.getString("signature"), Base64.DEFAULT))) throw new IOException();
            JSONObject data = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            String version = data.getString("version");
            long code = data.getLong("androidCode");
            JSONObject file = data.getJSONObject("artifacts").getJSONObject("android");
            String url = file.getString("url");
            String hash = file.getString("sha256");
            long size = file.getLong("size");
            if (!version.matches("\\d{1,5}\\.\\d{1,5}\\.\\d{1,5}") || code <= 0
                || !url.equals(SITE + "/releases/ShareSub-" + version + "-Android.apk") || !hash.matches("[a-f0-9]{64}")
                || size <= 0 || size > LIMIT) throw new IOException();
            release = new Release(version, code, url, hash, size);
            long installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode();
            error = null;
            state = code > installed ? "available" : "current";
        } catch (Exception failure) {
            release = null;
            error = "Не удалось проверить обновления.";
            state = "error";
        }
        return status();
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        if (connection.getResponseCode() != 200) {
            connection.disconnect();
            throw new IOException();
        }
        return connection;
    }

    static synchronized JSONObject download(Context context) throws Exception {
        if (!state.equals("available") && !(state.equals("error") && release != null)) return status();
        error = null;
        progress = 0;
        state = "downloading";
        Release entry = release;
        DOWNLOAD.execute(() -> transfer(context.getApplicationContext(), entry));
        return status();
    }

    private static void transfer(Context context, Release entry) {
        File partial = new File(context.getCacheDir(), APK + ".part");
        File file = file(context);
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            HttpURLConnection connection = open(entry.url());
            long transferred = 0;
            long deadline = android.os.SystemClock.elapsedRealtime() + 10 * 60_000;
            try (InputStream stream = connection.getInputStream(); FileOutputStream result = new FileOutputStream(partial)) {
                byte[] buffer = new byte[65536];
                for (int count; (count = stream.read(buffer)) != -1;) {
                    transferred += count;
                    if (transferred > entry.size() || android.os.SystemClock.elapsedRealtime() > deadline) throw new IOException();
                    hash.update(buffer, 0, count);
                    result.write(buffer, 0, count);
                    progress = (int)(transferred * 100 / entry.size());
                }
            } finally { connection.disconnect(); }
            if (transferred != entry.size() || !hex(hash.digest()).equals(entry.hash()) || !partial.renameTo(file)) throw new IOException();
            state = "ready";
        } catch (Exception failure) {
            partial.delete();
            error = "Не удалось скачать или проверить APK.";
            state = "error";
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            text.append(Character.forDigit((value & 255) >> 4, 16));
            text.append(Character.forDigit(value & 15, 16));
        }
        return text.toString();
    }

    static File file(Context context) { return new File(context.getCacheDir(), APK); }

    static void install(Context context) throws IOException {
        if (!state.equals("ready") || !file(context).isFile()) throw new IOException("Загрузите обновление повторно.");
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            context.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName())));
            throw new IOException("Разрешите установку приложений для ShareSub и нажмите «Установить» ещё раз.");
        }
        Uri uri = Uri.parse("content://" + context.getPackageName() + ".updates/update.apk");
        context.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
    }
}
