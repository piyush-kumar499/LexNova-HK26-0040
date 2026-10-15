package com.lexnova.safety.data

import com.lexnova.safety.core.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.TimeUnit

class ApiError(val code: String, override val message: String) : Exception("$code: $message")

data class DeviceInfo(
    val deviceId: String,
    val displayName: String?,
    val phoneNumber: String?,
    val canRespond: Boolean,
    val isActive: Boolean,
    val lastSeenAt: String?,
)

data class IncidentCore(
    val id: String,
    val status: String,
    val triggerType: String?,
    val activatedAt: String,
    val deviceTimestamp: String?,
    val escalationLevel: Int,
    val clientRequestId: String?,
    val cancelReason: String?,
    val resolutionReason: String?,
    val cancelledAt: String?,
    val resolvedAt: String?,
    val createdAt: String,
    val updatedAt: String,
)

data class ResponderView(
    val deviceId: String,
    val status: String,
    val distanceAtNotifyM: Int?,
    val notifiedAt: String?,
    val acceptedAt: String?,
    val enRouteAt: String?,
    val arrivedAt: String?,
    val declinedAt: String?,
    val withdrawnAt: String?,
)

data class CallView(
    val id: String,
    val provider: String,
    val status: String,
    val recipientReference: String?,
    val level: Int?,
    val startedAt: String?,
    val answeredAt: String?,
    val endedAt: String?,
    val endedReason: String?,
    val hasTranscript: Boolean,
)

data class EvidenceView(
    val id: String,
    val kind: String,
    val mediaType: String?,
    val storageRef: String,
    val capturedAt: String?,
)

data class IncidentView(
    val incident: IncidentCore,
    val location: Pair<Double, Double>?,
    val accuracy: Double?,
    val evidence: List<EvidenceView>,
    val responders: List<ResponderView>,
    val calls: List<CallView>,
    val viewerRole: String,
)

data class NearbyIncident(
    val incidentId: String,
    val status: String,
    val triggerType: String?,
    val approximateDistanceM: Int,
    val activatedAt: String,
    val responderStatus: String,
)

data class Contact(
    val id: String,
    val contactName: String,
    val phoneNumber: String,
    val priority: Int?,
)

private fun jsonOrNull(obj: JSONObject, key: String): JSONObject? =
    if (obj.isNull(key)) null else obj.optJSONObject(key)

private fun intOrNull(obj: JSONObject, key: String): Int? =
    if (obj.isNull(key)) null else obj.optInt(key, 0)

private fun strOrNull(obj: JSONObject, key: String): String? =
    if (obj.isNull(key)) null else obj.optString(key)

fun parseDevice(obj: JSONObject): DeviceInfo = DeviceInfo(
    deviceId = obj.getString("deviceId"),
    displayName = strOrNull(obj, "displayName"),
    phoneNumber = strOrNull(obj, "phoneNumber"),
    canRespond = obj.optBoolean("canRespond", false),
    isActive = obj.optBoolean("isActive", true),
    lastSeenAt = strOrNull(obj, "lastSeenAt"),
)

fun parseIncident(obj: JSONObject): IncidentCore = IncidentCore(
    id = obj.getString("id"),
    status = obj.optString("status", "UNKNOWN"),
    triggerType = strOrNull(obj, "triggerType"),
    activatedAt = obj.optString("activatedAt"),
    deviceTimestamp = strOrNull(obj, "deviceTimestamp"),
    escalationLevel = obj.optInt("escalationLevel", 0),
    clientRequestId = strOrNull(obj, "clientRequestId"),
    cancelReason = strOrNull(obj, "cancelReason"),
    resolutionReason = strOrNull(obj, "resolutionReason"),
    cancelledAt = strOrNull(obj, "cancelledAt"),
    resolvedAt = strOrNull(obj, "resolvedAt"),
    createdAt = obj.optString("createdAt"),
    updatedAt = obj.optString("updatedAt"),
)

private fun parseResponder(obj: JSONObject): ResponderView = ResponderView(
    deviceId = obj.optString("deviceId"),
    status = obj.optString("status", "UNKNOWN"),
    distanceAtNotifyM = intOrNull(obj, "distanceAtNotifyM"),
    notifiedAt = strOrNull(obj, "notifiedAt"),
    acceptedAt = strOrNull(obj, "acceptedAt"),
    enRouteAt = strOrNull(obj, "enRouteAt"),
    arrivedAt = strOrNull(obj, "arrivedAt"),
    declinedAt = strOrNull(obj, "declinedAt"),
    withdrawnAt = strOrNull(obj, "withdrawnAt"),
)

