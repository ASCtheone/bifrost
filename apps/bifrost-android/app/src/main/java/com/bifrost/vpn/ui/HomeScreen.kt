package com.bifrost.vpn.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bifrost.vpn.R
import com.bifrost.vpn.api.NodeConfig
import com.bifrost.vpn.api.StoredConfig
import com.bifrost.vpn.tunnel.TunnelState
import com.bifrost.vpn.tunnel.TunnelStatus

@Composable
fun HomeScreen(
    config: StoredConfig,
    selectedNodeId: String?,
    tunnel: TunnelStatus,
    syncing: Boolean,
    onToggle: () -> Unit,
    onSelectNode: (String) -> Unit,
    onSync: () -> Unit = {},
    onLogout: () -> Unit = {},
) {
    val isConnected = tunnel.state == TunnelState.CONNECTED
    val isConnecting = tunnel.state == TunnelState.CONNECTING
    val selectedNode = config.nodes.find { it.nodeId == selectedNodeId } ?: config.nodes.firstOrNull()

    val accentColor by animateColorAsState(
        if (isConnected) BifrostColors.success else BifrostColors.accent,
        label = "accent",
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BifrostColors.bgPrimary)
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        // Top bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painter = painterResource(R.drawable.bifrost_logo), contentDescription = "Bifrost", modifier = Modifier.size(24.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("BIFROST", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold, fontFamily = Audiowide, letterSpacing = 2.sp)
            }
            if (syncing) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), color = Color(0xFF3B82F6), strokeWidth = 2.dp)
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Node selector
        if (config.nodes.size > 1) {
            Text("Select Location", color = BifrostColors.textDisabled, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
            Spacer(modifier = Modifier.height(8.dp))
        }

        val sortedNodes = remember(config.nodes) {
            config.nodes.sortedByDescending { it.isPrimary }
        }

        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            items(sortedNodes) { node ->
                NodeCard(
                    node = node,
                    isSelected = node.nodeId == selectedNodeId,
                    isConnected = isConnected && node.nodeId == selectedNodeId,
                    onClick = { onSelectNode(node.nodeId) },
                )
            }
        }

        Spacer(modifier = Modifier.weight(0.6f))

        // Status
        Text(
            text = config.deviceName,
            color = BifrostColors.textDisabled,
            fontSize = 12.sp,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = when (tunnel.state) {
                TunnelState.CONNECTED -> "Connected to ${selectedNode?.name ?: "node"}"
                TunnelState.CONNECTING -> "Connecting..."
                TunnelState.ERROR -> "Connection Failed"
                TunnelState.DISCONNECTED -> "Not Connected"
            },
            color = when (tunnel.state) {
                TunnelState.CONNECTED -> Color(0xFF10B981)
                TunnelState.CONNECTING -> Color(0xFF3B82F6)
                TunnelState.ERROR -> BifrostColors.error
                TunnelState.DISCONNECTED -> BifrostColors.textDisabled
            },
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Power button
        Box(
            modifier = Modifier
                .size(160.dp)
                .clip(CircleShape)
                .background(accentColor.copy(alpha = 0.06f))
                .clickable(
                    enabled = !isConnecting && selectedNode != null,
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { onToggle() },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier.size(120.dp).clip(CircleShape).background(accentColor.copy(alpha = 0.10f)),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier.size(84.dp).clip(CircleShape).background(accentColor.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (isConnecting) {
                        CircularProgressIndicator(modifier = Modifier.size(32.dp), color = accentColor, strokeWidth = 3.dp)
                    } else {
                        Image(painter = painterResource(R.drawable.bifrost_logo), contentDescription = "Connect", modifier = Modifier.size(48.dp))
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // IP
        if (config.assignedIp.isNotBlank()) {
            Card(shape = RoundedCornerShape(8.dp), colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface)) {
                Text(config.assignedIp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp), color = BifrostColors.textTertiary, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Stats
        if (isConnected) {
            Row(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(BifrostColors.bgSurface).padding(14.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                StatColumn("Download", formatBytes(tunnel.rxBytes))
                Box(Modifier.width(1.dp).height(32.dp).background(BifrostColors.border))
                StatColumn("Upload", formatBytes(tunnel.txBytes))
            }
        }

        if (tunnel.error != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Card(shape = RoundedCornerShape(10.dp), colors = CardDefaults.cardColors(containerColor = Color(0xFF450A0A))) {
                Text(tunnel.error!!, modifier = Modifier.padding(12.dp), color = Color(0xFFFCA5A5), fontSize = 12.sp)
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        if (!isConnected && !isConnecting && selectedNode != null) {
            Text("Tap to connect", color = BifrostColors.bgInput, fontSize = 11.sp)
        }

    }
}

@Composable
private fun NodeCard(
    node: NodeConfig,
    isSelected: Boolean,
    isConnected: Boolean,
    onClick: () -> Unit,
) {
    val goldColor = BifrostColors.warning
    val borderColor = when {
        isConnected -> Color(0xFF10B981)
        isSelected -> Color(0xFF3B82F6)
        node.isPrimary -> goldColor.copy(alpha = 0.5f)
        else -> BifrostColors.border
    }
    val bgColor = when {
        isConnected -> Color(0xFF10B981).copy(alpha = 0.08f)
        isSelected -> Color(0xFF3B82F6).copy(alpha = 0.08f)
        node.isPrimary -> goldColor.copy(alpha = 0.04f)
        else -> BifrostColors.bgSurface
    }

    Column(
        modifier = Modifier
            .width(if (node.isPrimary) 130.dp else 110.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(bgColor)
            .border(if (node.isPrimary) 2.dp else 1.5.dp, borderColor, RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Primary badge or status dot
        if (node.isPrimary) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Text("⭐", fontSize = 10.sp)
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    "PRIMARY",
                    color = goldColor,
                    fontSize = 8.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp,
                )
            }
        } else {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (isConnected) Color(0xFF10B981) else BifrostColors.bgInput),
            )
        }
        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = node.name,
            color = when {
                isSelected -> Color.White
                node.isPrimary -> goldColor
                else -> BifrostColors.textTertiary
            },
            fontSize = if (node.isPrimary) 13.sp else 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(modifier = Modifier.height(2.dp))
        if (!node.location.isNullOrBlank()) {
            Text(
                text = node.location!!,
                color = Color(0xFF3B82F6),
                fontSize = 10.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (node.speedDown != null) {
            Text(
                text = "↓${node.speedDown} ↑${node.speedUp ?: 0} Mbps",
                color = Color(0xFF10B981),
                fontSize = 9.sp,
                maxLines = 1,
            )
        }
        if (!node.ispName.isNullOrBlank()) {
            Text(
                text = node.ispName!!,
                color = BifrostColors.textDisabled,
                fontSize = 8.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun StatColumn(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(2.dp))
        Text(label, color = BifrostColors.textDisabled, fontSize = 10.sp)
    }
}

private fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${"%.1f".format(bytes.toDouble() / 1024)} KB"
    bytes < 1024 * 1024 * 1024 -> "${"%.1f".format(bytes.toDouble() / (1024 * 1024))} MB"
    else -> "${"%.2f".format(bytes.toDouble() / (1024 * 1024 * 1024))} GB"
}
