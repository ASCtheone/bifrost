package com.bifrost.vpn.api

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64

private val Context.credStore by preferencesDataStore(name = "bifrost_creds")

private val KEY_ENC_USERNAME = stringPreferencesKey("enc_username")
private val KEY_ENC_PASSWORD = stringPreferencesKey("enc_password")
private val KEY_IV = stringPreferencesKey("enc_iv")
private val KEY_HAS_CREDS = stringPreferencesKey("has_creds")

private const val KEYSTORE_ALIAS = "bifrost_cred_key"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"

class SecureCredentialStore(private val context: Context) {

    init {
        ensureKey()
    }

    private fun ensureKey() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
        ks.load(null)
        if (ks.containsAlias(KEYSTORE_ALIAS)) return

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        keyGen.init(
            KeyGenParameterSpec.Builder(KEYSTORE_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        keyGen.generateKey()
    }

    private fun getKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE)
        ks.load(null)
        return (ks.getEntry(KEYSTORE_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
    }

    suspend fun saveCredentials(username: String, password: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getKey())

        val encUsername = cipher.doFinal(username.toByteArray())
        val iv = cipher.iv

        // Reuse same IV for password (create new cipher with same IV)
        val cipher2 = Cipher.getInstance("AES/GCM/NoPadding")
        cipher2.init(Cipher.ENCRYPT_MODE, getKey())
        val encPassword = cipher2.doFinal(password.toByteArray())
        val iv2 = cipher2.iv

        context.credStore.edit { prefs ->
            prefs[KEY_ENC_USERNAME] = Base64.encodeToString(encUsername, Base64.NO_WRAP)
            prefs[KEY_ENC_PASSWORD] = Base64.encodeToString(encPassword, Base64.NO_WRAP)
            prefs[KEY_IV] = Base64.encodeToString(iv, Base64.NO_WRAP) + "|" + Base64.encodeToString(iv2, Base64.NO_WRAP)
            prefs[KEY_HAS_CREDS] = "true"
        }
    }

    suspend fun hasCredentials(): Boolean {
        val prefs = context.credStore.data.first()
        return prefs[KEY_HAS_CREDS] == "true"
    }

    suspend fun loadCredentials(): Pair<String, String>? {
        val prefs = context.credStore.data.first()
        val encUsername = prefs[KEY_ENC_USERNAME] ?: return null
        val encPassword = prefs[KEY_ENC_PASSWORD] ?: return null
        val ivs = prefs[KEY_IV]?.split("|") ?: return null
        if (ivs.size < 2) return null

        return try {
            val iv1 = Base64.decode(ivs[0], Base64.NO_WRAP)
            val iv2 = Base64.decode(ivs[1], Base64.NO_WRAP)

            val cipher1 = Cipher.getInstance("AES/GCM/NoPadding")
            cipher1.init(Cipher.DECRYPT_MODE, getKey(), GCMParameterSpec(128, iv1))
            val username = String(cipher1.doFinal(Base64.decode(encUsername, Base64.NO_WRAP)))

            val cipher2 = Cipher.getInstance("AES/GCM/NoPadding")
            cipher2.init(Cipher.DECRYPT_MODE, getKey(), GCMParameterSpec(128, iv2))
            val password = String(cipher2.doFinal(Base64.decode(encPassword, Base64.NO_WRAP)))

            Pair(username, password)
        } catch (e: Exception) {
            null
        }
    }

    suspend fun clear() {
        context.credStore.edit { it.clear() }
    }
}
