package com.safealert.app.ui.settings

import androidx.lifecycle.ViewModel
import com.safealert.app.core.network.Result
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class SettingsViewModel : ViewModel() {

    private val _uiState = MutableStateFlow<Result<Unit>>(Result.Loading)
    val uiState: StateFlow<Result<Unit>> = _uiState.asStateFlow()

    private val _displayedId = MutableStateFlow("--")
    val displayedId: StateFlow<String> = _displayedId.asStateFlow()

    init {
        // placeholder for feature: read device user id from DataStore
        _displayedId.value = "device_0a1b".take(10)
        _uiState.value = Result.Success(Unit)
    }
}
