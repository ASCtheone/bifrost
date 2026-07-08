package com.bifrost.vpn.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class NodeConfig(
    val nodeId: String,
    val name: String,
    val serverName: String,
    val endpoint: String,
    val port: Int,
    val wgConfig: String,
    val location: String?,
    val role: String?,
    val ispName: String?,
    val speedDown: Int?,
    val speedUp: Int?,
) {
    val isPrimary: Boolean get() = role == "primary"
}

data class DeviceConfig(
    val deviceId: String,
    val name: String,
    val wgConfig: String,
    val assignedIp: String,
    val nodes: List<NodeConfig>,
)

class BifrostApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun fetchProvision(provisionUrl: String): DeviceConfig = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(provisionUrl)
            .get()
            .build()

        val response = client.newCall(request).execute()
        val body = response.body?.string() ?: throw Exception("Empty response")

        if (!response.isSuccessful) {
            val error = try {
                JSONObject(body).optString("error", "Unknown error")
            } catch (_: Exception) {
                "HTTP ${response.code}"
            }
            throw Exception(error)
        }

        val json = JSONObject(body)

        val nodes = mutableListOf<NodeConfig>()
        val nodesArray = json.optJSONArray("nodes")
        if (nodesArray != null) {
            for (i in 0 until nodesArray.length()) {
                val n = nodesArray.getJSONObject(i)
                nodes.add(
                    NodeConfig(
                        nodeId = n.getString("nodeId"),
                        name = n.getString("name"),
                        serverName = n.optString("serverName", ""),
                        endpoint = n.optString("endpoint", ""),
                        port = n.optInt("port", 51820),
                        wgConfig = n.getString("wgConfig"),
                        location = n.optString("location", null),
                        role = n.optString("role", null),
                        ispName = n.optString("ispName", null),
                        speedDown = if (n.has("speedDown") && !n.isNull("speedDown")) n.optInt("speedDown") else null,
                        speedUp = if (n.has("speedUp") && !n.isNull("speedUp")) n.optInt("speedUp") else null,
                    )
                )
            }
        }

        // Fallback: if no nodes array, use the top-level config
        if (nodes.isEmpty() && json.has("config")) {
            nodes.add(
                NodeConfig(
                    nodeId = "default",
                    name = "Default",
                    serverName = "",
                    endpoint = "",
                    port = 0,
                    wgConfig = json.getString("config"),
                    location = null,
                    role = null,
                    ispName = null,
                    speedDown = null,
                    speedUp = null,
                )
            )
        }

        DeviceConfig(
            deviceId = json.getString("deviceId"),
            name = json.getString("name"),
            wgConfig = nodes.firstOrNull()?.wgConfig ?: "",
            assignedIp = json.optString("assignedIp", ""),
            nodes = nodes,
        )
    }
}
