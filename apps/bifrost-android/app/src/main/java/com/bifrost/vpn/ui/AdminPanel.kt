package com.bifrost.vpn.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bifrost.vpn.api.*

enum class AdminTab { SUMMARY, SPARKS, DEVICES, USERS }

@Composable
fun AdminPanel(
    visible: Boolean,
    needsLogin: Boolean = false,
    loginError: String? = null,
    summary: AdminSummary?,
    sparks: List<AdminSpark>,
    devices: List<AdminDevice>,
    users: List<AdminUser>,
    activeTab: AdminTab,
    loading: Boolean,
    onLogin: (String, String) -> Unit = { _, _ -> },
    onTabChange: (AdminTab) -> Unit,
    onDismiss: () -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        enter = slideInVertically { it },
        exit = slideOutVertically { it },
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(BifrostColors.bgPrimary.copy(alpha = 0.95f))
                .pointerInput(Unit) {
                    detectVerticalDragGestures { _, dragAmount ->
                        if (dragAmount > 50) onDismiss()
                    }
                },
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Handle bar
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp, bottom = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .width(40.dp)
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(BifrostColors.bgInput),
                    )
                }

                // Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Admin Panel", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold, fontFamily = Audiowide)
                    TextButton(onClick = onDismiss) {
                        Text("Close", color = BifrostColors.textDisabled, fontSize = 12.sp)
                    }
                }

                // Login form
                if (needsLogin) {
                    AdminLoginForm(loading = loading, error = loginError, onLogin = onLogin)
                    return@Column
                }

                // Tabs
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    AdminTabButton("Overview", AdminTab.SUMMARY, activeTab, onTabChange)
                    AdminTabButton("Sparks", AdminTab.SPARKS, activeTab, onTabChange)
                    AdminTabButton("Devices", AdminTab.DEVICES, activeTab, onTabChange)
                    AdminTabButton("Users", AdminTab.USERS, activeTab, onTabChange)
                }

                Spacer(modifier = Modifier.height(12.dp))

                if (loading) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = BifrostColors.accent, modifier = Modifier.size(24.dp))
                    }
                } else {
                    // Content
                    when (activeTab) {
                        AdminTab.SUMMARY -> SummaryContent(summary)
                        AdminTab.SPARKS -> SparksContent(sparks)
                        AdminTab.DEVICES -> DevicesContent(devices)
                        AdminTab.USERS -> UsersContent(users)
                    }
                }
            }
        }
    }
}

@Composable
private fun AdminTabButton(label: String, tab: AdminTab, active: AdminTab, onSelect: (AdminTab) -> Unit) {
    val isActive = tab == active
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (isActive) BifrostColors.accent else BifrostColors.border)
            .clickable { onSelect(tab) }
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(label, color = if (isActive) Color.White else BifrostColors.textTertiary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SummaryContent(summary: AdminSummary?) {
    Column(modifier = Modifier.padding(20.dp)) {
        if (summary == null) {
            Text("Loading...", color = BifrostColors.textDisabled)
            return
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SummaryCard("Sparks", "${summary.sparksOnline}/${summary.sparks}", BifrostColors.success, Modifier.weight(1f))
            SummaryCard("Devices", "${summary.devices}", BifrostColors.accent, Modifier.weight(1f))
        }
    }
}

@Composable
private fun SummaryCard(label: String, value: String, accent: Color, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(value, color = accent, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Text(label, color = BifrostColors.textDisabled, fontSize = 12.sp)
        }
    }
}

