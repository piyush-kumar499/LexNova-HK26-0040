package com.safealert.app.ui.contacts

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.safealert.app.R
import com.safealert.app.ui.common.EmptyState

@Composable
fun ContactsScreen(viewModel: ContactsViewModel = viewModel()) {
    val uiState by viewModel.uiState.collectAsState()

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp)
    ) {
        EmptyState(text = stringResource(R.string.no_trusted_contacts))

        Button(
            modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
            onClick = { /* placeholder for feature: add contact */ }
        ) {
            Text(text = stringResource(R.string.add_contact))
        }
    }
}
