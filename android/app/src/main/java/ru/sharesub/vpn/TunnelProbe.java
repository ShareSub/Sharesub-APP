package ru.sharesub.vpn;

import android.util.Base64;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

final class TunnelProbe {
    private final int port;
    private final String password = UUID.randomUUID().toString();

    TunnelProbe(JSONObject config) throws Exception {
        try (ServerSocket socket = new ServerSocket()) {
            socket.bind(new InetSocketAddress("127.0.0.1", 0));
            port = socket.getLocalPort();
        }
        String tag = UUID.randomUUID().toString();
        JSONArray inbounds = config.getJSONArray("inbounds");
        JSONObject tun = inbounds.getJSONObject(0);
        inbounds.put(new JSONObject().put("tag", tag).put("listen", "127.0.0.1").put("port", port)
            .put("protocol", "http").put("sniffing", tun.optJSONObject("sniffing"))
            .put("settings", new JSONObject().put("accounts",
                new JSONArray().put(new JSONObject().put("user", "sharesub").put("pass", password)))));
        JSONObject routing = config.optJSONObject("routing");
        JSONArray rules = routing == null ? null : routing.optJSONArray("rules");
        if (rules == null) return;
        for (int index = 0; index < rules.length(); index++) {
            JSONObject rule = rules.optJSONObject(index);
            JSONArray tags = rule == null ? null : rule.optJSONArray("inboundTag");
            if (tags == null) continue;
            for (int i = 0; i < tags.length(); i++) {
                if (!tun.optString("tag").equals(tags.optString(i))) continue;
                tags.put(tag);
                break;
            }
        }
    }

    Long measure() {
        HttpURLConnection connection = null;
        try {
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port));
            connection = (HttpURLConnection) new URL("http://cp.cloudflare.com/generate_204").openConnection(proxy);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(5500);
            connection.setUseCaches(false);
            connection.setRequestProperty("Connection", "close");
            String credentials = Base64.encodeToString(("sharesub:" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            connection.setRequestProperty("Proxy-Authorization", "Basic " + credentials);
            long start = System.nanoTime();
            return connection.getResponseCode() == 204 ? Math.max(1L, Math.round((System.nanoTime() - start) / 1_000_000.0)) : null;
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