@Composable
fun SparksContent(sparks: List<AdminSpark>) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(sparks) { spark ->
            Card(
                shape = RoundedCornerShape(10.dp),
                colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (spark.status == "online") BifrostColors.success else BifrostColors.bgInput),
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(spark.name, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (spark.location != null) Text(spark.location, color = BifrostColors.accent, fontSize = 10.sp)
                            if (spark.wanIp != null) Text(spark.wanIp, color = BifrostColors.textDisabled, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        }
                        if (spark.ownerEmail != null) Text(spark.ownerEmail, color = BifrostColors.textDisabled, fontSize = 9.sp)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            spark.role.uppercase(),
                            color = if (spark.role == "primary") BifrostColors.accent else BifrostColors.textDisabled,
                            fontSize = 9.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        if (spark.speedDown != null) {
                            Text("↓${spark.speedDown} Mbps", color = BifrostColors.success, fontSize = 9.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun DevicesContent(devices: List<AdminDevice>) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(devices) { device ->
            Card(
                shape = RoundedCornerShape(10.dp),
                colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = when (device.type) {
                            "phone" -> Icons.Outlined.PhoneAndroid
                            "tablet" -> Icons.Outlined.Tablet
                            "router" -> Icons.Outlined.Router
                            else -> Icons.Outlined.Laptop
                        },
                        contentDescription = device.type,
                        tint = BifrostColors.textTertiary,
                        modifier = Modifier.size(24.dp),
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(device.name, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text(device.assignedIp, color = BifrostColors.textDisabled, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                        if (device.ownerEmail != null) Text(device.ownerEmail, color = BifrostColors.textDisabled, fontSize = 9.sp)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .background(
                                    when (device.status) {
                                        "provisioned" -> BifrostColors.success.copy(alpha = 0.15f)
                                        "pending" -> BifrostColors.warning.copy(alpha = 0.15f)
                                        else -> BifrostColors.bgInput
                                    }
                                )
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Text(
                                device.status,
                                color = when (device.status) {
                                    "provisioned" -> BifrostColors.success
                                    "pending" -> BifrostColors.warning
                                    else -> BifrostColors.textDisabled
                                },
                                fontSize = 9.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun UsersContent(users: List<AdminUser>) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(users) { user ->
            Card(
                shape = RoundedCornerShape(10.dp),
                colors = CardDefaults.cardColors(containerColor = BifrostColors.bgSurface),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(BifrostColors.accent),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            (user.displayName.ifBlank { user.email }).take(2).uppercase(),
                            color = Color.White,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                    Spacer(modifier = Modifier.width(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            user.displayName.ifBlank { user.email.substringBefore("@") },
                            color = if (user.enabled) Color.White else BifrostColors.textDisabled,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(user.email, color = BifrostColors.textDisabled, fontSize = 10.sp)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (group in user.groups) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(
                                        when (group) {
                                            "superadmin" -> BifrostColors.warning.copy(alpha = 0.15f)
                                            "admin" -> BifrostColors.accent.copy(alpha = 0.15f)
                                            else -> BifrostColors.bgInput
                                        }
                                    )
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            ) {
                                Text(
                                    group,
                                    color = when (group) {
                                        "superadmin" -> BifrostColors.warning
                                        "admin" -> BifrostColors.accent
                                        else -> BifrostColors.textDisabled
                                    },
                                    fontSize = 8.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AdminLoginForm(loading: Boolean, error: String?, onLogin: (String, String) -> Unit) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(32.dp))
        Text("Admin Login", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("Sign in with your admin credentials", color = BifrostColors.textDisabled, fontSize = 12.sp)

        Spacer(modifier = Modifier.height(24.dp))

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Username or email") },
            singleLine = true,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = Color.White,
                unfocusedTextColor = BifrostColors.textTertiary,
                focusedBorderColor = BifrostColors.accent,
                unfocusedBorderColor = BifrostColors.bgInput,
                cursorColor = BifrostColors.accent,
                focusedPlaceholderColor = BifrostColors.textDisabled,
                unfocusedPlaceholderColor = BifrostColors.textDisabled,
            ),
        )

        Spacer(modifier = Modifier.height(10.dp))

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Password") },
            singleLine = true,
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = Color.White,
                unfocusedTextColor = BifrostColors.textTertiary,
                focusedBorderColor = BifrostColors.accent,
                unfocusedBorderColor = BifrostColors.bgInput,
                cursorColor = BifrostColors.accent,
                focusedPlaceholderColor = BifrostColors.textDisabled,
                unfocusedPlaceholderColor = BifrostColors.textDisabled,
            ),
        )

        if (error != null) {
            Spacer(modifier = Modifier.height(10.dp))
            Text(error, color = BifrostColors.error, fontSize = 12.sp)
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(
            onClick = { onLogin(username, password) },
            modifier = Modifier.fillMaxWidth().height(48.dp),
            shape = RoundedCornerShape(10.dp),
            enabled = username.isNotBlank() && password.isNotBlank() && !loading,
            colors = ButtonDefaults.buttonColors(containerColor = BifrostColors.accent),
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), color = Color.White, strokeWidth = 2.dp)
            } else {
                Text("Sign In", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
