package com.bifrost.vpn.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.bifrost.vpn.api.AdminApi
import com.bifrost.vpn.api.BifrostApi
import com.bifrost.vpn.api.DeviceConfig
import com.bifrost.vpn.api.ConfigStore
import com.bifrost.vpn.api.NodeConfig
import com.bifrost.vpn.api.StoredConfig
import com.bifrost.vpn.tunnel.TunnelSingleton
import com.bifrost.vpn.tunnel.TunnelState
import com.bifrost.vpn.tunnel.TunnelStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

enum class AppScreen {
    LOADING,
    PROVISION,
    QR_SCANNER,
    HOME,
}

data class AppState(
    val screen: AppScreen = AppScreen.LOADING,
    val locked: Boolean = false,
    val config: StoredConfig? = null,
    val selectedNodeId: String? = null,
    val tunnel: TunnelStatus = TunnelStatus(),
    val provisioning: Boolean = false,
    val provisionError: String? = null,
    val syncing: Boolean = false,
    val lastSyncError: String? = null,
    val activeTab: AppTab = AppTab.VPN,
    val isAdminUser: Boolean = false,
    val adminPanelOpen: Boolean = false,
    val adminNeedsLogin: Boolean = false,
    val adminLoginError: String? = null,
    val adminTab: AdminTab = AdminTab.SUMMARY,
    val adminLoading: Boolean = false,
    val adminSummary: com.bifrost.vpn.api.AdminSummary? = null,
    val adminSparks: List<com.bifrost.vpn.api.AdminSpark> = emptyList(),
    val adminDevices: List<com.bifrost.vpn.api.AdminDevice> = emptyList(),
    val adminUsers: List<com.bifrost.vpn.api.AdminUser> = emptyList(),
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val api = BifrostApi()
    private val configStore = ConfigStore(app)
    private val credStore = com.bifrost.vpn.api.SecureCredentialStore(app)
    val tunnelManager = TunnelSingleton.get(app)

    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state

    val selectedNode: NodeConfig?
        get() {
            val s = _state.value
            val nodes = s.config?.nodes ?: return null
            return nodes.find { it.nodeId == s.selectedNodeId } ?: nodes.firstOrNull()
        }

    init {
        // Collect tunnel status
        viewModelScope.launch {
            tunnelManager.status.collect { tunnelStatus ->
                _state.value = _state.value.copy(tunnel = tunnelStatus)
            }
        }

        // Stats refresh when connected
        viewModelScope.launch {
            while (true) {
                delay(2000)
                if (_state.value.tunnel.state == TunnelState.CONNECTED) {
                    tunnelManager.refreshStats()
                }
            }
        }

        // Auto-sync: on error or disconnect, try to refresh config
        viewModelScope.launch {
            var lastState = TunnelState.DISCONNECTED
            while (true) {
                delay(5000)
                val currentState = _state.value.tunnel.state
                if (currentState == TunnelState.ERROR && lastState != TunnelState.ERROR) {
                    // VPN failed — auto-sync to get fresh configs
                    syncSilent()
                }
                lastState = currentState
            }
        }

        // Load saved config
        viewModelScope.launch {
            val saved = configStore.load()
            val hasCreds = credStore.hasCredentials()
            if (saved != null) {
                // If we have saved credentials, we're an admin (even if flag wasn't saved)
                val isAdmin = saved.isAdmin || hasCreds
                _state.value = AppState(
                    screen = AppScreen.HOME,
                    locked = true,
                    config = if (isAdmin && !saved.isAdmin) saved.copy(isAdmin = true) else saved,
                    selectedNodeId = saved.nodes.firstOrNull()?.nodeId,
                    isAdminUser = isAdmin,
                    adminNeedsLogin = isAdmin, // Need to re-auth JWT
                )
                // Auto-sync on launch to get latest node data
                syncSilent()
            } else {
                _state.value = AppState(screen = AppScreen.PROVISION)
            }
        }
    }

    fun setActiveTab(tab: AppTab) {
        _state.value = _state.value.copy(activeTab = tab)
        // Auto-load admin data when switching to admin tabs
        if (tab in listOf(AppTab.SPARKS, AppTab.DEVICES, AppTab.USERS) && adminApi != null) {
            val adminTab = when (tab) {
                AppTab.SPARKS -> AdminTab.SPARKS
                AppTab.DEVICES -> AdminTab.DEVICES
                AppTab.USERS -> AdminTab.USERS
                else -> return
            }
            setAdminTab(adminTab)
        } else if (tab in listOf(AppTab.SPARKS, AppTab.DEVICES, AppTab.USERS) && adminApi == null) {
            _state.value = _state.value.copy(adminNeedsLogin = true)
        }
    }

    fun unlock() {
        _state.value = _state.value.copy(locked = false)
        // Auto-login with saved credentials
        viewModelScope.launch {
            try {
                val creds = credStore.loadCredentials() ?: return@launch
                val cognitoAuth = com.bifrost.vpn.api.CognitoAuth(cognitoRegion, cognitoClientId)
                val tokens = cognitoAuth.login(creds.first, creds.second)
                val baseUrl = _state.value.config?.provisionUrl?.substringBefore("/provision/") ?: apiBaseUrl
                adminApi = AdminApi(baseUrl, tokens.idToken)
                _state.value = _state.value.copy(
                    isAdminUser = true,
                    adminNeedsLogin = false,
                )
                // Also try to refresh provision data
                try {
                    val result = autoProvision(tokens.idToken)
                    if (result != null) {
                        configStore.save(result, _state.value.config?.provisionUrl, isAdmin = true)
                        _state.value = _state.value.copy(
                            config = StoredConfig(
                                deviceId = result.deviceId,
                                deviceName = result.name,
                                assignedIp = result.assignedIp,
                                nodes = result.nodes,
                                provisionUrl = _state.value.config?.provisionUrl,
                                isAdmin = true,
                            ),
                            selectedNodeId = result.nodes.firstOrNull()?.nodeId ?: _state.value.selectedNodeId,
                        )
                    }
                } catch (_: Exception) { /* non-critical */ }
            } catch (_: Exception) {
                // Credentials invalid — keep admin tabs but need re-login
            }
        }
    }

    fun loginFromProvision(username: String, password: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(provisioning = true, provisionError = null)
            try {
                val cognitoAuth = com.bifrost.vpn.api.CognitoAuth(cognitoRegion, cognitoClientId)
                val tokens: com.bifrost.vpn.api.CognitoTokens
                try {
                    tokens = cognitoAuth.login(username, password)
                    // Save credentials encrypted for auto-login
                    credStore.saveCredentials(username, password)
                } catch (e: Exception) {
                    throw Exception("Login failed: ${e.message}")
                }

                // Auto-provision device via API
                val provisionResult: DeviceConfig?
                try {
                    provisionResult = autoProvision(tokens.idToken)
                } catch (e: Exception) {
                    throw Exception("Provision failed: ${e.message}")
                }
                adminApi = AdminApi(apiBaseUrl, tokens.idToken)

                // Check admin status
                var isAdmin = false
                try {
                    val summary = adminApi!!.getSummary()
                    isAdmin = summary.authorized
                } catch (_: Exception) {}

                if (provisionResult != null) {
                    configStore.save(provisionResult, "$apiBaseUrl/provision/${provisionResult.nodes.firstOrNull()?.nodeId ?: ""}", isAdmin)
                    _state.value = AppState(
                        screen = AppScreen.HOME,
                        config = StoredConfig(
                            deviceId = provisionResult.deviceId,
                            deviceName = provisionResult.name,
                            assignedIp = provisionResult.assignedIp,
                            nodes = provisionResult.nodes,
                            provisionUrl = "$apiBaseUrl/auth/provision",
                        ),
                        selectedNodeId = provisionResult.nodes.firstOrNull()?.nodeId,
                        isAdminUser = isAdmin,
                        adminNeedsLogin = false,
                    )
                } else {
                    // Admin with no VPN nodes
                    _state.value = AppState(
                        screen = AppScreen.HOME,
                        isAdminUser = isAdmin,
                        adminNeedsLogin = false,
                        config = StoredConfig(
                            deviceId = "admin",
                            deviceName = username,
                            assignedIp = "",
                            nodes = emptyList(),
                            provisionUrl = "$apiBaseUrl/auth/provision",
                        ),
                    )
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    provisioning = false,
                    provisionError = e.message ?: "Login failed",
                )
            }
        }
    }

    private suspend fun autoProvision(idToken: String): DeviceConfig? {
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val client = okhttp3.OkHttpClient.Builder()
                .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            val request = okhttp3.Request.Builder()
                .url("$apiBaseUrl/auth/provision")
                .header("Authorization", "Bearer $idToken")
                .header("Content-Type", "application/json")
                .post("{}".toByteArray().let { okhttp3.RequestBody.create(null, it) })
                .build()
            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext null
            if (!response.isSuccessful) return@withContext null

            val json = org.json.JSONObject(body)
            if (!json.optBoolean("provisioned")) return@withContext null

            val nodesArr = json.optJSONArray("nodes") ?: return@withContext null
            val nodes = (0 until nodesArr.length()).map { i ->
                val n = nodesArr.getJSONObject(i)
                NodeConfig(
                    nodeId = n.getString("nodeId"),
                    name = n.getString("name"),
                    serverName = "",
                    endpoint = n.optString("endpoint", ""),
                    port = n.optInt("port", 0),
                    wgConfig = n.getString("wgConfig"),
                    location = n.optString("location", null),
                    role = n.optString("role", null),
                    ispName = n.optString("ispName", null),
                    speedDown = if (n.has("speedDown") && !n.isNull("speedDown")) n.optInt("speedDown") else null,
                    speedUp = if (n.has("speedUp") && !n.isNull("speedUp")) n.optInt("speedUp") else null,
                )
            }

            DeviceConfig(
                deviceId = json.getString("deviceId"),
                name = json.getString("name"),
                wgConfig = json.optString("config", ""),
                assignedIp = json.optString("assignedIp", ""),
                nodes = nodes,
            )
        }
    }

    fun selectNode(nodeId: String) {
        viewModelScope.launch {
            if (tunnelManager.isConnected) {
                tunnelManager.disconnect()
            }
            _state.value = _state.value.copy(selectedNodeId = nodeId)
        }
    }

    fun toggleConnection() {
        val node = selectedNode ?: return
        viewModelScope.launch {
            tunnelManager.toggle(node.wgConfig, nodeName = node.name)
        }
    }

    fun sync() {
        viewModelScope.launch {
            val url = _state.value.config?.provisionUrl ?: return@launch
            _state.value = _state.value.copy(syncing = true, lastSyncError = null)
            try {
                val deviceConfig = api.fetchProvision(url)
                configStore.save(deviceConfig, url)
                val selectedId = _state.value.selectedNodeId
                _state.value = _state.value.copy(
                    syncing = false,
                    config = StoredConfig(
                        deviceId = deviceConfig.deviceId,
                        deviceName = deviceConfig.name,
                        assignedIp = deviceConfig.assignedIp,
                        nodes = deviceConfig.nodes,
                        provisionUrl = url,
                    ),
                    selectedNodeId = deviceConfig.nodes.find { it.nodeId == selectedId }?.nodeId
                        ?: deviceConfig.nodes.firstOrNull()?.nodeId,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    syncing = false,
                    lastSyncError = e.message,
                )
            }
        }
    }

    private fun syncSilent() {
        viewModelScope.launch {
            val url = _state.value.config?.provisionUrl ?: return@launch
            try {
                val deviceConfig = api.fetchProvision(url)
                configStore.save(deviceConfig, url)
                val selectedId = _state.value.selectedNodeId
                _state.value = _state.value.copy(
                    config = StoredConfig(
                        deviceId = deviceConfig.deviceId,
                        deviceName = deviceConfig.name,
                        assignedIp = deviceConfig.assignedIp,
                        nodes = deviceConfig.nodes,
                        provisionUrl = url,
                    ),
                    selectedNodeId = deviceConfig.nodes.find { it.nodeId == selectedId }?.nodeId
                        ?: deviceConfig.nodes.firstOrNull()?.nodeId,
                )
            } catch (_: Exception) {
                // Silent — don't update UI on failure
            }
        }
    }

    fun provisionFromUrl(url: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(provisioning = true, provisionError = null)
            try {
                val deviceConfig = api.fetchProvision(url)
                configStore.save(deviceConfig, url)
                val config = StoredConfig(
                    deviceId = deviceConfig.deviceId,
                    deviceName = deviceConfig.name,
                    assignedIp = deviceConfig.assignedIp,
                    nodes = deviceConfig.nodes,
                    provisionUrl = url,
                )
                _state.value = AppState(
                    screen = AppScreen.HOME,
                    config = config,
                    selectedNodeId = config.nodes.firstOrNull()?.nodeId,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    provisioning = false,
                    provisionError = e.message ?: "Provision failed",
                )
            }
        }
    }

    fun provisionFromConfig(wgConfig: String) {
        viewModelScope.launch {
            val node = NodeConfig(
                nodeId = "local",
                name = "Manual",
                serverName = "",
                endpoint = "",
                port = 0,
                wgConfig = wgConfig,
                location = null,
                role = null,
                ispName = null,
                speedDown = null,
                speedUp = null,
            )
            val config = StoredConfig(
                deviceId = "local",
                deviceName = "Bifrost VPN",
                assignedIp = "",
                nodes = listOf(node),
            )
            configStore.save(com.bifrost.vpn.api.DeviceConfig(
                deviceId = config.deviceId,
                name = config.deviceName,
                wgConfig = wgConfig,
                assignedIp = "",
                nodes = listOf(node),
            ))
            _state.value = AppState(
                screen = AppScreen.HOME,
                config = config,
                selectedNodeId = "local",
            )
        }
    }

    fun showQrScanner() {
        _state.value = _state.value.copy(screen = AppScreen.QR_SCANNER)
    }

    fun cancelQrScanner() {
        _state.value = _state.value.copy(screen = AppScreen.PROVISION)
    }

    fun onQrScanned(value: String) {
        _state.value = _state.value.copy(screen = AppScreen.PROVISION)
        if (value.startsWith("http://") || value.startsWith("https://")) {
            provisionFromUrl(value)
        } else if (value.contains("[Interface]")) {
            provisionFromConfig(value)
        } else {
            _state.value = _state.value.copy(
                provisionError = "Invalid QR code — expected a provision URL or WireGuard config",
            )
        }
    }

    // ── Admin Panel ──────────────────────────────────────────

    private var adminApi: AdminApi? = null

    // Cognito config — extracted from the provision URL's API base
    // In production, these would come from app config
    private val cognitoRegion = "us-east-1"
    private val cognitoClientId = "jsqq9hnacm13ohfmnjfvn1bgv"
    private val apiBaseUrl = "https://gc6426p037.execute-api.us-east-1.amazonaws.com"

    fun openAdminPanel() {
        if (adminApi != null) {
            // Already logged in — just open and refresh
            _state.value = _state.value.copy(adminPanelOpen = true, adminTab = AdminTab.SUMMARY)
            setAdminTab(AdminTab.SUMMARY)
            return
        }
        _state.value = _state.value.copy(adminPanelOpen = true, adminNeedsLogin = true, adminLoginError = null)
    }

    fun adminLogin(username: String, password: String) {
        val baseUrl = _state.value.config?.provisionUrl?.substringBefore("/provision/") ?: apiBaseUrl

        viewModelScope.launch {
            _state.value = _state.value.copy(adminLoading = true, adminLoginError = null)
            try {
                val auth = com.bifrost.vpn.api.CognitoAuth(cognitoRegion, cognitoClientId)
                val tokens = auth.login(username, password)
                credStore.saveCredentials(username, password)
                adminApi = AdminApi(baseUrl, tokens.idToken)

                _state.value = _state.value.copy(adminNeedsLogin = false, isAdminUser = true)
                // Persist admin flag
                val config = _state.value.config
                if (config != null) {
                    configStore.save(
                        DeviceConfig(config.deviceId, config.deviceName, config.wgConfig, config.assignedIp, config.nodes),
                        config.provisionUrl,
                        isAdmin = true,
                    )
                }
                // Load data for current tab
                setActiveTab(_state.value.activeTab)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    adminLoading = false,
                    adminLoginError = e.message ?: "Login failed",
                )
            }
        }
    }

    fun closeAdminPanel() {
        _state.value = _state.value.copy(adminPanelOpen = false)
    }

    fun setAdminTab(tab: AdminTab) {
        _state.value = _state.value.copy(adminTab = tab, adminLoading = true)
        val api = adminApi ?: return
        viewModelScope.launch {
            try {
                when (tab) {
                    AdminTab.SUMMARY -> {
                        val summary = api.getSummary()
                        _state.value = _state.value.copy(adminSummary = summary, adminLoading = false)
                    }
                    AdminTab.SPARKS -> {
                        val sparks = api.getSparks()
                        _state.value = _state.value.copy(adminSparks = sparks, adminLoading = false)
                    }
                    AdminTab.DEVICES -> {
                        val devices = api.getDevices()
                        _state.value = _state.value.copy(adminDevices = devices, adminLoading = false)
                    }
                    AdminTab.USERS -> {
                        val users = api.getUsers()
                        _state.value = _state.value.copy(adminUsers = users, adminLoading = false)
                    }
                }
            } catch (_: Exception) {
                _state.value = _state.value.copy(adminLoading = false)
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            if (tunnelManager.isConnected) tunnelManager.disconnect()
            configStore.clear()
            credStore.clear()
            adminApi = null
            _state.value = AppState(screen = AppScreen.PROVISION)
        }
    }
}
