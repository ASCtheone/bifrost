// Package auth handles Cognito username/password authentication and secure
// credential storage in the Windows Credential Manager.
package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Tokens are the JWTs returned by a successful Cognito InitiateAuth call.
type Tokens struct {
	IDToken     string
	AccessToken string
}

// Cognito performs USER_PASSWORD_AUTH against the AWS Cognito Identity Provider
// service directly (no SDK), matching the Android client's CognitoAuth.
type Cognito struct {
	region   string
	clientID string
	http     *http.Client
}

// NewCognito builds a Cognito auth client for the given region and app client id.
func NewCognito(region, clientID string) *Cognito {
	return &Cognito{
		region:   region,
		clientID: clientID,
		http:     &http.Client{Timeout: 15 * time.Second},
	}
}

// Login exchanges a username/password for Cognito tokens.
func (c *Cognito) Login(ctx context.Context, username, password string) (*Tokens, error) {
	url := fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/", c.region)
	payload := map[string]any{
		"AuthFlow": "USER_PASSWORD_AUTH",
		"ClientId": c.clientID,
		"AuthParameters": map[string]string{
			"USERNAME": username,
			"PASSWORD": password,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AWSCognitoIdentityProviderService.InitiateAuth")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("login failed: %s", cognitoErrorMessage(raw, resp.StatusCode))
	}

	var out struct {
		AuthenticationResult struct {
			IDToken     string `json:"IdToken"`
			AccessToken string `json:"AccessToken"`
		} `json:"AuthenticationResult"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("unexpected auth response: %w", err)
	}
	if out.AuthenticationResult.IDToken == "" {
		return nil, fmt.Errorf("login failed: no token returned (MFA or challenge not supported)")
	}
	return &Tokens{
		IDToken:     out.AuthenticationResult.IDToken,
		AccessToken: out.AuthenticationResult.AccessToken,
	}, nil
}

// cognitoErrorMessage extracts a human-readable message from a Cognito error body.
func cognitoErrorMessage(raw []byte, status int) string {
	var e struct {
		Message string `json:"message"`
		Type    string `json:"__type"`
	}
	if json.Unmarshal(raw, &e) == nil {
		if e.Message != "" {
			return e.Message
		}
		if e.Type != "" {
			return e.Type
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}
