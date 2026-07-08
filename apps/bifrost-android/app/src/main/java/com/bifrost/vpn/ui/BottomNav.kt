package com.bifrost.vpn.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class AppTab { VPN, SPARKS, DEVICES, USERS, SETTINGS }

data class TabItem(
    val tab: AppTab,
    val label: String,
    val icon: ImageVector,
    val adminOnly: Boolean = false,
)

val tabs = listOf(
    TabItem(AppTab.VPN, "VPN", Icons.Outlined.Shield),
    TabItem(AppTab.SPARKS, "Sparks", Icons.Outlined.Bolt, adminOnly = true),
    TabItem(AppTab.DEVICES, "Devices", Icons.Outlined.Devices, adminOnly = true),
    TabItem(AppTab.USERS, "Users", Icons.Outlined.People, adminOnly = true),
    TabItem(AppTab.SETTINGS, "Settings", Icons.Outlined.Settings),
)

@Composable
fun BottomNavBar(
    activeTab: AppTab,
    isAdmin: Boolean,
    onTabChange: (AppTab) -> Unit,
) {
    val visibleTabs = if (isAdmin) tabs else tabs.filter { !it.adminOnly }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(BifrostColors.navBg),
    ) {
        // Top border
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(BifrostColors.border))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 1.dp)
                .padding(horizontal = 4.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            visibleTabs.forEach { item ->
                val isActive = item.tab == activeTab
                Column(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onTabChange(item.tab) }
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        imageVector = item.icon,
                        contentDescription = item.label,
                        tint = if (isActive) BifrostColors.accent else BifrostColors.textDisabled,
                        modifier = Modifier.size(22.dp),
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        item.label,
                        color = if (isActive) BifrostColors.accent else BifrostColors.textDisabled,
                        fontSize = 10.sp,
                        fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}
