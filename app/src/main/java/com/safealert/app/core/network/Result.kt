package com.safealert.app.core.network

/**
 * Result sealed class representing the status of an operation.
 * UI code should never crash on network failure when using Result.
 */
sealed class Result<out T> {
    data class Success<out T>(val data: T) : Result<T>()
    data class Error(val error: Throwable) : Result<Nothing>()
    object Loading : Result<Nothing>()
}
