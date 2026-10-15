package com.safealert.app.ui.checkin

import androidx.lifecycle.ViewModel
import com.safealert.app.core.network.Result
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class CheckinViewModel : ViewModel() {

    private val _uiState = MutableStateFlow<Result<Unit>>(Result.Loading)
    val uiState: StateFlow<Result<Unit>> = _uiState.asStateFlow()

    init {
        // placeholder for feature: load active check-in
        _uiState.value = Result.Success(Unit)
    }
}
