package com.safealert.app.data.repository

import com.safealert.app.core.network.Result
import com.safealert.app.core.network.RetrofitClient

class HealthRepository {

    suspend fun getHealth(): Result<String> {
        return try {
            val response = RetrofitClient.apiService.health()
            Result.Success(response.status)
        } catch (t: Throwable) {
            Result.Error(t)
        }
    }
}
