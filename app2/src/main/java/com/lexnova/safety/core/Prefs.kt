package com.lexnova.safety.core

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("lexnova_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() {
            val saved = sp.getString("server_url", null)
            // A stored legacy USB-testing default is not a real choice — fall
            // back to the live server so the app works out of the box.
            if (saved == null || saved == LEGACY_USB_DEFAULT) return DEFAULT_SERVER_URL
            return saved
        }
        set(value) {
            sp.edit().putString("server_url", value.trim().trimEnd('/')).apply()
        }

    var displayName: String?
        get() = sp.getString("display_name", null)
        set(value) {
            if (value == null) sp.edit().remove("display_name").apply()
            else sp.edit().putString("display_name", value.trim()).apply()
        }

    var canRespond: Boolean
        get() = sp.getBoolean("can_respond", true)
        set(value) { sp.edit().putBoolean("can_respond", value).apply() }

    var shakeEnabled: Boolean
        get() = sp.getBoolean("shake_enabled", true)
        set(value) { sp.edit().putBoolean("shake_enabled", value).apply() }

    var shakeSensitivity: Int
        get() = sp.getInt("shake_sensitivity", 2)
        set(value) { sp.edit().putInt("shake_sensitivity", value.coerceIn(1, 3)).apply() }

    /** Vapi silent-listen line, digits only (E.164 without the leading +). */
    var vapiNumber: String
        get() = sp.getString("vapi_number", null) ?: DEFAULT_VAPI_NUMBER
        set(value) { sp.edit().putString("vapi_number", value.filter { it.isDigit() }).apply() }

    /** One call per incident — remember which incident already triggered the dial. */
    var lastDialedIncidentId: String?
        get() = sp.getString("last_dialed_incident_id", null)
        set(value) {
            if (value == null) sp.edit().remove("last_dialed_incident_id").apply()
            else sp.edit().putString("last_dialed_incident_id", value).apply()
        }

    /**
     * Nearby incidents this device already rang for. Returns false when the
     * incident was already alerted, true when newly remembered. Capped at 20
     * so the set cannot grow without bound.
     */
    fun markAlerted(incidentId: String): Boolean {
        val set = sp.getStringSet("alerted_incidents", emptySet())?.toMutableSet() ?: mutableSetOf()
        if (!set.add(incidentId)) return false
        while (set.size > 20) set.remove(set.first())
        sp.edit().putStringSet("alerted_incidents", set).apply()
        return true
    }

    companion object {
        // Live server (ngrok tunnel to the Fastify backend). For USB-only
        // testing, switch to http://127.0.0.1:8080 + 'adb reverse tcp:8080 tcp:8080'.
        const val DEFAULT_SERVER_URL = "https://ethanol-cash-peculiar.ngrok-free.dev"
        const val LEGACY_USB_DEFAULT = "http://127.0.0.1:8080"

        // Vapi phone number "sefty" (server/.env: VAPI_PHONE_NUMBER_ID).
        const val DEFAULT_VAPI_NUMBER = "19144651304"
    }
}
