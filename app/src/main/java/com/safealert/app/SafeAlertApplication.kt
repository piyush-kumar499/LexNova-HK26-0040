package com.safealert.app

import android.app.Application
import com.safealert.app.di.AppContainer

/**
 * SafeAlert Application class.
 * Creates the AppContainer dependency injection container.
 */
class SafeAlertApplication : Application() {

    lateinit var appContainer: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        appContainer = AppContainer(this)
    }
}
