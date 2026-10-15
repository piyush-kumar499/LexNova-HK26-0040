package com.safealert.app.data.repository

import com.safealert.app.core.model.Contact
import com.safealert.app.core.model.CreateContactRequest
import com.safealert.app.core.network.Result
import com.safealert.app.core.network.RetrofitClient

class ContactRepository {

    suspend fun createContact(request: CreateContactRequest): Result<Contact> {
        return try {
            val contact = RetrofitClient.apiService.createContact(request)
            Result.Success(contact)
        } catch (t: Throwable) {
            Result.Error(t)
        }
    }

    suspend fun getContacts(userId: String): Result<List<Contact>> {
        return try {
            val contacts = RetrofitClient.apiService.getContacts(userId)
            Result.Success(contacts)
        } catch (t: Throwable) {
            Result.Error(t)
        }
    }
}
