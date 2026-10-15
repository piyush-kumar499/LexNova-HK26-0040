package com.lexnova.safety.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.lexnova.safety.MainViewModel
import com.lexnova.safety.ServerStatus
import com.lexnova.safety.ui.theme.SOSEmergency
import com.lexnova.safety.ui.theme.SOSPressed
import com.lexnova.safety.ui.theme.TealAccent
import com.lexnova.safety.ui.theme.TextDim

@Composable
fun HomeScreen(vm: MainViewModel) {
    val state = vm.state
    LaunchedEffect(Unit) { vm.clearLastAction() }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(16.dp))
        Text("LexNova", style = MaterialTheme.typography.headlineMedium)
        Text("Personal Safety & Emergency Response", style = MaterialTheme.typography.bodySmall, color = TextDim)
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            ServerStatusChip(
                statusText = when (state.serverStatus) {
                    ServerStatus.CHECKING -> "Connecting to server…"
                    ServerStatus.ONLINE -> "Server online"
                    ServerStatus.OFFLINE -> "Server offline"
                },
                online = state.serverStatus == ServerStatus.ONLINE,
            )
        }
        Spacer(Modifier.height(40.dp))

        Box(
            modifier = Modifier
                .size(190.dp)
                .clip(CircleShape)
                .background(SOSEmergency)
                .padding(1.dp),
            contentAlignment = Alignment.Center,
        ) {
            Button(
                onClick = { vm.triggerSos("button") },
                enabled = !state.busy,
                modifier = Modifier.fillMaxSize(),
                shape = CircleShape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SOSEmergency,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    disabledContainerColor = SOSPressed,
                ),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("SOS", style = MaterialTheme.typography.displayMedium)
                    Text(
                        if (state.busy) "Sending…" else "Press for emergency",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }

        Spacer(Modifier.height(32.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("How LexNova works", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Pressing SOS creates an incident on the server with your location " +
                        "(if permitted). Nearby LexNova users who opted in to help get notified " +
                        "and can accept. You stay the owner until you cancel or resolve.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                Text(
                    "LexNova does not call police or ambulance. It notifies nearby app users " +
                        "and your trusted contacts — nothing is claimed as delivered unless the " +
                        "server recorded it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (vm.prefs.shakeEnabled) "Shake-to-SOS: ON" else "Shake-to-SOS: OFF",
                        style = MaterialTheme.typography.titleSmall,
                        color = if (vm.prefs.shakeEnabled) TealAccent else TextDim,
                    )
                    Spacer(Modifier.weight(1f))
                    Button(onClick = { vm.setShakeEnabled(!vm.prefs.shakeEnabled) }) {
                        Text(if (vm.prefs.shakeEnabled) "Turn off" else "Turn on")
                    }
                }
                Text(
                    "Shake the phone firmly 5 times to trigger a 5-second SOS countdown. " +
                        "Manage sensitivity in Settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
        }
        state.lastAction?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = TealAccent, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        }
    }
}
