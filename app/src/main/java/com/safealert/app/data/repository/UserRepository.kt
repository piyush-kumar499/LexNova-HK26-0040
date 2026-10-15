package com.safealert.app.data.repository

import android.content.Context
import com.safealert.app.core.datastore.UserPrefs
import kotlinx.coroutines.flow.Flow

class UserRepository(private val userPrefs: UserPrefs) {

    companion object {
        fun create(context: Context): UserRepository =
            UserRepository(UserPrefs.create(context))
    }

    val deviceUserId: Flow<String> = userPrefs.deviceUserId

    suspend fun getOrCreateId(): String = userPrefs.getOrCreateId()
    suspend fun refreshId(): String = userPrefs.refreshId()
}
