package com.safealert.app.di

import android.content.Context
import com.safealert.app.data.repository.ContactRepository
import com.safealert.app.data.repository.HealthRepository
import com.safealert.app.data.repository.UserRepository

/**
 * Manual dependency container for SafeAlert.
 * Builds repositories and exposes them to the app.
 * Replaces Hilt for this simple setup.
 */
class AppContainer(context: Context) {

    val userRepository: UserRepository = UserRepository.create(context)
    val healthRepository: HealthRepository = HealthRepository()
    val contactRepository: ContactRepository = ContactRepository()
}
