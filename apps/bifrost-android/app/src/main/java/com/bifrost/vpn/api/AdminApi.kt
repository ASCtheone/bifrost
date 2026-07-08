package com.bifrost.vpn.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class AdminSpark(
    val id: String,
    val name: String,
    val status: String,
    val role: String,
    val wanIp: String?,
    val location: String?,
    val ispName: String?,
    val speedDown: Int?,
    val ownerEmail: String?,
)

data class AdminDevice(
    val id: String,
    val name: String,
    val type: String,
    val status: String,
    val assignedIp: String,
    val enabled: Boolean,
    val ownerEmail: String?,
)

data class AdminUser(
    val username: String,
    val displayName: String,
    val email: String,
    val enabled: Boolean,
    val groups: List<String>,
    val status: String,
)

data class AdminSummary(
    val authorized: Boolean,
    val sparks: Int = 0,
    val sparksOnline: Int = 0,
    val devices: Int = 0,
)

class AdminApi(private val apiUrl: String, private val token: String) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$apiUrl$path")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        val response = client.newCall(request).execute()
        val body = response.body?.string() ?: throw Exception("Empty response")
        JSONObject(body)
    }

    suspend fun getSummary(): AdminSummary {
        val json = get("/admin/dashboard")
        if (!json.optBoolean("authorized")) return AdminSummary(authorized = false)
        val counts = json.optJSONObject("counts")
        return AdminSummary(
            authorized = true,
            sparks = counts?.optInt("sparks") ?: 0,
            sparksOnline = counts?.optInt("sparksOnline") ?: 0,
            devices = counts?.optInt("devices") ?: 0,
        )
    }

    suspend fun getSparks(): List<AdminSpark> {
        val json = get("/admin/dashboard?section=sparks")
        val arr = json.optJSONArray("sparks") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val s = arr.getJSONObject(i)
            val geo = s.optJSONObject("geo")
            AdminSpark(
                id = s.getString("id"),
                name = s.getString("name"),
                status = s.optString("status", "offline"),
                role = s.optString("role", "secondary"),
                wanIp = s.optString("wanIp", null),
                location = if (geo != null) "${geo.optString("city")}, ${geo.optString("country")}" else null,
                ispName = s.optString("ispName", null),
                speedDown = if (s.has("speedDown") && !s.isNull("speedDown")) s.optInt("speedDown") else null,
                ownerEmail = s.optString("ownerEmail", null),
            )
        }
    }

    suspend fun getDevices(): List<AdminDevice> {
        val json = get("/admin/dashboard?section=devices")
        val arr = json.optJSONArray("devices") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val d = arr.getJSONObject(i)
            AdminDevice(
                id = d.getString("id"),
                name = d.getString("name"),
                type = d.optString("type", "laptop"),
                status = d.optString("status", "pending"),
                assignedIp = d.optString("assignedIp", ""),
                enabled = d.optBoolean("enabled", true),
                ownerEmail = d.optString("ownerEmail", null),
            )
        }
    }

    suspend fun getUsers(): List<AdminUser> {
        val json = get("/admin/dashboard?section=users")
        val arr = json.optJSONArray("users") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val u = arr.getJSONObject(i)
            val groups = mutableListOf<String>()
            val ga = u.optJSONArray("groups")
            if (ga != null) for (j in 0 until ga.length()) groups.add(ga.getString(j))
            AdminUser(
                username = u.optString("username", ""),
                displayName = u.optString("displayName", ""),
                email = u.optString("email", ""),
                enabled = u.optBoolean("enabled", true),
                groups = groups,
                status = u.optString("status", ""),
            )
        }
    }
}
