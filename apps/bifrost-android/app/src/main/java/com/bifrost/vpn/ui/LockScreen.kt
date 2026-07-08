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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bifrost.vpn.R

@Composable
fun LockScreen(
    onUnlock: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BifrostColors.bgPrimary)
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.bifrost_logo),
            contentDescription = "Bifrost",
            modifier = Modifier.size(80.dp),
        )
        Spacer(modifier = Modifier.height(16.dp))
        Text("BIFROST", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold, fontFamily = Audiowide, letterSpacing = 4.sp)

        Spacer(modifier = Modifier.height(48.dp))

        Text("🔒", fontSize = 32.sp)
        Spacer(modifier = Modifier.height(12.dp))
        Text("App Locked", color = BifrostColors.textTertiary, fontSize = 16.sp)
        Text("Tap to unlock with biometrics", color = BifrostColors.textDisabled, fontSize = 12.sp)

        Spacer(modifier = Modifier.height(32.dp))

        Button(
            onClick = onUnlock,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(14.dp),
            colors = ButtonDefaults.buttonColors(containerColor = BifrostColors.accent),
        ) {
            Text("Unlock", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}
