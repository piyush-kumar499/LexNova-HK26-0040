package com.safealert.app.ui.nearby

import androidx.lifecycle.ViewModel
import com.safealert.app.core.model.Place
import com.safealert.app.core.network.Result
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class NearbyViewModel : ViewModel() {

    private val _uiState = MutableStateFlow<Result<List<Place>>>(Result.Loading)
    val uiState: StateFlow<Result<List<Place>>> = _uiState.asStateFlow()

    init {
        // placeholder for feature: load nearby places
        _uiState.value = Result.Success(emptyList())
    }
}
