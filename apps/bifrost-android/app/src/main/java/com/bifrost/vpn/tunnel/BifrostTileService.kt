package com.bifrost.vpn.tunnel

import android.content.Intent
import android.graphics.drawable.Icon
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.bifrost.vpn.MainActivity
import com.bifrost.vpn.R
import com.bifrost.vpn.api.ConfigStore
import kotlinx.coroutines.*

class BifrostTileService : TileService() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override fun onStartListening() {
        super.onStartListening()
        updateTile()
    }

    override fun onClick() {
        super.onClick()
        val tm = TunnelSingleton.get(applicationContext)
        val store = ConfigStore(applicationContext)

        scope.launch {
            if (tm.isConnected) {
                tm.disconnect()
            } else {
                val config = store.load() ?: run {
                    openApp()
                    return@launch
                }
                val node = config.nodes.firstOrNull() ?: run {
                    openApp()
                    return@launch
                }
                tm.connect(node.wgConfig, nodeName = node.name)
            }
            delay(500)
            updateTile()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    private fun openApp() {
        val intent = Intent(applicationContext, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        startActivityAndCollapse(intent)
    }

    private fun updateTile() {
        val tile = qsTile ?: return
        val tm = TunnelSingleton.get(applicationContext)
        val store = ConfigStore(applicationContext)

        scope.launch {
            val config = store.load()
            val nodeName = config?.nodes?.firstOrNull()?.name ?: "Bifrost"

            if (tm.isConnected) {
                tile.state = Tile.STATE_ACTIVE
                tile.label = "Bifrost VPN"
                tile.subtitle = nodeName
            } else {
                tile.state = Tile.STATE_INACTIVE
                tile.label = "Bifrost VPN"
                tile.subtitle = "Tap to connect"
            }
            tile.icon = Icon.createWithResource(this@BifrostTileService, R.drawable.ic_tile)
            tile.updateTile()
        }
    }
}
