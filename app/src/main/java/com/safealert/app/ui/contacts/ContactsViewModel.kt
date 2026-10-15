package com.safealert.app.ui.contacts

import androidx.lifecycle.ViewModel
import com.safealert.app.core.model.Contact
import com.safealert.app.core.network.Result
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class ContactsViewModel : ViewModel() {

    private val _uiState = MutableStateFlow<Result<List<Contact>>>(Result.Loading)
    val uiState: StateFlow<Result<List<Contact>>> = _uiState.asStateFlow()

    init {
        // placeholder for feature: load contacts
        _uiState.value = Result.Success(emptyList())
    }
}