private fun parseCall(obj: JSONObject): CallView = CallView(
    id = obj.optString("id"),
    provider = obj.optString("provider", "unknown"),
    status = obj.optString("status", "UNKNOWN"),
    recipientReference = strOrNull(obj, "recipientReference"),
    level = intOrNull(obj, "level"),
    startedAt = strOrNull(obj, "startedAt"),
    answeredAt = strOrNull(obj, "answeredAt"),
    endedAt = strOrNull(obj, "endedAt"),
    endedReason = strOrNull(obj, "endedReason"),
    hasTranscript = obj.optBoolean("hasTranscript", false),
)

private fun parseEvidence(obj: JSONObject): EvidenceView = EvidenceView(
    id = obj.optString("id"),
    kind = obj.optString("kind"),
    mediaType = strOrNull(obj, "mediaType"),
    storageRef = obj.optString("storageRef"),
    capturedAt = strOrNull(obj, "capturedAt"),
)

fun parseIncidentView(obj: JSONObject): IncidentView {
    val location = jsonOrNull(obj, "location")
    return IncidentView(
        incident = parseIncident(obj.getJSONObject("incident")),
        location = location?.let { it.getDouble("latitude") to it.getDouble("longitude") },
        accuracy = location?.let { if (it.isNull("accuracy")) null else it.optDouble("accuracy", 0.0) },
        evidence = obj.optJSONArray("evidence")?.let { arr ->
            (0 until arr.length()).map { parseEvidence(arr.getJSONObject(it)) }
        } ?: emptyList(),
        responders = obj.optJSONArray("responders")?.let { arr ->
            (0 until arr.length()).map { parseResponder(arr.getJSONObject(it)) }
        } ?: emptyList(),
        calls = obj.optJSONArray("calls")?.let { arr ->
            (0 until arr.length()).map { parseCall(arr.getJSONObject(it)) }
        } ?: emptyList(),
        viewerRole = jsonOrNull(obj, "viewer")?.optString("role", "OWNER") ?: "OWNER",
    )
}

private fun parseNearby(obj: JSONObject): NearbyIncident = NearbyIncident(
    incidentId = obj.optString("incidentId"),
    status = obj.optString("status", "UNKNOWN"),
    triggerType = strOrNull(obj, "triggerType"),
    approximateDistanceM = obj.optInt("approximateDistanceM", 0),
    activatedAt = obj.optString("activatedAt"),
    responderStatus = obj.optString("responderStatus", "UNKNOWN"),
)

private fun parseContact(obj: JSONObject): Contact = Contact(
    id = obj.optString("id"),
    contactName = obj.optString("contactName"),
    phoneNumber = obj.optString("phoneNumber"),
    priority = intOrNull(obj, "priority"),
)

class ApiClient(
    private val deviceIdProvider: () -> String,
    private val urlProvider: () -> String,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun baseUrl() = try {
        urlProvider().toHttpUrl()
    } catch (e: IllegalArgumentException) {
        throw ApiError("INVALID_URL", "Server URL invalid: ${urlProvider()}")
    }

    private fun request(builder: Request.Builder): Request =
        builder.header("X-Device-Id", deviceIdProvider()).build()

    private fun url(path: String, query: Map<String, String> = emptyMap()): Request {
        val b = baseUrl().resolve(path)?.newBuilder() ?: throw ApiError("INVALID_URL", "Server URL invalid")
        query.forEach { (k, v) -> b.addQueryParameter(k, v) }
        return request(Request.Builder().url(b.build()))
    }

    private fun jsonBody(body: JSONObject) = body.toString().toRequestBody(jsonMedia)

    suspend fun get(path: String, query: Map<String, String> = emptyMap()): JSONObject =
        execute(url(path, query))

    suspend fun post(path: String, body: JSONObject): JSONObject =
        execute(request(Request.Builder().url(baseUrl().resolve(path)!!).post(jsonBody(body))))

    suspend fun patch(path: String, body: JSONObject): JSONObject =
        execute(request(Request.Builder().url(baseUrl().resolve(path)!!).patch(jsonBody(body))))

    suspend fun delete(path: String): JSONObject =
        execute(request(Request.Builder().url(baseUrl().resolve(path)!!).delete()))

    private suspend fun execute(request: Request): JSONObject = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { resp ->
                val bodyText = resp.body?.string().orEmpty()
                val parsed = if (bodyText.isBlank()) JSONObject() else JSONObject(bodyText)
                if (!resp.isSuccessful) {
                    val err = parsed.optJSONObject("error")
                    throw ApiError(
                        err?.optString("code") ?: "HTTP_${resp.code}",
                        err?.optString("message") ?: "Request failed (HTTP ${resp.code})",
                    )
                }
                parsed
            }
        } catch (e: ApiError) {
            throw e
        } catch (e: IOException) {
            throw ApiError("NETWORK", e.message ?: "Network failure")
        }
    }
}

