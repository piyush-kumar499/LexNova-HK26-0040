package com.safealert.app.ui.common

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ErrorCard(error: Throwable, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth().padding(8.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.error
        )
    ) {
        Text(
            text = "Error: ${error.message ?: "Unknown error"}",
            modifier = Modifier.padding(16.dp),
            color = MaterialTheme.colorScheme.onError,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}
