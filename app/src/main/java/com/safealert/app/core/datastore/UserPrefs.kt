package com.safealert.app.core.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.userDataStore: DataStore<Preferences> by preferencesDataStore(name = "safealert_prefs")

class UserPrefs(private val context: Context) {

    companion object {
        val DEVICE_USER_ID_KEY = stringPreferencesKey("device_user_id")

        fun create(context: Context): UserPrefs = UserPrefs(context.applicationContext)
    }

    val deviceUserId: Flow<String> = context.userDataStore.data.map { prefs ->
        prefs[DEVICE_USER_ID_KEY] ?: ""
    }

    suspend fun getOrCreateId(): String {
        val existing = context.userDataStore.data.map { it[DEVICE_USER_ID_KEY] }.let { flow ->
            var result: String? = null
            flow.collect { result = it }
            result
        }
        return if (existing.isNullOrEmpty()) {
            val newId = UUID.randomUUID().toString()
            context.userDataStore.edit { it[DEVICE_USER_ID_KEY] = newId }
            newId
        } else {
            existing!!
        }
    }

    suspend fun refreshId(): String {
        val newId = UUID.randomUUID().toString()
        context.userDataStore.edit { it[DEVICE_USER_ID_KEY] = newId }
        return newId
    }
}