class LexNovaRepository(private val api: ApiClient) {

    suspend fun health(): Boolean =
        runCatching { api.get("/health").optString("status") == "ok" }.getOrDefault(false)

    suspend fun me(): DeviceInfo = parseDevice(api.get("/device/me").getJSONObject("device"))

    suspend fun patchMe(displayName: String? = null, canRespond: Boolean? = null): DeviceInfo {
        val body = JSONObject()
        displayName?.let { body.put("displayName", it) }
        canRespond?.let { body.put("canRespond", it) }
        return parseDevice(api.patch("/device/me", body).getJSONObject("device"))
    }

    suspend fun postLocation(lat: Double, lng: Double, accuracy: Double?) {
        val body = JSONObject()
            .put("latitude", lat)
            .put("longitude", lng)
            .put("accuracy", accuracy ?: JSONObject.NULL)
            .put("capturedAt", nowIso())
        api.post("/device/location", body)
    }

    suspend fun createSos(
        triggerType: String,
        lat: Double?,
        lng: Double?,
        accuracy: Double?,
    ): Pair<IncidentCore, Boolean> {
        val body = JSONObject().put("triggerType", triggerType)
        if (lat != null && lng != null) {
            body.put("latitude", lat).put("longitude", lng)
            if (accuracy != null) body.put("locationAccuracy", accuracy)
        }
        body.put("deviceTimestamp", nowIso())
        body.put("clientRequestId", UUID.randomUUID().toString())
        val resp = api.post("/sos", body)
        return parseIncident(resp.getJSONObject("incident")) to resp.optBoolean("created", false)
    }

    suspend fun getIncident(id: String): IncidentView =
        parseIncidentView(api.get("/sos/$id"))

    suspend fun cancelSos(id: String, reason: String): IncidentCore =
        parseIncident(api.post("/sos/$id/cancel", JSONObject().put("reason", reason)).getJSONObject("incident"))

    suspend fun resolveSos(id: String, reason: String): IncidentCore =
        parseIncident(
            api.post("/sos/$id/resolve", JSONObject().put("resolutionReason", reason))
                .getJSONObject("incident"),
        )

    suspend fun respond(id: String, action: String) {
        api.post("/sos/$id/respond", JSONObject().put("action", action))
    }

    suspend fun nearby(lat: Double?, lng: Double?): List<NearbyIncident> {
        val query = mutableMapOf<String, String>()
        if (lat != null && lng != null) {
            query["latitude"] = lat.toString()
            query["longitude"] = lng.toString()
        }
        val arr: JSONArray = api.get("/nearby/sos", query).optJSONArray("incidents") ?: JSONArray()
        return (0 until arr.length()).map { parseNearby(arr.getJSONObject(it)) }
    }

    suspend fun contacts(): List<Contact> {
        val arr: JSONArray = api.get("/contacts").optJSONArray("contacts") ?: JSONArray()
        return (0 until arr.length()).map { parseContact(arr.getJSONObject(it)) }
    }

    suspend fun addContact(name: String, phone: String, priority: Int?): Contact {
        val body = JSONObject().put("contactName", name).put("phoneNumber", phone)
        if (priority != null) body.put("priority", priority)
        return parseContact(api.post("/contacts", body).getJSONObject("contact"))
    }

    suspend fun deleteContact(id: String) {
        api.delete("/contacts/$id")
    }

    private fun nowIso(): String = OffsetDateTime.now().toString()
}
