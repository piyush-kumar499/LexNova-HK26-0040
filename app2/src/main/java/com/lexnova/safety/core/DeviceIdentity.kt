package com.lexnova.safety.core

import android.content.Context
import java.util.UUID

object DeviceIdentity {
    private const val PREFS = "lexnova_device"
    private const val KEY_ID = "device_id"

    fun get(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_ID, id).apply()
        return id
    }
}
