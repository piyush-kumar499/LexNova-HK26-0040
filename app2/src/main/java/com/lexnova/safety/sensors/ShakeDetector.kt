package com.lexnova.safety.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.sqrt

/**
 * Shake trigger with false-positive protection: N distinct shakes inside a
 * 2-second window are required. Sensitivity 1..3 lowers/raises the threshold.
 */
class ShakeDetector(
    context: Context,
    private val onShake: () -> Unit,
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    private var sensitivity = 2
    private var lastShakeAt = 0L
    private var shakeCount = 0
    private var windowStart = 0L

    fun setSensitivity(value: Int) {
        sensitivity = value.coerceIn(1, 3)
    }

    fun start() {
        accelerometer?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
    }

    fun stop() {
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]
        val magnitude = sqrt(x * x + y * y + z * z) - 9.80665f
        val threshold = when (sensitivity) {
            1 -> 12f
            3 -> 6f
            else -> 8.5f
        }
        if (magnitude < threshold) return

        val now = System.currentTimeMillis()
        if (now - lastShakeAt < 180) return // debounce a single motion
        lastShakeAt = now
        if (now - windowStart > 2000) {
            windowStart = now
            shakeCount = 0
        }
        shakeCount++
        if (shakeCount >= 5) {
            shakeCount = 0
            windowStart = 0
            onShake()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
