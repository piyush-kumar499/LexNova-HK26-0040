package com.lexnova.safety.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

data class Fix(val latitude: Double, val longitude: Double, val accuracy: Double?)

object LocationProvider {

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Non-blocking: last known fix within the last 5 minutes, or null. */
    fun quickFix(context: Context): Fix? {
        if (!hasPermission(context)) return null
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            try {
                @Suppress("MissingPermission")
                lm.getLastKnownLocation(provider)?.let { loc ->
                    if (System.currentTimeMillis() - loc.time < 5 * 60 * 1000) {
                        return Fix(loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy.toDouble() else null)
                    }
                }
            } catch (_: SecurityException) {
            } catch (_: IllegalArgumentException) {
            }
        }
        return null
    }

    /** Best effort live fix; gives up after [timeoutMs] and returns null. */
    suspend fun getFix(context: Context, timeoutMs: Long = 8000): Fix? {
        if (!hasPermission(context)) return null
        quickFix(context)?.let { return it }
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return suspendCancellableCoroutine { cont ->
            val handler = Handler(Looper.getMainLooper())
            var settled = false
            lateinit var listener: LocationListener

            fun finish(fix: Fix?) {
                if (settled) return
                settled = true
                handler.removeCallbacksAndMessages(null)
                try {
                    lm.removeUpdates(listener)
                } catch (_: Exception) {
                }
                if (cont.isActive) cont.resume(fix)
            }

            listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    finish(Fix(location.latitude, location.longitude, if (location.hasAccuracy()) location.accuracy.toDouble() else null))
                }

                override fun onProviderDisabled(provider: String) = Unit
                override fun onProviderEnabled(provider: String) = Unit
                override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            }

            handler.postDelayed({ finish(null) }, timeoutMs)
            for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                try {
                    @Suppress("MissingPermission")
                    lm.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                } catch (_: Exception) {
                }
            }
            cont.invokeOnCancellation { finish(null) }
        }
    }
}
