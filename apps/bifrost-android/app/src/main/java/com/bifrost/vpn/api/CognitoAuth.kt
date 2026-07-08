package com.bifrost.vpn.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class CognitoTokens(
    val idToken: String,
    val accessToken: String,
)

class CognitoAuth(
    private val region: String,
    private val clientId: String,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun login(username: String, password: String): CognitoTokens = withContext(Dispatchers.IO) {
        val url = "https://cognito-idp.$region.amazonaws.com/"
        val body = JSONObject().apply {
            put("AuthFlow", "USER_PASSWORD_AUTH")
            put("ClientId", clientId)
            put("AuthParameters", JSONObject().apply {
                put("USERNAME", username)
                put("PASSWORD", password)
            })
        }

        val request = Request.Builder()
            .url(url)
            .header("Content-Type", "application/x-amz-json-1.1")
            .header("X-Amz-Target", "AWSCognitoIdentityProviderService.InitiateAuth")
            .post(body.toString().toRequestBody("application/x-amz-json-1.1".toMediaType()))
            .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: throw Exception("Empty response")

        if (!response.isSuccessful) {
            val err = try { JSONObject(responseBody).optString("message", responseBody) } catch (_: Exception) { responseBody }
            throw Exception(err)
        }

        val json = JSONObject(responseBody)
        val result = json.getJSONObject("AuthenticationResult")

        CognitoTokens(
            idToken = result.getString("IdToken"),
            accessToken = result.getString("AccessToken"),
        )
    }
}
