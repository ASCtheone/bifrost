package com.bifrost.vpn.tunnel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import com.bifrost.vpn.MainActivity
import com.bifrost.vpn.R

class BifrostVpnService : VpnService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> startForegroundWithNotification(
                intent.getStringExtra(EXTRA_NODE_NAME) ?: "Bifrost VPN"
            )
            ACTION_DISCONNECT -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startForegroundWithNotification(nodeName: String) {
        createChannel()

        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_IMMUTABLE,
        )

        val disconnectIntent = PendingIntent.getService(
            this, 1,
            Intent(this, BifrostVpnService::class.java).apply {
                action = ACTION_DISCONNECT
            },
            PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("Bifrost VPN Connected")
            .setContentText("Connected to $nodeName")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Disconnect", disconnectIntent).build())
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()

        startForeground(NOTIFICATION_ID, notification)
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "VPN Status",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows when Bifrost VPN is connected"
            setShowBadge(false)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "bifrost_vpn_status"
        const val NOTIFICATION_ID = 1
        const val ACTION_CONNECT = "com.bifrost.vpn.CONNECT"
        const val ACTION_DISCONNECT = "com.bifrost.vpn.DISCONNECT"
        const val EXTRA_NODE_NAME = "node_name"

        fun showConnected(context: Context, nodeName: String) {
            val intent = Intent(context, BifrostVpnService::class.java).apply {
                action = ACTION_CONNECT
                putExtra(EXTRA_NODE_NAME, nodeName)
            }
            context.startForegroundService(intent)
        }

        fun hideNotification(context: Context) {
            val intent = Intent(context, BifrostVpnService::class.java).apply {
                action = ACTION_DISCONNECT
            }
            context.startService(intent)
        }
    }
}
