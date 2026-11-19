package ru.sharesub.vpn;

import android.content.Context;
import android.os.BatteryManager;
import org.json.JSONObject;

final class ResourceMonitor {
    private long startedAt;
    private int startedCharge;

    synchronized JSONObject sample(Context context, boolean connected, boolean showMemory, boolean showBattery) throws Exception {
        long now = android.os.SystemClock.elapsedRealtime();
        BatteryManager battery = showBattery ? context.getSystemService(BatteryManager.class) : null;
        boolean onBattery = battery != null && !battery.isCharging();
        int charge = battery == null ? Integer.MIN_VALUE : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER);
        int capacity = battery == null ? Integer.MIN_VALUE : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        Double rate = null;
        if (!connected || !onBattery || charge <= 0 || capacity <= 0 || capacity > 100) {
            startedAt = 0;
        } else if (startedAt == 0 || charge > startedCharge) {
            startedAt = now;
            startedCharge = charge;
        } else if (now - startedAt >= 300_000 && startedCharge > charge) {
            rate = (startedCharge - charge) * capacity * 3_600_000.0 / (charge * (now - startedAt));
        }
        Long memory = showMemory && connected ? TunnelService.memoryBytes() : null;
        return new JSONObject().put("memory", memory == null ? JSONObject.NULL : memory).put("onBattery", onBattery)
            .put("batteryRate", rate == null ? JSONObject.NULL : rate);
    }
}
