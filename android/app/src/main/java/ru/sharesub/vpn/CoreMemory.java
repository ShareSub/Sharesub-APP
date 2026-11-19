package ru.sharesub.vpn;

import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

final class CoreMemory {
    private static final String INBOUND = "sharesub-core-memory";
    private static final String METRICS = "sharesub-local-metrics";
    private final int port;
    private final String password = UUID.randomUUID().toString();

    CoreMemory(JSONObject config) throws Exception {
        try (ServerSocket socket = new ServerSocket()) {
            socket.bind(new InetSocketAddress("127.0.0.1", 0));
            port = socket.getLocalPort();
        }
        config.getJSONArray("inbounds").put(new JSONObject().put("tag", INBOUND)
            .put("listen", "127.0.0.1").put("port", port).put("protocol", "http")
            .put("settings", new JSONObject().put("accounts",
                new JSONArray().put(new JSONObject().put("user", "sharesub").put("pass", password)))));
        config.put("metrics", new JSONObject().put("tag", METRICS));
        JSONObject routing = config.optJSONObject("routing");
        if (routing == null) {
            routing = new JSONObject();
            config.put("routing", routing);
        }
        JSONArray existing = routing.optJSONArray("rules");
        JSONArray rules = new JSONArray().put(new JSONObject().put("type", "field")
            .put("inboundTag", new JSONArray().put(INBOUND)).put("outboundTag", METRICS));
        if (existing != null) for (int i = 0; i < existing.length(); i++) rules.put(existing.get(i));
        routing.put("rules", rules);
    }

    Long sample() {
        HttpURLConnection connection = null;
        try {
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port));
            connection = (HttpURLConnection) new URL("http://127.0.0.1/debug/vars").openConnection(proxy);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(900);
            connection.setReadTimeout(1200);
            String credentials = Base64.encodeToString(("sharesub:" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            connection.setRequestProperty("Proxy-Authorization", "Basic " + credentials);
            try (InputStream stream = connection.getInputStream(); java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                for (int n; (n = stream.read(buffer)) != -1;) {
                    if (bytes.size() + n > 65536) return null;
                    bytes.write(buffer, 0, n);
                }
                long allocated = new JSONObject(bytes.toString("UTF-8")).getJSONObject("memstats").getLong("Alloc");
                return allocated >= 0 ? allocated : null;
            }
        } catch (Exception error) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
