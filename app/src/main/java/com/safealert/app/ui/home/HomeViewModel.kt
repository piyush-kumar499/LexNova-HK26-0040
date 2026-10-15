package com.safealert.app.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.safealert.app.core.network.Result
import com.safealert.app.data.repository.HealthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class HomeViewModel : ViewModel() {

    private val _uiState = MutableStateFlow<Result<String>>(Result.Loading)
    val uiState: StateFlow<Result<String>> = _uiState.asStateFlow()

    private val healthRepository = HealthRepository()

    init {
        loadHealth()
    }

    fun loadHealth() {
        viewModelScope.launch {
            _uiState.value = Result.Loading
            val result = healthRepository.getHealth()
            _uiState.value = result
        }
    }
}
