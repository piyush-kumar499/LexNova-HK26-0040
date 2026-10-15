package com.safealert.app.core.network

import com.safealert.app.core.model.Contact
import com.safealert.app.core.model.Checkin
import com.safealert.app.core.model.CreateCheckinRequest
import com.safealert.app.core.model.CreateContactRequest
import com.safealert.app.core.model.CreateEmergencyRequest
import com.safealert.app.core.model.CreateEmergencyResponse
import com.safealert.app.core.model.HealthResponse
import com.safealert.app.core.model.LocationRequest
import com.safealert.app.core.model.Place
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface ApiService {
    @GET("health")
    suspend fun health(): HealthResponse

    @POST("emergencies")
    suspend fun emergency(@Body request: CreateEmergencyRequest): CreateEmergencyResponse

    @POST("emergencies/{id}/location")
    suspend fun setEmergencyLocation(@Path("id") id: String, @Body request: LocationRequest)

    @POST("emergencies/{id}/resolve")
    suspend fun emergencyResolve(@Path("id") id: String)

    @GET("contacts/{userId}")
    suspend fun getContacts(@Path("userId") userId: String): List<Contact>

    @POST("contacts")
    suspend fun createContact(@Body request: CreateContactRequest): Contact

    @POST("checkins")
    suspend fun createCheckin(@Body request: CreateCheckinRequest): Checkin

    @POST("checkins/{id}/ok")
    suspend fun checkinOk(@Path("id") id: String)

    @GET("places")
    suspend fun getPlaces(@Query("lat") lat: Double, @Query("lng") lng: Double): List<Place>
}
