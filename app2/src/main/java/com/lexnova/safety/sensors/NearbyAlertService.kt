package com.lexnova.safety.sensors

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import android.content.pm.ServiceInfo
import com.lexnova.safety.MainActivity
import com.lexnova.safety.core.DeviceIdentity
import com.lexnova.safety.core.Prefs
import com.lexnova.safety.data.ApiClient
import com.lexnova.safety.data.LexNovaRepository
import com.lexnova.safety.data.NearbyIncident
import com.lexnova.safety.location.LocationProvider
import com.lexnova.safety.ui.NearbyAlertActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Bystander alert: polls GET /nearby/sos and, when a new active incident is
 * nearby, makes the phone ring, vibrate, and pop a full-screen alert over the
 * lock screen. The server records the poll as NOTIFIED, so ACCEPT later is a
 * plain transition. The victim's own device is excluded server-side.
 */
class NearbyAlertService : Service() {

    private lateinit var prefs: Prefs
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val repo by lazy {
        LexNovaRepository(ApiClient({ DeviceIdentity.get(this) }, { prefs.serverUrl }))
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        startAsForeground()
        scope.launch { pollLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        prefs = Prefs(this)
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAsForeground() {
        val channelId = "lexnova_nearby_listener"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(channelId, "Nearby SOS listener", NotificationManager.IMPORTANCE_LOW)
        )
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle("LexNova nearby listener")
            .setContentText("You will be alerted if someone nearby sends an SOS.")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this, 2, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(2, notification)
        }
    }

    private suspend fun pollLoop() {
        while (scope.isActive) {
            runCatching { pollOnce() }
                .onFailure { Log.w(TAG, "nearby poll failed: ${it.message}") }
            delay(POLL_INTERVAL_MS)
        }
    }

    private var lastLocationPostAt = 0L

    private suspend fun pollOnce() {
        if (!prefs.canRespond) return
        var fix = LocationProvider.quickFix(this)
        if (fix == null) {
            // Fresh installs and long-idle phones have no recent fix; grab one
            // and store it so the server can match this device to incidents.
            fix = LocationProvider.getFix(this, 6000)
            if (fix != null) {
                runCatching { repo.postLocation(fix.latitude, fix.longitude, fix.accuracy) }
                lastLocationPostAt = System.currentTimeMillis()
            }
        } else if (System.currentTimeMillis() - lastLocationPostAt > 5 * 60 * 1000) {
            runCatching { repo.postLocation(fix.latitude, fix.longitude, fix.accuracy) }
            lastLocationPostAt = System.currentTimeMillis()
        }
        val incidents = repo.nearby(fix?.latitude, fix?.longitude)
        for (incident in incidents) {
            if (incident.status == "RESOLVED" || incident.status == "CANCELLED") continue
            if (!incident.responderStatus.equals("NOTIFIED", ignoreCase = true)) continue
            if (prefs.markAlerted(incident.incidentId)) fireAlert(incident)
        }
    }

    private fun fireAlert(incident: NearbyIncident) {
        Log.i(TAG, "nearby SOS alert: ${incident.incidentId} at ~${incident.approximateDistanceM} m")
        val popup = Intent(this, NearbyAlertActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(NearbyAlertActivity.EXTRA_INCIDENT_ID, incident.incidentId)
            .putExtra(NearbyAlertActivity.EXTRA_DISTANCE_M, incident.approximateDistanceM)
            .putExtra(NearbyAlertActivity.EXTRA_TRIGGER, incident.triggerType ?: "SOS")
            .putExtra(NearbyAlertActivity.EXTRA_ACTIVATED_AT, incident.activatedAt)

        val fullScreen = PendingIntent.getActivity(
            this,
            1001,
            popup,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val channelId = "lexnova_nearby_alert"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(channelId, "Nearby SOS alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                val attrs = android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), attrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 900, 400, 900, 400, 900, 400, 900)
            },
        )
        val notification: Notification = NotificationCompat.Builder(this, channelId)            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("LexNova SOS — someone nearby needs help!")
            .setContentText("About ${incident.approximateDistanceM} m away — respond now")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), AudioManager.STREAM_ALARM)
            .setVibrate(longArrayOf(0, 900, 400, 900, 400, 900, 400, 900))
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(ALERT_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "full-screen alert blocked", e)
        }
        // Belt and braces: on some devices the full-screen intent is not
        // auto-launched; a direct start is deduped by SINGLE_TOP when both run.
        try {
            startActivity(popup)
        } catch (_: Exception) {
        }
    }

    companion object {
        private const val TAG = "NearbyAlertService"
        private const val ALERT_NOTIFICATION_ID = 42
        private const val POLL_INTERVAL_MS = 15_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, NearbyAlertService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, NearbyAlertService::class.java))
        }
    }
}
