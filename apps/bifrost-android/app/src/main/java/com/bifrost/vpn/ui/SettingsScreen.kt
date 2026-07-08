package com.bifrost.vpn.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bifrost.vpn.api.StoredConfig

@Composable
fun SettingsScreen(
    config: StoredConfig?,
    syncing: Boolean,
    onSync: () -> Unit,
    onLogout: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BifrostColors.bgPrimary)
            .padding(24.dp),
    ) {
        Text("Settings", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, fontFamily = Audiowide)

        Spacer(modifier = Modifier.height(24.dp))

        // Device info
        Card(
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Device", color = BifrostColors.textDisabled, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(8.dp))
                SettingsRow("Name", config?.deviceName ?: "—")
                SettingsRow("ID", config?.deviceId ?: "—")
                SettingsRow("IP", config?.assignedIp ?: "—")
                SettingsRow("Nodes", "${config?.nodes?.size ?: 0}")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Actions
        Card(
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Actions", color = BifrostColors.textDisabled, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                Spacer(modifier = Modifier.height(12.dp))

                Button(
                    onClick = onSync,
                    enabled = !syncing,
                    modifier = Modifier.fillMaxWidth().height(44.dp),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1E3A5F)),
                ) {
                    if (syncing) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), color = BifrostColors.accent, strokeWidth = 2.dp)
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(if (syncing) "Syncing..." else "Sync Configs", color = BifrostColors.accent, fontWeight = FontWeight.SemiBold)
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = onLogout,
                    modifier = Modifier.fillMaxWidth().height(44.dp),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = BifrostColors.error),
                ) {
                    Text("Reset & Sign Out", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = BifrostColors.textDisabled, fontSize = 13.sp)
        Text(value, color = Color.White, fontSize = 13.sp)
    }
}
