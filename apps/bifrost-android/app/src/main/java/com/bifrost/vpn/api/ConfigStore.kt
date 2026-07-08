package com.bifrost.vpn.api

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

private val Context.dataStore by preferencesDataStore(name = "bifrost_config")

private val KEY_DEVICE_NAME = stringPreferencesKey("device_name")
private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
private val KEY_ASSIGNED_IP = stringPreferencesKey("assigned_ip")
private val KEY_NODES_JSON = stringPreferencesKey("nodes_json")
private val KEY_PROVISION_URL = stringPreferencesKey("provision_url")
private val KEY_IS_ADMIN = stringPreferencesKey("is_admin")

data class StoredConfig(
    val deviceId: String,
    val deviceName: String,
    val assignedIp: String,
    val nodes: List<NodeConfig>,
    val provisionUrl: String? = null,
    val isAdmin: Boolean = false,
) {
    val wgConfig: String get() = nodes.firstOrNull()?.wgConfig ?: ""
}

class ConfigStore(private val context: Context) {

    suspend fun save(config: DeviceConfig, provisionUrl: String? = null, isAdmin: Boolean = false) {
        val nodesJson = JSONArray().apply {
            config.nodes.forEach { n ->
                put(JSONObject().apply {
                    put("nodeId", n.nodeId)
                    put("name", n.name)
                    put("serverName", n.serverName)
                    put("endpoint", n.endpoint)
                    put("port", n.port)
                    put("wgConfig", n.wgConfig)
                if (n.location != null) put("location", n.location)
                if (n.role != null) put("role", n.role)
                if (n.ispName != null) put("ispName", n.ispName)
                if (n.speedDown != null) put("speedDown", n.speedDown)
                if (n.speedUp != null) put("speedUp", n.speedUp)
                })
            }
        }

        context.dataStore.edit { prefs ->
            prefs[KEY_DEVICE_ID] = config.deviceId
            prefs[KEY_DEVICE_NAME] = config.name
            prefs[KEY_ASSIGNED_IP] = config.assignedIp
            prefs[KEY_NODES_JSON] = nodesJson.toString()
            if (provisionUrl != null) prefs[KEY_PROVISION_URL] = provisionUrl
            prefs[KEY_IS_ADMIN] = if (isAdmin) "true" else "false"
        }
    }

    suspend fun load(): StoredConfig? {
        val prefs = context.dataStore.data.first()
        val nodesStr = prefs[KEY_NODES_JSON] ?: return null

        val nodes = mutableListOf<NodeConfig>()
        val arr = JSONArray(nodesStr)
        for (i in 0 until arr.length()) {
            val n = arr.getJSONObject(i)
            nodes.add(
                NodeConfig(
                    nodeId = n.getString("nodeId"),
                    name = n.getString("name"),
                    serverName = n.optString("serverName", ""),
                    endpoint = n.optString("endpoint", ""),
                    port = n.optInt("port", 0),
                    wgConfig = n.getString("wgConfig"),
                    location = n.optString("location", null),
                    role = n.optString("role", null),
                    ispName = n.optString("ispName", null),
                    speedDown = if (n.has("speedDown") && !n.isNull("speedDown")) n.optInt("speedDown") else null,
                    speedUp = if (n.has("speedUp") && !n.isNull("speedUp")) n.optInt("speedUp") else null,
                )
            )
        }

        if (nodes.isEmpty()) return null

        return StoredConfig(
            deviceId = prefs[KEY_DEVICE_ID] ?: "",
            deviceName = prefs[KEY_DEVICE_NAME] ?: "Bifrost",
            assignedIp = prefs[KEY_ASSIGNED_IP] ?: "",
            nodes = nodes,
            provisionUrl = prefs[KEY_PROVISION_URL],
            isAdmin = prefs[KEY_IS_ADMIN] == "true",
        )
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }
}
