package com.safealert.app.ui.home

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.safealert.app.R
import com.safealert.app.core.network.Result
import com.safealert.app.ui.common.ErrorCard
import com.safealert.app.ui.common.LoadingIndicator

@Composable
fun HomeScreen(viewModel: HomeViewModel = viewModel()) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.displayLarge
        )

        Button(
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp).height(120.dp),
            onClick = {
                Toast.makeText(
                    context,
                    stringResource(R.string.sos_coming_soon),
                    Toast.LENGTH_SHORT
                ).show()
            }
        ) {
            Text(
                text = stringResource(R.string.sos_button),
                style = MaterialTheme.typography.displayLarge
            )
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
        ) {
            when (val state = uiState) {
                is Result.Loading -> {
                    LoadingIndicator()
                }
                is Result.Success -> {
                    Text(
                        text = stringResource(R.string.connected),
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.bodyLarge
                    )
                }
                is Result.Error -> {
                    ErrorCard(error = state.error)
                }
            }
        }
    }
}
