package com.lexnova.safety.ui

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lexnova.safety.core.DeviceIdentity
import com.lexnova.safety.core.Prefs
import com.lexnova.safety.data.ApiClient
import com.lexnova.safety.data.LexNovaRepository
import com.lexnova.safety.ui.theme.LexNovaTheme
import com.lexnova.safety.ui.theme.Navy
import com.lexnova.safety.ui.theme.SOSEmergency
import com.lexnova.safety.ui.theme.TextPrimary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Full-screen bystander popup shown over the lock screen when a nearby SOS is
 * detected. Rings the alarm and vibrates until the user responds or dismisses.
 */
class NearbyAlertActivity : ComponentActivity() {

    private var ringtone: MediaPlayer? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)

        val incidentId = intent.getStringExtra(EXTRA_INCIDENT_ID).orEmpty()
        val distanceM = intent.getIntExtra(EXTRA_DISTANCE_M, 0)
        val trigger = intent.getStringExtra(EXTRA_TRIGGER) ?: "SOS"
        val activatedAt = intent.getStringExtra(EXTRA_ACTIVATED_AT).orEmpty()

        setContent {
            LexNovaTheme {
                var responded by remember { mutableStateOf(false) }
                LaunchedEffect(Unit) {
                    startRinging()
                    while (true) {
                        vibrate()
                        delay(1200)
                    }
                }
                Box(
                    Modifier.fillMaxSize().background(SOSEmergency),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        Modifier.padding(24.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            "SOS",
                            color = TextPrimary,
                            fontSize = 64.sp,
                            fontWeight = FontWeight.Black,
                            letterSpacing = 6.sp,
                        )
                        Text(
                            "Someone nearby needs help!",
                            color = TextPrimary,
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            "About $distanceM m away \u2022 triggered by $trigger",
                            color = TextPrimary.copy(alpha = 0.9f),
                            style = MaterialTheme.typography.bodyLarge,
                            textAlign = TextAlign.Center,
                        )
                        if (activatedAt.isNotBlank()) {
                            Text(
                                "Since $activatedAt",
                                color = TextPrimary.copy(alpha = 0.75f),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Spacer(Modifier.height(14.dp))
                        Button(
                            onClick = {
                                responded = true
                                respond("ACCEPT", "Helping now")
                            },
                            enabled = !responded,
                            modifier = Modifier.fillMaxWidth().height(56.dp),
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = TextPrimary,
                                contentColor = Navy,
                            ),
                        ) {
                            Text("I'll help", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        }
                        OutlinedButton(
                            onClick = {
                                responded = true
                                respond("DECLINE", null)
                            },
                            enabled = !responded,
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            shape = RoundedCornerShape(14.dp),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary),
                        ) {
                            Text("Can't right now", fontSize = 16.sp)
                        }
                    }
                }
            }
        }
    }

    private fun respond(action: String, afterText: String?) {
        scope.launch {
            val prefs = Prefs(this@NearbyAlertActivity)
            val repo = LexNovaRepository(
                ApiClient({ DeviceIdentity.get(this@NearbyAlertActivity) }, { prefs.serverUrl }),
            )
            val incidentId = intent.getStringExtra(EXTRA_INCIDENT_ID).orEmpty()
            if (incidentId.isNotBlank()) {
                runCatching { repo.respond(incidentId, action) }
            }
            stopRinging()
            if (afterText != null) {
                delay(400)
            }
            finish()
        }
    }

    private fun startRinging() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: return
            ringtone = MediaPlayer().apply {
                setDataSource(this@NearbyAlertActivity, uri)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {
        }
    }

    private fun stopRinging() {
        try {
            ringtone?.stop()
            ringtone?.release()
        } catch (_: Exception) {
        }
        ringtone = null
    }

    private fun vibrate() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as Vibrator
        }
        if (vibrator.hasVibrator()) {
            vibrator.vibrate(VibrationEffect.createOneShot(400, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_INCIDENT_ID = "incidentId"
        const val EXTRA_DISTANCE_M = "distanceM"
        const val EXTRA_TRIGGER = "trigger"
        const val EXTRA_ACTIVATED_AT = "activatedAt"
    }
}
