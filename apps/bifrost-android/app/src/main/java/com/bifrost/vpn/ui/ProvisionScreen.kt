package com.bifrost.vpn.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bifrost.vpn.R

val Audiowide = FontFamily(Font(R.font.audiowide))

@Composable
fun ProvisionScreen(
    provisioning: Boolean,
    error: String?,
    onProvisionUrl: (String) -> Unit,
    onScanQr: () -> Unit,
    onLogin: (String, String) -> Unit,
) {
    var showLogin by remember { mutableStateOf(false) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BifrostColors.bgPrimary)
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // Logo
        Image(
            painter = painterResource(R.drawable.bifrost_logo),
            contentDescription = "Bifrost",
            modifier = Modifier.size(72.dp),
        )
        Spacer(modifier = Modifier.height(12.dp))
        Text(
            text = "BIFROST",
            color = Color.White,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = Audiowide,
            letterSpacing = 4.sp,
        )
        Text(
            text = "VPN",
            color = BifrostColors.textDisabled,
            fontSize = 14.sp,
            fontFamily = Audiowide,
            letterSpacing = 2.sp,
        )

        Spacer(modifier = Modifier.height(48.dp))

        if (!showLogin) {
            // Main options
            Text("Connect to your network", color = BifrostColors.textTertiary, fontSize = 16.sp, textAlign = TextAlign.Center)

            Spacer(modifier = Modifier.height(32.dp))

            // Scan QR
            Button(
                onClick = onScanQr,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = BifrostColors.accent),
                enabled = !provisioning,
            ) {
                Text("Scan QR Code", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Sign In
            OutlinedButton(
                onClick = { showLogin = true },
                modifier = Modifier.fillMaxWidth().height(56.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = BifrostColors.textTertiary),
            ) {
                Text("Sign In", fontSize = 16.sp)
            }
        } else {
            // Login form
            Text("Sign In", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(20.dp))

            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Username or email") },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
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
                visualTransformation = PasswordVisualTransformation(),
                shape = RoundedCornerShape(12.dp),
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

            Spacer(modifier = Modifier.height(16.dp))

            Button(
                onClick = { onLogin(username, password) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(12.dp),
                enabled = username.isNotBlank() && password.isNotBlank() && !provisioning,
                colors = ButtonDefaults.buttonColors(containerColor = BifrostColors.accent),
            ) {
                if (provisioning) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Text("Sign In", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            TextButton(onClick = { showLogin = false }) {
                Text("Back", color = BifrostColors.textDisabled)
            }
        }

        // Error
        if (error != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = BifrostColors.error.copy(alpha = 0.3f)),
            ) {
                Text(text = error, modifier = Modifier.padding(12.dp), color = BifrostColors.error.copy(alpha = 0.7f), fontSize = 13.sp)
            }
        }
    }
}
