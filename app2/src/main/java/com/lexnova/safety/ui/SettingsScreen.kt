package com.lexnova.safety.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.lexnova.safety.MainViewModel
import com.lexnova.safety.ui.theme.TextDim

@Composable
fun SettingsScreen(vm: MainViewModel) {
    val state = vm.state
    var url by remember { mutableStateOf(vm.prefs.serverUrl) }
    var name by remember { mutableStateOf(vm.prefs.displayName ?: "") }
    var sensitivity by remember { mutableStateOf(vm.prefs.shakeSensitivity) }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.titleMedium)

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Server", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Server URL") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Text(
                    "USB testing: keep http://127.0.0.1:8080 and run 'adb reverse tcp:8080 tcp:8080' on the laptop.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.setServerUrl(url) }, enabled = !state.busy) { Text("Save & reconnect") }
                    OutlinedButton(onClick = { vm.refreshAll() }, enabled = !state.busy) { Text("Test connection") }
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This device", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Display name") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.setDisplayName(name) }, enabled = !state.busy) { Text("Save name") }
                }
                Text("Device ID: ${vm.deviceId}", style = MaterialTheme.typography.bodySmall, color = TextDim)
                state.device?.let {
                    Text(
                        "Server profile: ${it.displayName ?: "(no name)"} · canRespond=${it.canRespond} · active=${it.isActive}",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Shake-to-SOS", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "5 firm shakes in 2 seconds trigger a 5-second countdown before an SOS is created.",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                        )
                    }
                    Switch(checked = vm.prefs.shakeEnabled, onCheckedChange = { vm.setShakeEnabled(it) })
                }
                Text("Sensitivity", style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(1 to "Low", 2 to "Medium", 3 to "High").forEach { (value, label) ->
                        OutlinedButton(
                            onClick = { sensitivity = value; vm.setShakeSensitivity(value) },
                            enabled = !state.busy,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(if (sensitivity == value) "● $label" else label)
                        }
                    }
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Offer help nearby", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "Lets the server show active incidents near your location to you, so you can accept and respond. You stay a normal user — helping is per incident.",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                        )
                    }
                    Switch(checked = vm.prefs.canRespond, onCheckedChange = { vm.setCanRespond(it) })
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("About", style = MaterialTheme.typography.titleSmall)
                Text(
                    "LexNova 0.1.0 · SS-01 foundation build. Backend: Supabase/PostGIS + Fastify with device-based identity. This build talks to the real server API — nothing is mocked.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
        }
    }
}
