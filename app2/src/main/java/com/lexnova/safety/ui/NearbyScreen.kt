package com.lexnova.safety.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.lexnova.safety.MainViewModel
import com.lexnova.safety.data.NearbyIncident
import com.lexnova.safety.ui.theme.SOSEmergency
import com.lexnova.safety.ui.theme.TealAccent
import com.lexnova.safety.ui.theme.TextDim

@Composable
fun NearbyScreen(vm: MainViewModel) {
    val state = vm.state
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Offer help nearby", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "When on, nearby SOS incidents around your last known location appear here. Accepting makes you a responder for that incident only.",
                            style = MaterialTheme.typography.bodySmall,
                            color = TextDim,
                        )
                    }
                    Switch(
                        checked = vm.prefs.canRespond,
                        onCheckedChange = { vm.setCanRespond(it) },
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.refreshNearby() }, enabled = !state.busy) {
                        Text("Refresh nearby")
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        if (!vm.prefs.canRespond) {
            Text(
                "Responding is off. Turn on 'Offer help nearby' to see incidents.",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            return
        }
        if (state.nearbyIncidents.isEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Text(
                    "No active incidents near you right now. This list refreshes manually — tap Refresh.",
                    modifier = Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
            return
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.nearbyIncidents, key = { it.incidentId }) { incident ->
                NearbyIncidentCard(incident = incident, busy = state.busy, vm = vm)
            }
        }
    }
}

@Composable
private fun NearbyIncidentCard(incident: NearbyIncident, busy: Boolean, vm: MainViewModel) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "≈ ${incident.approximateDistanceM} m away",
                    style = MaterialTheme.typography.titleSmall,
                    color = SOSEmergency,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    incident.status,
                    style = MaterialTheme.typography.labelMedium,
                    color = TealAccent,
                )
            }
            Text(
                "Trigger: ${incident.triggerType ?: "unknown"} · since ${incident.activatedAt.replace('T', ' ').take(19)}",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            Text(
                "Your status: ${incident.responderStatus}",
                style = MaterialTheme.typography.bodySmall,
                color = TealAccent,
            )
            Text(
                "You see an approximate distance only — exact location is shared after you accept.",
                style = MaterialTheme.typography.bodySmall,
                color = TextDim,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (incident.responderStatus) {
                    "NOTIFIED" -> {
                        Button(onClick = { vm.respondTo(incident.incidentId, "ACCEPT") }, enabled = !busy) {
                            Text("Accept")
                        }
                        OutlinedButton(onClick = { vm.respondTo(incident.incidentId, "DECLINE") }, enabled = !busy) {
                            Text("Decline")
                        }
                    }
                    "ACCEPTED" -> {
                        Button(onClick = { vm.respondTo(incident.incidentId, "EN_ROUTE") }, enabled = !busy) {
                            Text("I'm on the way")
                        }
                        OutlinedButton(onClick = { vm.respondTo(incident.incidentId, "WITHDRAW") }, enabled = !busy) {
                            Text("Withdraw")
                        }
                    }
                    "EN_ROUTE" -> {
                        Button(onClick = { vm.respondTo(incident.incidentId, "ARRIVED") }, enabled = !busy) {
                            Text("I arrived")
                        }
                        OutlinedButton(onClick = { vm.respondTo(incident.incidentId, "WITHDRAW") }, enabled = !busy) {
                            Text("Withdraw")
                        }
                    }
                    "ARRIVED" -> Text("You arrived. Help is recorded per your actions only.", style = MaterialTheme.typography.bodySmall)
                    "DECLINED" -> Text("You declined this incident.", style = MaterialTheme.typography.bodySmall)
                    "WITHDRAWN" -> Text("You withdrew from this incident.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
