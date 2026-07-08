package com.bifrost.vpn.tunnel

import android.content.Context

object TunnelSingleton {
    @Volatile
    private var instance: TunnelManager? = null

    fun get(context: Context): TunnelManager {
        return instance ?: synchronized(this) {
            instance ?: TunnelManager(context.applicationContext).also { instance = it }
        }
    }
}
