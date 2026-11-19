package ru.sharesub.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import org.json.JSONObject;
import libXray.DialerController;
import libXray.LibXray;

import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

public class TunnelService extends VpnService {
    private static final String START = "ru.sharesub.vpn.START";
    private static final String STOP = "ru.sharesub.vpn.STOP";
    private static final String DNS = "1.1.1.1";
    private static final Pattern GEOIP = Pattern.compile("geoip:|(?:ext|ext-ip):geoip\\.dat:");
    private static final Pattern GEOSITE = Pattern.compile("geosite:|(?:ext|ext-domain|ext-site):geosite\\.dat:");
    private static final ExecutorService CORE = Executors.newSingleThreadExecutor();
    private static volatile String state = "idle";
    private static volatile String activeName;
    private static volatile String lastError;
    private static volatile TunnelService activeService;
    private static volatile CoreMemory memory;
    private static boolean protectorRegistered;
    private static JSONObject pending;
    private static Result onConnect;
    private static Result onDisconnect;
    private ParcelFileDescriptor tun;
    private boolean coreRunning;
    private boolean resolverRunning;

    interface Result { void complete(JSONObject value, String error); }

    static Long memoryBytes() {
        CoreMemory current = memory;
        return current != null && state.equals("connected") ? current.sample() : null;
    }

    static JSONObject status() {
        JSONObject value = new JSONObject();
        try {
            value.put("state", state);
            value.put("name", activeName);
            value.put("error", lastError);
        } catch (Exception ignored) { }
        return value;
    }

    static synchronized void connect(Context context, JSONObject options, Result result) {
        if (!state.equals("idle")) { result.complete(null, "Сначала отключите текущий VPN."); return; }
        state = "connecting";
        lastError = null;
        pending = options;
        onConnect = result;
        try { context.startForegroundService(new Intent(context, TunnelService.class).setAction(START)); }
        catch (RuntimeException error) {
            pending = null;
            finishStart("Не удалось запустить службу VPN.");
        }
    }

