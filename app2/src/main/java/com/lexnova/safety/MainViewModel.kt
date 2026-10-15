package com.lexnova.safety

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.Manifest
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.lexnova.safety.core.DeviceIdentity
import com.lexnova.safety.core.Prefs
import com.lexnova.safety.data.ApiClient
import com.lexnova.safety.data.ApiError
import com.lexnova.safety.data.Contact
import com.lexnova.safety.data.DeviceInfo
import com.lexnova.safety.data.IncidentCore
import com.lexnova.safety.data.IncidentView
import com.lexnova.safety.data.LexNovaRepository
import com.lexnova.safety.data.NearbyIncident
import com.lexnova.safety.location.LocationProvider
import com.lexnova.safety.sensors.ShakeDetector
import com.lexnova.safety.sensors.ShakeGuardService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class ServerStatus { CHECKING, ONLINE, OFFLINE }

data class UiState(
    val serverStatus: ServerStatus = ServerStatus.CHECKING,
    val device: DeviceInfo? = null,
    val activeIncident: IncidentView? = null,
    val incidentPolling: Boolean = false,
    val nearbyIncidents: List<NearbyIncident> = emptyList(),
    val contacts: List<Contact> = emptyList(),
    val busy: Boolean = false,
    val error: String? = null,
    val lastAction: String? = null,
    val countdown: Int? = null,
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val context: Context = app.applicationContext
    val prefs = Prefs(context)
    val deviceId: String = DeviceIdentity.get(context)
    private val repo = LexNovaRepository(
        ApiClient({ deviceId }, { prefs.serverUrl }),
    )

    var state by mutableStateOf(UiState())
        private set

    private var pollJob: Job? = null
    private var countdownJob: Job? = null

    val shakeDetector = ShakeDetector(context) { onShakeDetected() }

    init {
        if (prefs.shakeEnabled) {
            shakeDetector.start()
            ShakeGuardService.start(context)
        }
        shakeDetector.setSensitivity(prefs.shakeSensitivity)
        refreshAll()
    }

    fun refreshAll() {
        viewModelScope.launch {
            state = state.copy(serverStatus = ServerStatus.CHECKING, error = null)
            try {
                if (!repo.health()) {
                    state = state.copy(serverStatus = ServerStatus.OFFLINE, error = "Server unreachable at ${prefs.serverUrl}")
                    return@launch
                }
                state = state.copy(serverStatus = ServerStatus.ONLINE)
                val device = repo.me()
                // Sync the local responder opt-in with the server profile.
                if (device.canRespond != prefs.canRespond) {
                    runCatching { repo.patchMe(canRespond = prefs.canRespond) }
                }
                state = state.copy(device = device)
            } catch (e: ApiError) {
                state = state.copy(serverStatus = ServerStatus.OFFLINE, error = e.message)
            }
        }
    }

    // ------------------------------------------------------------------ SOS

    private fun onShakeDetected() {
        if (state.activeIncident != null) return
        if (countdownJob?.isActive == true) return
        startCountdown()
    }

    fun startCountdown() {
        if (countdownJob?.isActive == true) return
        countdownJob = viewModelScope.launch {
            for (i in 5 downTo 1) {
                state = state.copy(countdown = i)
                delay(1000)
            }
            state = state.copy(countdown = null)
            triggerSos("shake")
        }
    }

    fun cancelCountdown() {
        countdownJob?.cancel()
        countdownJob = null
        state = state.copy(countdown = null)
    }

    fun triggerSos(triggerType: String = "button") {
        if (state.busy || countdownJob?.isActive == true) return
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                // Fire immediately with a quick fix; the live fix is posted after.
                val fix = LocationProvider.quickFix(context)
                val (incident, created) = repo.createSos(triggerType, fix?.latitude, fix?.longitude, fix?.accuracy)
                state = state.copy(busy = false, lastAction = if (created) "Incident created" else "Incident already active")
                startPolling(incident.id)
                postLocationSoon()
                dialVapi(incident.id)
                vibrate()
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            } catch (e: Exception) {
                state = state.copy(busy = false, error = e.message ?: "SOS failed")
            }
        }
    }

    private fun postLocationSoon() {
        viewModelScope.launch {
            val fix = LocationProvider.getFix(context, 8000)
            if (fix != null) {
                runCatching { repo.postLocation(fix.latitude, fix.longitude, fix.accuracy) }
            }
        }
    }

    /**
     * SOS voice uplink: dial the Vapi silent-listen line once per incident.
     * With CALL_PHONE granted the call starts directly; otherwise the dialer
     * opens with the number filled in (one tap, no permission needed).
     */
    private fun dialVapi(incidentId: String) {
        if (prefs.lastDialedIncidentId == incidentId) return
        prefs.lastDialedIncidentId = incidentId
        val number = prefs.vapiNumber
        if (number.isBlank()) {
            state = state.copy(lastAction = "SOS created — no Vapi number set, call skipped")
            return
        }
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED
        val action = if (granted) Intent.ACTION_CALL else Intent.ACTION_DIAL
        val intent = Intent(action, Uri.parse("tel:+$number"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
            state = state.copy(
                lastAction = if (granted) "Dialing Vapi line +$number" else "Vapi line +$number — press call"
            )
        } catch (e: Exception) {
            state = state.copy(lastAction = "Could not open dialer: ${e.message}")
        }
    }

    private fun startPolling(incidentId: String) {
        pollJob?.cancel()
        state = state.copy(incidentPolling = true)
        pollJob = viewModelScope.launch {
            while (isActive) {
                runCatching { repo.getIncident(incidentId) }
                    .onSuccess { view ->
                        state = state.copy(activeIncident = view)
                        if (view.incident.status == "RESOLVED" || view.incident.status == "CANCELLED") {
                            stopPolling()
                            return@launch
                        }
                    }
                delay(3000)
            }
        }
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
        state = state.copy(incidentPolling = false)
    }

    fun clearActiveIncident() {
        stopPolling()
        state = state.copy(activeIncident = null)
    }

    fun cancelIncident(reason: String) {
        val view = state.activeIncident ?: return
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                val core = repo.cancelSos(view.incident.id, reason)
                stopPolling()
                state = state.copy(busy = false, activeIncident = view.copy(incident = core), lastAction = "False alarm cancelled")
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    fun resolveIncident(reason: String) {
        val view = state.activeIncident ?: return
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                val core = repo.resolveSos(view.incident.id, reason)
                stopPolling()
                state = state.copy(busy = false, activeIncident = view.copy(incident = core), lastAction = "Incident resolved")
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    fun postLocationNow() {
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            val fix = LocationProvider.getFix(context, 8000)
            if (fix == null) {
                state = state.copy(busy = false, error = "No location fix available (check permission / GPS)")
            } else {
                try {
                    repo.postLocation(fix.latitude, fix.longitude, fix.accuracy)
                    state = state.copy(busy = false, lastAction = "Location updated on server")
                } catch (e: ApiError) {
                    state = state.copy(busy = false, error = e.message)
                }
            }
        }
    }

    // ---------------------------------------------------------------- Nearby

    fun refreshNearby() {
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                val fix = LocationProvider.quickFix(context)
                state = state.copy(busy = false, nearbyIncidents = repo.nearby(fix?.latitude, fix?.longitude))
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    fun respondTo(incidentId: String, action: String) {
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                repo.respond(incidentId, action)
                val fix = LocationProvider.quickFix(context)
                state = state.copy(busy = false, nearbyIncidents = repo.nearby(fix?.latitude, fix?.longitude))
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    // -------------------------------------------------------------- Contacts

    fun loadContacts() {
        viewModelScope.launch {
            try {
                state = state.copy(contacts = repo.contacts())
            } catch (e: ApiError) {
                state = state.copy(error = e.message)
            }
        }
    }

    fun addContact(name: String, phone: String, priority: Int?) {
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                repo.addContact(name, phone, priority)
                state = state.copy(busy = false, contacts = repo.contacts())
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    fun deleteContact(id: String) {
        viewModelScope.launch {
            state = state.copy(busy = true, error = null)
            try {
                repo.deleteContact(id)
                state = state.copy(busy = false, contacts = repo.contacts())
            } catch (e: ApiError) {
                state = state.copy(busy = false, error = e.message)
            }
        }
    }

    // -------------------------------------------------------------- Settings

    fun setServerUrl(url: String) {
        prefs.serverUrl = url
        refreshAll()
    }

    fun setDisplayName(name: String) {
        prefs.displayName = name.ifBlank { null }
        viewModelScope.launch {
            try {
                state = state.copy(device = repo.patchMe(displayName = prefs.displayName))
            } catch (e: ApiError) {
                state = state.copy(error = e.message)
            }
        }
    }

    fun setCanRespond(value: Boolean) {
        prefs.canRespond = value
        viewModelScope.launch {
            try {
                state = state.copy(device = repo.patchMe(canRespond = value))
            } catch (e: ApiError) {
                state = state.copy(error = e.message)
            }
        }
    }

    fun setShakeEnabled(value: Boolean) {
        prefs.shakeEnabled = value
        if (value) {
            shakeDetector.start()
            ShakeGuardService.start(context)
        } else {
            shakeDetector.stop()
            ShakeGuardService.stop(context)
        }
    }

    fun setShakeSensitivity(value: Int) {
        prefs.shakeSensitivity = value
        shakeDetector.setSensitivity(value)
    }

    fun setVapiNumber(digits: String) {
        prefs.vapiNumber = digits
    }

    fun dismissError() {
        state = state.copy(error = null)
    }

    fun clearLastAction() {
        state = state.copy(lastAction = null)
    }

    private fun vibrate() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            manager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (vibrator.hasVibrator()) {
            vibrator.vibrate(VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }
}
