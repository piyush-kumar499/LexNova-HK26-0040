package com.lexnova.safety.sensors

import android.Manifest
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.lexnova.safety.MainActivity
import com.lexnova.safety.core.DeviceIdentity
import com.lexnova.safety.core.Prefs
import com.lexnova.safety.location.Fix
import com.lexnova.safety.location.LocationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

/**
 * Shake guard that stays alive on the lock screen. When 5 shakes are detected
 * while the screen is off or the keyguard is locked, it creates the SOS on the
 * server, sends location, and dials the Vapi line directly — no taps needed.
 * While the app is open on an unlocked screen, the in-app detector handles
 * shakes (with its 5s cancel countdown), so the service stays quiet.
 */
class ShakeGuardService : Service(), SensorEventListener {

    private lateinit var prefs: Prefs
    private lateinit var sensorManager: SensorManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var firedAt = 0L

    private var lastShakeAt = 0L
    private var shakeCount = 0
    private var windowStart = 0L

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        prefs = Prefs(this)
        val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        accelerometer?.let {
            sensorManager.unregisterListener(this)
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        sensorManager.unregisterListener(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAsForeground() {
        val channelId = "lexnova_shake_guard"
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(channelId, "Shake guard", NotificationManager.IMPORTANCE_LOW)
        )
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle("LexNova shake guard")
            .setContentText("Shake detection is on — shake 5 times on the lock screen to send an SOS.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this, 1, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(1, notification)
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]
        val magnitude = sqrt(x * x + y * y + z * z) - 9.80665f
        val threshold = when (prefs.shakeSensitivity) {
            1 -> 12f
            3 -> 6f
            else -> 8.5f
        }
        if (magnitude < threshold) return

        val now = System.currentTimeMillis()
        if (now - lastShakeAt < 180) return
        lastShakeAt = now
        if (now - windowStart > 2000) {
            windowStart = now
            shakeCount = 0
        }
        shakeCount++
        if (shakeCount >= 5) {
            shakeCount = 0
            windowStart = 0
            if (shouldFire()) trigger()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    /** Fire only when the user cannot reach the in-app countdown: screen off/locked. */
    private fun shouldFire(): Boolean {
        val keyguard = getSystemService(KeyguardManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        return keyguard.isKeyguardLocked || !power.isInteractive
    }

    private fun trigger() {
        val now = System.currentTimeMillis()
        if (now - firedAt < 10_000) return // one trigger per 10s window
        firedAt = now
        vibrate()
        scope.launch {
            // Wait briefly for a live fix: an SOS without a location is
            // invisible to nearby devices.
            val fix = LocationProvider.quickFix(this@ShakeGuardService)
                ?: LocationProvider.getFix(this@ShakeGuardService, 6000)
            val created = postSos(fix)
            if (created) {
                dialVapi()
                LocationProvider.getFix(this@ShakeGuardService, 8000)?.let { live ->
                    runCatching { postLocation(live) }
                }
            }
        }
    }

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    private fun postSos(fix: Fix?): Boolean {
        return try {
            val json = JSONObject().apply {
                put("triggerType", "shake")
                fix?.let {
                    put("latitude", it.latitude)
                    put("longitude", it.longitude)
                    it.accuracy?.let { a -> put("locationAccuracy", a) }
                }
                val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date())
                put("deviceTimestamp", iso)
                put("clientRequestId", UUID.randomUUID().toString())
            }
            val request = Request.Builder()
                .url("${prefs.serverUrl}/sos")
                .header("X-Device-Id", DeviceIdentity.get(this))
                .post(json.toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.i(TAG, "shake SOS created (${response.code})")
                    true
                } else {
                    Log.w(TAG, "shake SOS failed: ${response.code} ${response.body?.string()}")
                    false
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "shake SOS error", e)
            false
        }
    }

    private fun postLocation(fix: Fix) {
        try {
            val json = JSONObject().apply {
                put("latitude", fix.latitude)
                put("longitude", fix.longitude)
                fix.accuracy?.let { put("accuracy", it) }
                val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date())
                put("capturedAt", iso)
            }
            val request = Request.Builder()
                .url("${prefs.serverUrl}/device/location")
                .header("X-Device-Id", DeviceIdentity.get(this))
                .post(json.toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { }
        } catch (e: Exception) {
            Log.w(TAG, "location post failed", e)
        }
    }

    /**
     * With CALL_PHONE granted, the call is launched via a full-screen-intent
     * notification: the system (not the app) opens the in-call UI over the
     * keyguard, so a locked-screen shake dials instantly with zero taps and
     * is not blocked as a background activity launch. Without the permission
     * the dialer opens pre-filled as the best available fallback.
     */
    private fun dialVapi() {
        val number = prefs.vapiNumber
        if (number.isBlank()) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:+$number"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(intent)
                Log.i(TAG, "opening dialer for +$number")
            } catch (e: Exception) {
                Log.e(TAG, "dialer open failed", e)
            }
            return
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            try {
                startActivity(
                    Intent(Intent.ACTION_CALL, Uri.parse("tel:+$number"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                Log.i(TAG, "SOS call (direct, notifications off) to +$number")
            } catch (e: Exception) {
                Log.e(TAG, "direct call failed", e)
            }
            return
        }
        try {
            val callIntent = Intent(Intent.ACTION_CALL, Uri.parse("tel:+$number"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val fullScreen = PendingIntent.getActivity(
                this, 2001, callIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val channelId = "lexnova_sos_call"
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(channelId, "SOS emergency call", NotificationManager.IMPORTANCE_HIGH).apply {
                    setSound(null, null)
                    enableVibration(false)
                },
            )
            val notification: Notification = NotificationCompat.Builder(this, channelId)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setContentTitle("LexNova SOS")
                .setContentText("Emergency call to the LexNova helpline")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setFullScreenIntent(fullScreen, true)
                .setAutoCancel(true)
                .build()
            manager.notify(SOS_CALL_NOTIFICATION_ID, notification)
            Log.i(TAG, "SOS call launched over keyguard to +$number")
        } catch (e: Exception) {
            Log.e(TAG, "SOS call launch failed", e)
        }
    }

    private fun vibrate() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (vibrator.hasVibrator()) {
            vibrator.vibrate(VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    companion object {
        private const val TAG = "ShakeGuardService"
        private const val SOS_CALL_NOTIFICATION_ID = 77

        fun start(context: Context) {
            val intent = Intent(context, ShakeGuardService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ShakeGuardService::class.java))
        }
    }
}