    static synchronized void disconnect(Context context, Result result) {
        if (state.equals("idle")) { result.complete(status(), null); return; }
        if (state.equals("disconnecting")) { result.complete(null, "VPN уже отключается."); return; }
        state = "disconnecting";
        onDisconnect = result;
        try { context.startService(new Intent(context, TunnelService.class).setAction(STOP)); }
        catch (RuntimeException error) {
            state = "connected";
            onDisconnect = null;
            result.complete(null, "Не удалось остановить службу VPN.");
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (START.equals(action)) {
            JSONObject options;
            synchronized (TunnelService.class) { options = pending; pending = null; }
            try {
                startForeground(5401, notification("Подключаемся…"));
                CORE.execute(() -> start(options));
            } catch (RuntimeException error) {
                finishStart("Android не разрешил запустить службу VPN.");
                stopSelf();
            }
        } else if (STOP.equals(action)) {
            CORE.execute(() -> shutdown(null));
        } else {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void start(JSONObject options) {
        try {
            if (options == null) throw new IOException("Нет конфигурации VPN.");
            JSONObject config = options.getJSONObject("config");
            ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
            Network network = connectivity.getActiveNetwork();
            LinkProperties properties = network == null ? null : connectivity.getLinkProperties(network);
            String upstream = DNS + ":53";
            if (properties != null && !properties.getDnsServers().isEmpty()) {
                InetAddress server = properties.getDnsServers().get(0);
                String host = server.getHostAddress();
                if (host != null) upstream = host.contains(":") ? "[" + host + "]:53" : host + ":53";
            }
            Builder builder = new Builder().setSession("ShareSub").setMtu(1500)
                .addAddress("172.28.57.1", 30).addAddress("fd56:5348:4152::1", 64)
                .addDnsServer(DNS).addRoute("0.0.0.0", 0).addRoute("::", 0);
            try { builder.addDisallowedApplication(getPackageName()); }
            catch (PackageManager.NameNotFoundException error) { throw new IOException("Не удалось настроить сеть ShareSub."); }
            tun = builder.establish();
            if (tun == null) throw new IOException("Android не создал VPN-интерфейс.");
            activeService = this;
            DialerController protector = fd -> protect((int) fd);
            if (!protectorRegistered) {
                LibXray.registerDialerController(fd -> {
                    TunnelService service = activeService;
                    return service != null && service.protect((int) fd);
                });
                protectorRegistered = true;
            }
            LibXray.setDNS(protector, upstream);
            resolverRunning = true;
            JSONObject env = new JSONObject().put("xray.tun.fd", Integer.toString(tun.getFd()));
            File geodata = new File(getFilesDir(), "geodata");
            String profile = config.toString();
            boolean needsGeoIp = GEOIP.matcher(profile).find();
            boolean needsGeoSite = GEOSITE.matcher(profile).find();
            if (needsGeoIp || needsGeoSite) {
                if (needsGeoIp) copyGeoData(geodata, "geoip.dat");
                if (needsGeoSite) copyGeoData(geodata, "geosite.dat");
                env.put("xray.location.asset", geodata.getAbsolutePath());
            }
            config.put("env", env);
            JSONObject measured = new JSONObject(config.toString());
            CoreMemory newMemory = null;
            try {
                CoreMemory candidate = new CoreMemory(measured);
                invoke("runXray", new JSONObject().put("xrayJson", measured.toString()));
                newMemory = candidate;
            } catch (IOException unavailable) {
                invoke("runXray", new JSONObject().put("xrayJson", config.toString()));
            }
            coreRunning = true;
            memory = newMemory;
            activeName = options.getString("name");
            finishStart(null);
            getSystemService(NotificationManager.class).notify(5401, notification(activeName));
        } catch (Exception | LinkageError error) {
            cleanup();
            finishStart(error instanceof IOException ? error.getMessage() : "Не удалось запустить Xray на Android.");
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private void copyGeoData(File directory, String asset) throws IOException {
        File target = new File(directory, asset);
        if (target.isFile()) return;
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Не удалось подготовить базы маршрутизации Xray.");
        File partial = new File(directory, asset + ".part");
        try (InputStream source = getAssets().open(asset); FileOutputStream output = new FileOutputStream(partial)) {
            byte[] buffer = new byte[32768];
            for (int count; (count = source.read(buffer)) != -1;) output.write(buffer, 0, count);
        }
        if (!partial.renameTo(target)) throw new IOException("Не удалось сохранить базу маршрутизации Xray.");
    }

    private static void invoke(String method, JSONObject payload) throws Exception {
        JSONObject request = new JSONObject().put("apiVersion", 3).put("method", method);
        if (payload != null) request.put("payload", payload);
        JSONObject response = new JSONObject(LibXray.invoke(request.toString()));
        if (!response.optBoolean("success")) throw new IOException("Xray не принял конфигурацию сервера.");
    }

    private static synchronized void finishStart(String error) {
        if (!state.equals("disconnecting")) state = error == null ? "connected" : "idle";
        lastError = error;
        Result callback = onConnect;
        onConnect = null;
        if (callback != null) callback.complete(status(), error);
    }

    private void cleanup() {
        memory = null;
        if (coreRunning) {
            try { invoke("stopXray", null); } catch (Exception | LinkageError ignored) { }
            coreRunning = false;
        }
        if (resolverRunning) {
            try { LibXray.resetDNS(); } catch (RuntimeException | LinkageError ignored) { }
            resolverRunning = false;
        }
        try { if (tun != null) tun.close(); } catch (IOException ignored) { }
        tun = null;
        if (activeService == this) activeService = null;
    }

    private void shutdown(String error) {
        cleanup();
        Result startResult, stopResult;
        synchronized (TunnelService.class) {
            state = "idle";
            activeName = null;
            lastError = error;
            startResult = onConnect;
            stopResult = onDisconnect;
            onConnect = onDisconnect = null;
            pending = null;
        }
        if (startResult != null) startResult.complete(null, error == null ? "Подключение отменено." : error);
        if (stopResult != null) stopResult.complete(status(), null);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification notification(String description) {
        String channel = "sharesub-vpn";
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(channel, "VPN ShareSub", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TunnelService.class).setAction(STOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_status).setContentTitle("ShareSub").setContentText(description)
            .setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null, "Отключить", stop).build())
            .build();
    }

    @Override public void onRevoke() { CORE.execute(() -> shutdown("Android отозвал разрешение VPN.")); }

    @Override public void onDestroy() {
        CORE.execute(() -> { if (tun != null) shutdown("Системная служба VPN остановлена."); });
        super.onDestroy();
    }
}
