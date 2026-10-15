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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.lexnova.safety.ui.theme.TextDim

@Composable
fun ContactsScreen(vm: MainViewModel) {
    val state = vm.state
    var showAdd by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Trusted contacts", style = MaterialTheme.typography.titleMedium)
                Text(
                    "These are your emergency contacts on the server. The escalation service notifies them per policy.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
            Button(onClick = { showAdd = true }, enabled = !state.busy) {
                Icon(Icons.Filled.Add, contentDescription = "Add contact")
                Text(" Add")
            }
        }
        Spacer(Modifier.height(12.dp))
        if (state.contacts.isEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Text(
                    "No trusted contacts yet. Add one now.",
                    modifier = Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = TextDim,
                )
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.contacts, key = { it.id }) { contact ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(contact.contactName, style = MaterialTheme.typography.titleSmall)
                                Text(
                                    "${contact.phoneNumber} · priority ${contact.priority ?: "default"}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = TextDim,
                                )
                            }
                            IconButton(
                                onClick = { vm.deleteContact(contact.id) },
                                enabled = !state.busy,
                            ) {
                                Icon(Icons.Filled.Delete, contentDescription = "Delete contact")
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAdd) {
        var name by remember { mutableStateOf("") }
        var phone by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showAdd = false },
            title = { Text("Add trusted contact") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("Name") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = phone,
                        onValueChange = { phone = it },
                        label = { Text("Phone number") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = { showAdd = false; vm.addContact(name.trim(), phone.trim(), null) },
                    enabled = name.isNotBlank() && phone.isNotBlank(),
                ) { Text("Add") }
            },
            dismissButton = {
                TextButton(onClick = { showAdd = false }) { Text("Cancel") }
            },
        )
    }
}
