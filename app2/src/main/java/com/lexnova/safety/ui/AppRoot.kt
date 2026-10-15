package com.lexnova.safety.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.lexnova.safety.MainViewModel
import com.lexnova.safety.ui.theme.LexNovaTheme
import com.lexnova.safety.ui.theme.SOSEmergency
import com.lexnova.safety.ui.theme.TealAccent

enum class Tab { HOME, NEARBY, CONTACTS, SETTINGS }

@Composable
fun LexNovaApp(vm: MainViewModel) {
    LexNovaTheme {
        var tab by remember { mutableStateOf(Tab.HOME) }
        val state = vm.state

        LaunchedEffect(state.activeIncident != null) {
            if (state.activeIncident != null) tab = Tab.HOME
        }

        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            bottomBar = {
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                    NavigationBarItem(
                        selected = tab == Tab.HOME,
                        onClick = { tab = Tab.HOME },
                        icon = { Icon(Icons.Filled.Warning, contentDescription = "Home") },
                        label = { Text("SOS") },
                    )
                    NavigationBarItem(
                        selected = tab == Tab.NEARBY,
                        onClick = { tab = Tab.NEARBY; vm.refreshNearby() },
                        icon = { Icon(Icons.Filled.Notifications, contentDescription = "Nearby") },
                        label = { Text("Nearby") },
                    )
                    NavigationBarItem(
                        selected = tab == Tab.CONTACTS,
                        onClick = { tab = Tab.CONTACTS; vm.loadContacts() },
                        icon = { Icon(Icons.Filled.Group, contentDescription = "Contacts") },
                        label = { Text("Contacts") },
                    )
                    NavigationBarItem(
                        selected = tab == Tab.SETTINGS,
                        onClick = { tab = Tab.SETTINGS },
                        icon = { Icon(Icons.Filled.Settings, contentDescription = "Settings") },
                        label = { Text("Settings") },
                    )
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (tab) {
                    Tab.HOME -> if (state.activeIncident != null) {
                        ActiveIncidentScreen(vm)
                    } else {
                        HomeScreen(vm)
                    }
                    Tab.NEARBY -> NearbyScreen(vm)
                    Tab.CONTACTS -> ContactsScreen(vm)
                    Tab.SETTINGS -> SettingsScreen(vm)
                }
                CountdownOverlay(vm)
            }
            ErrorBanner(vm)
        }
    }
}

@Composable
fun ErrorBanner(vm: MainViewModel) {
    val error = vm.state.error ?: return
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        colors = CardDefaults.cardColors(containerColor = SOSEmergency.copy(alpha = 0.18f)),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("Problem", style = MaterialTheme.typography.titleSmall, color = SOSEmergency)
            Text(error, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
            Button(onClick = { vm.dismissError() }) { Text("Dismiss") }
        }
    }
}

@Composable
fun CountdownOverlay(vm: MainViewModel) {
    val countdown = vm.state.countdown ?: return
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = SOSEmergency),
            modifier = Modifier.padding(24.dp),
        ) {
            Column(
                Modifier.padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Shake detected!", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(8.dp))
                Text("SOS in $countdown s", style = MaterialTheme.typography.displayMedium)
                Spacer(Modifier.height(16.dp))
                Button(onClick = { vm.cancelCountdown() }) {
                    Text("Cancel — false alarm")
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "Triggered by shake. This would create an emergency incident.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
                )
            }
        }
    }
}

@Composable
fun ServerStatusChip(statusText: String, online: Boolean) {
    Text(
        statusText,
        color = if (online) TealAccent else SOSEmergency,
        style = MaterialTheme.typography.labelMedium,
    )
}
