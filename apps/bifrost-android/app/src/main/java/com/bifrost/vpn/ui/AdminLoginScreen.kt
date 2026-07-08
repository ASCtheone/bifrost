package com.bifrost.vpn.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AdminLoginScreen(
    loading: Boolean,
    error: String?,
    onLogin: (String, String) -> Unit,
) {
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
        Text("Admin Access", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, fontFamily = Audiowide)
        Spacer(modifier = Modifier.height(4.dp))
        Text("Sign in to manage sparks & devices", color = BifrostColors.textDisabled, fontSize = 12.sp)

        Spacer(modifier = Modifier.height(28.dp))

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
            visualTransformation = PasswordVisualTransformation(),
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

        Spacer(modifier = Modifier.height(20.dp))

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
