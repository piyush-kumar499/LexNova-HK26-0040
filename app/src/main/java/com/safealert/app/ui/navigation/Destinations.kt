package com.safealert.app.ui.navigation

/**
 * Navigation destinations for SafeAlert.
 * Each route corresponds to a bottom navigation tab.
 */
object Destinations {
    const val HOME = "home"
    const val CONTACTS = "contacts"
    const val CHECKIN = "checkin"
    const val NEARBY = "nearby"
    const val SETTINGS = "settings"

    val ALL = listOf(HOME, CONTACTS, CHECKIN, NEARBY, SETTINGS)
}
