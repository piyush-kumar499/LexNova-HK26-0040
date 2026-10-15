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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.lexnova.safety.MainViewModel
import com.lexnova.safety.data.IncidentView
import com.lexnova.safety.ui.theme.Amber
import com.lexnova.safety.ui.theme.SOSEmergency
import com.lexnova.safety.ui.theme.TealAccent
import com.lexnova.safety.ui.theme.TextDim

private fun statusColor(status: String) = when (status) {
    "CANCELLED", "DECLINED", "WITHDRAWN" -> TextDim
    "RESOLVED", "ARRIVED", "ACCEPTED" -> TealAccent
    "EN_ROUTE" -> Amber
    else -> SOSEmergency
}

@Composable
fun ActiveIncidentScreen(vm: MainViewModel) {
    val state = vm.state
    val view = state.activeIncident ?: return
    var showCancel by remember { mutableStateOf(false) }
    var showResolve by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Active incident", style = MaterialTheme.typography.titleMedium, color = TextDim)
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        view.incident.status,
                        style = MaterialTheme.typography.headlineSmall,
                        color = statusColor(view.incident.status),
                    )
                    Spacer(Modifier.weight(1f))
                    if (state.incidentPolling) {
                        Text("live", style = MaterialTheme.typography.labelMedium, color = TealAccent)
                    }
                }
                Text(
                    "Activated ${view.incident.activatedAt.replace('T', ' ').take(19)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                Text(
                    "Trigger: ${view.incident.triggerType ?: "unknown"} · Escalation level ${view.incident.escalationLevel}",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
                view.location?.let {
                    Text(
                        "Location on server: %.5f, %.5f".format(it.first, it.second),
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                } ?: Text(
                    "No location on server yet — tap Update location below.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Amber,
                )
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Responders", style = MaterialTheme.typography.titleSmall)
                if (view.responders.isEmpty()) {
                    Text("No responders yet.", style = MaterialTheme.typography.bodySmall, color = TextDim)
                } else {
                    view.responders.forEach { r ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                r.deviceId.take(8) + "…",
                                style = MaterialTheme.typography.bodySmall,
                                color = TextDim,
                            )
                            Spacer(Modifier.weight(1f))
                            Text(r.status, style = MaterialTheme.typography.labelMedium, color = statusColor(r.status))
                        }
                    }
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Call events", style = MaterialTheme.typography.titleSmall)
                if (view.calls.isEmpty()) {
                    Text(
                        "No calls placed. (Voice uplink to the Vapi line is specified in the README §11, not wired in this build.)",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextDim,
                    )
                } else {
                    view.calls.forEach { c ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(c.provider, style = MaterialTheme.typography.bodySmall, color = TextDim)
                            Spacer(Modifier.weight(1f))
                            Text(c.status, style = MaterialTheme.typography.labelMedium, color = statusColor(c.status))
                        }
                    }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = { vm.postLocationNow() },
                modifier = Modifier.weight(1f),
                enabled = !state.busy,
            ) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Spacer(Modifier.height(0.dp))
                Text(" Update location")
            }
        }

        Button(
            onClick = { showCancel = true },
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.busy &&
                view.incident.status != "CANCELLED" &&
                view.incident.status != "RESOLVED" &&
                view.incident.status != "RESPONDER_ACKNOWLEDGED",
        ) {
            Text("Cancel — false alarm")
        }
        Button(
            onClick = { showResolve = true },
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.busy && view.incident.status == "RESPONDER_ACKNOWLEDGED",
        ) {
            Text("Resolve — help received")
        }
        Button(
            onClick = { vm.clearActiveIncident() },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Filled.ArrowBack, contentDescription = null)
            Text(" Back to home")
        }

        if (showCancel) {
            var reason by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { showCancel = false },
                title = { Text("Cancel this incident?") },
                text = {
                    Column {
                        Text("This records the incident as a false alarm with a reason.")
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = reason,
                            onValueChange = { reason = it },
                            label = { Text("Reason") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = { showCancel = false; if (reason.isNotBlank()) vm.cancelIncident(reason) },
                        enabled = reason.isNotBlank(),
                    ) { Icon(Icons.Filled.Check, contentDescription = null); Text(" Cancel") }
                },
                dismissButton = {
                    TextButton(onClick = { showCancel = false }) { Icon(Icons.Filled.Close, contentDescription = null); Text(" Keep incident") }
                },
            )
        }

        if (showResolve) {
            var reason by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { showResolve = false },
                title = { Text("Resolve incident") },
                text = {
                    Column {
                        Text("Record why this incident is resolved.")
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = reason,
                            onValueChange = { reason = it },
                            label = { Text("Resolution reason") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = { showResolve = false; if (reason.isNotBlank()) vm.resolveIncident(reason) },
                        enabled = reason.isNotBlank(),
                    ) { Icon(Icons.Filled.Check, contentDescription = null); Text(" Resolve") }
                },
                dismissButton = {
                    TextButton(onClick = { showResolve = false }) { Icon(Icons.Filled.Close, contentDescription = null); Text(" Not yet") }
                },
            )
        }
    }
}
