package ru.sharesub.vpn;

import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Locale;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://app.sharesub.invalid";
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private static final int BACKGROUND = Color.rgb(251, 251, 250);
    private static final int DARK_BACKGROUND = Color.rgb(21, 21, 21);
    private final ExecutorService io = Executors.newFixedThreadPool(18);
    private static final ResourceMonitor MONITOR = new ResourceMonitor();
    private WebView web;
    private FrameLayout content;
    private SharedPreferences preferences;
    private String deviceId;
    private int approvalRequest;
    private JSONObject approvalConfig;
    private volatile String pendingLink = "";
    private String coreVersion;
    private ValueCallback<Uri[]> fileChooser;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        receiveLink(getIntent());
        preferences = getSharedPreferences("sharesub", MODE_PRIVATE);
        deviceId = preferences.getString("device", null);
        if (deviceId == null) {
            deviceId = UUID.randomUUID().toString();
            preferences.edit().putString("device", deviceId).apply();
        }
        content = new FrameLayout(this);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "ShareSubAndroid");
        web.setWebViewClient(new AssetsClient(getAssets()));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooser != null) fileChooser.onReceiveValue(null);
                fileChooser = callback;
                Intent choose = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"});
                try { startActivityForResult(choose, 102); }
                catch (RuntimeException error) { callback.onReceiveValue(null); fileChooser = null; }
                return true;
            }
        });
        content.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
            content.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets padding = insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                int bottom = Math.max(padding.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                if (view.getPaddingLeft() != padding.left || view.getPaddingTop() != padding.top
                    || view.getPaddingRight() != padding.right || view.getPaddingBottom() != bottom) {
                    view.setPadding(padding.left, padding.top, padding.right, bottom);
                }
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(content);
        String theme = preferences.getString("theme", "light").equals("dark") ? "dark" : "light";
        applyTheme(theme);
        content.requestApplyInsets();
        float fontScale = getResources().getConfiguration().fontScale;
        web.loadUrl(ORIGIN + "/index.html?fontScale=" + fontScale + "&theme=" + theme);
    }

    private void applyTheme(String theme) {
        boolean dark = theme.equals("dark");
        int color = dark ? DARK_BACKGROUND : BACKGROUND;
        content.setBackgroundColor(color);
        web.setBackgroundColor(color);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            web.setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveLink(intent);
    }

    private void receiveLink(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getDataString() != null
            && intent.getDataString().length() <= 32768) pendingLink = intent.getDataString();
    }

    private String version() throws Exception {
        return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
    }

    private synchronized String loadCoreVersion() {
        if (coreVersion != null) return coreVersion;
        try {
            String envelope = libXray.LibXray.invoke("{\"apiVersion\":3,\"method\":\"xrayVersion\"}");
            coreVersion = new JSONObject(envelope).getJSONObject("data").getString("version");
        } catch (Exception | LinkageError error) { return null; }
        return coreVersion;
    }

    private static class AssetsClient extends WebViewClient {
        private final AssetManager assets;
        AssetsClient(AssetManager assets) { this.assets = assets; }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            String path = request.getUrl().getPath();
            if (url.startsWith(ORIGIN + "/") && path != null
                && path.matches("/(?:[\\w.-]+\\.(?:html|css|mjs)|flags/[a-z]{2}\\.webp|fonts/golos-text\\.woff2)")) {
                String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css"
                    : path.endsWith(".webp") ? "image/webp" : path.endsWith(".woff2") ? "font/woff2" : "text/javascript";
                String encoding = mime.startsWith("text/") ? "UTF-8" : null;
                try { return new WebResourceResponse(mime, encoding, assets.open(path.substring(1))); }
                catch (IOException ignored) { }
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
        }
    }

    private class Bridge {
        @JavascriptInterface public void request(int id, String method, String input) {
            if (input.length() > MAX_BODY) {
                reject(id, "Слишком много данных.");
                return;
            }
            if (method.equals("connect") || method.equals("disconnect") || method.equals("bot")
                || method.equals("clipboard") || method.equals("updateInstall")) {
                runOnUiThread(() -> requestOnUi(id, method, input));
                return;
            }
            io.execute(() -> {
                try {
                    switch (method) {
                        case "init":
                            resolve(id, new JSONObject().put("platform", "android")
                                .put("version", version()).put("coreVersion", loadCoreVersion())
                                .put("grouped", preferences.getBoolean("grouped", false))
                                .put("automatic", preferences.getBoolean("automatic", true))
                                .put("subscriptionRefreshMinutes", preferences.getInt("subscriptionRefreshMinutes", 60))
                                .put("theme", preferences.getString("theme", "light"))
                                .put("showMemory", preferences.getBoolean("showMemory", true))
                                .put("showBattery", preferences.getBoolean("showBattery", true))
                                .put("sources", new JSONArray(preferences.getString("sources", "[]"))).put("vpn", TunnelService.status()));
                            break;
                        case "preferences":
                            JSONObject options = new JSONObject(input);
                            String appearance = "dark".equals(options.optString("theme")) ? "dark" : "light";
                            int minutes = options.optInt("subscriptionRefreshMinutes", 60);
                            boolean savedPreferences = preferences.edit().putBoolean("grouped", options.optBoolean("grouped"))
                                .putBoolean("automatic", options.optBoolean("automatic", true)).putString("theme", appearance)
                                .putInt("subscriptionRefreshMinutes", minutes >= 0 && minutes <= 1440 ? minutes : 60)
                                .putBoolean("showMemory", options.optBoolean("showMemory", true))
                                .putBoolean("showBattery", options.optBoolean("showBattery", true)).commit();
                            if (savedPreferences) runOnUiThread(() -> applyTheme(appearance));
                            resolve(id, savedPreferences);
                            break;
                        case "deeplink":
                            String link = pendingLink;
                            pendingLink = "";
                            resolve(id, link);
                            break;
                        case "metrics":
                            JSONObject metrics = new JSONObject(input);
                            resolve(id, MONITOR.sample(MainActivity.this, "connected".equals(TunnelService.status().optString("state")),
                                metrics.optBoolean("showMemory"), metrics.optBoolean("showBattery")));
                            break;
                        case "updateCheck":
                            resolve(id, UpdateManager.check(MainActivity.this));
                            break;
                        case "updateStatus":
                            resolve(id, UpdateManager.status());
                            break;
                        case "updateAction":
                            resolve(id, UpdateManager.download(MainActivity.this));
                            break;
                        case "status":
                            resolve(id, TunnelService.status());
                            break;
                        case "save":
                            JSONArray sources = new JSONArray(input);
                            if (sources.length() > 100) throw new IOException("Слишком много сохранённых данных.");
                            boolean saved = preferences.edit().putString("sources", sources.toString()).commit();
                            if (!saved) throw new IOException("Не удалось сохранить подписку.");
                            resolve(id, true);
                            break;
                        case "subscription":
                            resolve(id, download(new JSONArray("[" + input + "]").getString(0)));
                            break;
                        case "ping":
                            resolve(id, ping(new JSONObject(input)));
                            break;
                        case "tunnelPing":
                            resolve(id, TunnelService.tunnelPing());
                            break;
                        default:
                            reject(id, "Команда не поддерживается.");
                    }
                } catch (Exception error) { reject(id, error.getMessage()); }
            });
        }
    }

    private void requestOnUi(int id, String method, String input) {
        try {
            if (method.equals("clipboard")) {
                ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                var clip = clipboard == null ? null : clipboard.getPrimaryClip();
                var text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
                resolve(id, text == null ? "" : text.toString());
            } else if (method.equals("updateInstall")) {
                UpdateManager.install(this);
                resolve(id, UpdateManager.status());
            } else if (method.equals("bot")) {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://t.me/sharesubot")));
                resolve(id, true);
            } else if (method.equals("disconnect")) {
                TunnelService.disconnect(this, (value, error) -> complete(id, value, error));
            } else {
                JSONObject config = new JSONObject(input);
                if (approvalConfig != null) throw new IOException("Уже ожидаем разрешение Android.");
                Intent consent = VpnService.prepare(this);
                if (consent == null) {
                    startTunnel(id, config);
                } else {
                    approvalRequest = id;
                    approvalConfig = config;
                    startActivityForResult(consent, 101);
                }
            }
        } catch (Exception error) { reject(id, error.getMessage()); }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 102 && fileChooser != null) {
            ValueCallback<Uri[]> callback = fileChooser;
            fileChooser = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            return;
        }
        if (requestCode != 101 || approvalConfig == null) return;
        JSONObject config = approvalConfig;
        int id = approvalRequest;
        approvalConfig = null;
        if (resultCode == RESULT_OK) startTunnel(id, config);
        else reject(id, "Для подключения нужно разрешение Android на VPN.");
    }

    private void startTunnel(int id, JSONObject config) {
        TunnelService.connect(this, config, (value, error) -> complete(id, value, error));
    }

    private void resolve(int id, Object value) { complete(id, value, null); }
    private void reject(int id, String error) { complete(id, null, error == null ? "Попробуйте ещё раз." : error); }

    private void complete(int id, Object value, String error) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            try {
                JSONObject result = new JSONObject().put("ok", error == null);
                if (error == null) result.put("value", value == null ? JSONObject.NULL : value);
                else result.put("error", error);
                web.evaluateJavascript("window.resolveShareSub(" + id + "," + result + ")", null);
            } catch (Exception ignored) { }
        });
    }

    private static boolean isShareSub(URL address) {
        String host = address.getHost().toLowerCase(Locale.ROOT);
        return address.getProtocol().equals("https") && (host.equals("sharesub.ru") || host.endsWith(".sharesub.ru"));
    }

    private static String origin(URL address) {
        int port = address.getPort();
        return address.getProtocol() + "://" + address.getHost().toLowerCase(Locale.ROOT)
            + (port < 0 || port == address.getDefaultPort() ? "" : ":" + port);
    }

    private String providerId(String origin) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(deviceId.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] value = mac.doFinal(origin.getBytes(StandardCharsets.UTF_8));
            StringBuilder text = new StringBuilder(64);
            for (byte part : value) {
                text.append(Character.forDigit((part & 255) >>> 4, 16));
                text.append(Character.forDigit(part & 15, 16));
            }
            return text.toString();
        } catch (GeneralSecurityException error) { throw new IOException("Не удалось подготовить HWID.", error); }
    }

    private String download(String input) throws IOException {
        URL address;
        try { address = new URL(input); }
        catch (IOException error) { throw new IOException("Некорректная ссылка на подписку."); }
        boolean fromShareSub = isShareSub(address);
        String providerOrigin = origin(address);
        String hwid = fromShareSub ? deviceId : providerId(providerOrigin);
        Uri source = Uri.parse(input);
        String requestedFormat = source.isHierarchical() ? source.getQueryParameter("format") : null;
        boolean preferJson = requestedFormat == null || requestedFormat.equalsIgnoreCase("xray-json");
        if (fromShareSub && requestedFormat == null) {
            address = new URL(source.buildUpon().appendQueryParameter("format", "xray-json").build().toString());
        }
        long deadline = System.nanoTime() + 22_000_000_000L;
        for (int redirects = 0; redirects < 6; redirects++) {
            if ((!address.getProtocol().equals("http") && !address.getProtocol().equals("https")) || address.getUserInfo() != null) break;
            HttpURLConnection connection = (HttpURLConnection) address.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(6500);
            connection.setReadTimeout(8000);
            String userAgent = "ShareSub/" + getString(R.string.app_version) + " (Android)";
            connection.setRequestProperty("User-Agent", preferJson && !isShareSub(address) ? "Happ/3.0 " + userAgent : userAgent);
            connection.setRequestProperty("Accept", preferJson ? "application/json, text/plain;q=0.9, */*;q=0.1" : "text/plain, application/json, */*");
            if (address.getProtocol().equals("https") && (providerOrigin.equals(origin(address)) || (fromShareSub && isShareSub(address)))) {
                connection.setRequestProperty("X-HWID", hwid);
                connection.setRequestProperty("X-Device-OS", "Android");
                connection.setRequestProperty("X-Ver-OS", safeHeader(Build.VERSION.RELEASE));
                connection.setRequestProperty("X-Device-Model", safeHeader(Build.MODEL));
            }
            try {
                int status;
                try { status = connection.getResponseCode(); }
                catch (IOException error) { throw new IOException("Не удалось загрузить подписку. Проверьте сеть и ссылку."); }
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || System.nanoTime() >= deadline) break;
                    URL next = new URL(address, location);
                    if (address.getProtocol().equals("https") && !next.getProtocol().equals("https")) break;
                    address = next;
                    continue;
                }
                if (status == 403 && fromShareSub) throw new IOException("ShareSub отклонил доступ. Проверьте лимит устройств в @sharesubot.");
                if (status == 403 && address.getProtocol().equals("http")) throw new IOException("Провайдер отклонил доступ. Если нужен HWID, используйте HTTPS-ссылку.");
                if (status < 200 || status >= 300) throw new IOException("Сервер подписки ответил HTTP " + status + ".");
                if (connection.getContentLengthLong() > MAX_BODY) throw new IOException("Подписка слишком большая.");
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream result = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[32768];
                    int count;
                    while ((count = stream.read(buffer)) != -1) {
                        if (result.size() + count > MAX_BODY) throw new IOException("Подписка слишком большая.");
                        if (System.nanoTime() >= deadline) throw new IOException("Сервер подписки отвечает слишком долго.");
                        result.write(buffer, 0, count);
                    }
                    return result.toString(StandardCharsets.UTF_8.name());
                }
            } finally { connection.disconnect(); }
        }
        throw new IOException("Сервер подписки перенаправил запрос на недоступный адрес.");
    }

    private static String safeHeader(String text) { return text.replaceAll("[^ -~]", ""); }

    private static Object ping(JSONObject target) {
        String host = target.optString("host");
        int port = target.optInt("port");
        if (host.isEmpty() || host.length() > 253 || port <= 0 || port > 65535) return JSONObject.NULL;
        try (Socket client = new Socket()) {
            long start = System.nanoTime();
            client.connect(new InetSocketAddress(host, port), 2400);
            return Math.max(1L, Math.round((System.nanoTime() - start) / 1_000_000.0));
        } catch (Exception error) { return JSONObject.NULL; }
    }

    @Override protected void onDestroy() {
        if (fileChooser != null) fileChooser.onReceiveValue(null);
        io.shutdownNow();
        web.removeJavascriptInterface("ShareSubAndroid");
        web.destroy();
        super.onDestroy();
    }
}
