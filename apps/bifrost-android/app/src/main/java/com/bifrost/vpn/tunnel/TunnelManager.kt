package com.bifrost.vpn.tunnel

import android.content.Context
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.StringReader

enum class TunnelState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR
}

data class TunnelStatus(
    val state: TunnelState = TunnelState.DISCONNECTED,
    val error: String? = null,
    val rxBytes: Long = 0,
    val txBytes: Long = 0,
)

class TunnelManager(private val context: Context) {
    private val backend: GoBackend by lazy { GoBackend(context.applicationContext) }
    private var activeTunnel: BifrostTunnel? = null
    private var connectedNodeName: String? = null

    private val _status = MutableStateFlow(TunnelStatus())
    val status: StateFlow<TunnelStatus> = _status

    val isConnected: Boolean
        get() = _status.value.state == TunnelState.CONNECTED

    suspend fun connect(wgConfig: String, tunnelName: String = "bifrost", nodeName: String? = null) = withContext(Dispatchers.IO) {
        try {
            _status.value = TunnelStatus(state = TunnelState.CONNECTING)

            val config = Config.parse(BufferedReader(StringReader(wgConfig)))
            val tunnel = BifrostTunnel(tunnelName)
            activeTunnel = tunnel
            connectedNodeName = nodeName ?: tunnelName

            backend.setState(tunnel, Tunnel.State.UP, config)
            _status.value = TunnelStatus(state = TunnelState.CONNECTED)

            // Show persistent notification
            BifrostVpnService.showConnected(context, connectedNodeName ?: "Bifrost")
        } catch (e: Exception) {
            _status.value = TunnelStatus(state = TunnelState.ERROR, error = e.message)
        }
    }

    suspend fun disconnect() = withContext(Dispatchers.IO) {
        try {
            activeTunnel?.let { tunnel ->
                backend.setState(tunnel, Tunnel.State.DOWN, null)
            }
            activeTunnel = null
            connectedNodeName = null
            _status.value = TunnelStatus(state = TunnelState.DISCONNECTED)

            // Remove notification
            BifrostVpnService.hideNotification(context)
        } catch (e: Exception) {
            _status.value = TunnelStatus(state = TunnelState.ERROR, error = e.message)
        }
    }

    suspend fun toggle(wgConfig: String, nodeName: String? = null) {
        if (isConnected) disconnect() else connect(wgConfig, nodeName = nodeName)
    }

    fun refreshStats(): TunnelStatus {
        val tunnel = activeTunnel ?: return _status.value
        return try {
            val stats = backend.getStatistics(tunnel)
            val updated = _status.value.copy(
                rxBytes = stats.totalRx(),
                txBytes = stats.totalTx(),
            )
            _status.value = updated
            updated
        } catch (_: Exception) {
            _status.value
        }
    }

    private class BifrostTunnel(private val tunnelName: String) : Tunnel {
        override fun getName(): String = tunnelName
        override fun onStateChange(newState: Tunnel.State) {}
    }
}
