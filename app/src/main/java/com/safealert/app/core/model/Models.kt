package com.safealert.app.core.model

import kotlinx.serialization.Serializable

@Serializable
data class HealthResponse(val status: String)

@Serializable
data class CreateEmergencyRequest(val userId: String, val lat: Double, val lng: Double)

@Serializable
data class CreateEmergencyResponse(val id: String)

@Serializable
data class LocationRequest(val lat: Double, val lng: Double)

@Serializable
data class CreateContactRequest(val userId: String, val name: String, val phone: String)

@Serializable
data class Contact(val id: String, val userId: String, val name: String, val phone: String)

@Serializable
data class CreateCheckinRequest(val userId: String, val dueAt: String)

@Serializable
data class Checkin(val id: String, val userId: String, val dueAt: String, val status: String)

@Serializable
data class Place(val name: String, val type: String, val lat: Double, val lng: Double)
