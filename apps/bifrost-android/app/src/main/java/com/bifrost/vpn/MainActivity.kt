package com.bifrost.vpn

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Bundle
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.viewmodel.compose.viewModel
import com.bifrost.vpn.api.BiometricHelper
import com.bifrost.vpn.ui.*

class MainActivity : FragmentActivity() {

    private var pendingViewModel: MainViewModel? = null
    private lateinit var biometricHelper: BiometricHelper

    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val vm = pendingViewModel ?: return@registerForActivityResult
        if (result.resultCode == RESULT_OK) {
            vm.toggleConnection()
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) pendingViewModel?.showQrScanner()
        else Toast.makeText(this, "Camera permission needed", Toast.LENGTH_SHORT).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        biometricHelper = BiometricHelper(this)

        // Don't draw behind system bars
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, true)

        setContent {
            val vm: MainViewModel = viewModel()
            pendingViewModel = vm
            val state by vm.state.collectAsState()

            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            when (state.screen) {
                AppScreen.LOADING -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Color(0xFF3B82F6))
                    }
                }

                AppScreen.PROVISION -> {
                    ProvisionScreen(
                        provisioning = state.provisioning,
                        error = state.provisionError,
                        onProvisionUrl = { url -> vm.provisionFromUrl(url) },
                        onScanQr = { requestCameraAndScan(vm) },
                        onLogin = { u, p -> vm.loginFromProvision(u, p) },
                    )
                }

                AppScreen.QR_SCANNER -> {
                    QrScannerScreen(
                        onResult = { value -> vm.onQrScanned(value) },
                        onCancel = { vm.cancelQrScanner() },
                    )
                }

                AppScreen.HOME -> {
                    if (state.locked) {
                        LockScreen(onUnlock = { requestBiometric(vm) })
                        // Auto-trigger biometric on first show
                        androidx.compose.runtime.LaunchedEffect(Unit) {
                            requestBiometric(vm)
                        }
                    } else {
                        state.config?.let { config ->
                            Column(Modifier.fillMaxSize()) {
                                Box(Modifier.weight(1f)) {
                                    when (state.activeTab) {
                                        AppTab.VPN -> HomeScreen(
                                            config = config,
                                            selectedNodeId = state.selectedNodeId,
                                            tunnel = state.tunnel,
                                            syncing = state.syncing,
                                            onToggle = { handleToggle(vm) },
                                            onSelectNode = { nodeId -> vm.selectNode(nodeId) },
                                        )
                                        AppTab.SPARKS -> {
                                            if (state.adminNeedsLogin) {
                                                AdminLoginScreen(loading = state.adminLoading, error = state.adminLoginError, onLogin = { u, p -> vm.adminLogin(u, p) })
                                            } else {
                                                SparksContent(state.adminSparks)
                                            }
                                        }
                                        AppTab.DEVICES -> {
                                            if (state.adminNeedsLogin) {
                                                AdminLoginScreen(loading = state.adminLoading, error = state.adminLoginError, onLogin = { u, p -> vm.adminLogin(u, p) })
                                            } else {
                                                DevicesContent(state.adminDevices)
                                            }
                                        }
                                        AppTab.USERS -> {
                                            if (state.adminNeedsLogin) {
                                                AdminLoginScreen(loading = state.adminLoading, error = state.adminLoginError, onLogin = { u, p -> vm.adminLogin(u, p) })
                                            } else {
                                                UsersContent(state.adminUsers)
                                            }
                                        }
                                        AppTab.SETTINGS -> SettingsScreen(
                                            config = config,
                                            syncing = state.syncing,
                                            onSync = { vm.sync() },
                                            onLogout = { vm.logout() },
                                        )
                                    }

                                    if (state.adminLoading && !state.adminNeedsLogin) {
                                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                            CircularProgressIndicator(color = Color(0xFF3B82F6), modifier = Modifier.size(24.dp))
                                        }
                                    }
                                }

                                BottomNavBar(
                                    activeTab = state.activeTab,
                                    isAdmin = state.isAdminUser,
                                    onTabChange = { vm.setActiveTab(it) },
                                )
                            }
                        }
                    }
                }
            }
            } // end safeDrawing Box
        }

        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "bifrost" && data.host == "provision") {
            val url = data.getQueryParameter("url")
            if (url != null) {
                pendingViewModel?.provisionFromUrl(url)
            }
        }
    }

    private fun handleToggle(vm: MainViewModel) {
        if (vm.tunnelManager.isConnected) {
            vm.toggleConnection()
            return
        }
        val vpnIntent = VpnService.prepare(this)
        if (vpnIntent != null) {
            pendingViewModel = vm
            vpnPermissionLauncher.launch(vpnIntent)
            return
        }
        vm.toggleConnection()
    }

    private fun requestCameraAndScan(vm: MainViewModel) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            vm.showQrScanner()
        } else {
            pendingViewModel = vm
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun requestBiometric(vm: MainViewModel) {
        if (!biometricHelper.canAuthenticate()) {
            vm.unlock()
            return
        }
        biometricHelper.authenticate(
            activity = this,
            onSuccess = { vm.unlock() },
            onError = { /* stay locked */ },
        )
    }
}
