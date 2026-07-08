package config

import (
	"os"
	"strings"
)

// Deployment defaults. These mirror the values baked into the Android client
// (MainViewModel) and can be overridden at runtime via environment variables so
// the same binary can target a different stage without a rebuild.
const (
	defaultCognitoRegion   = "us-east-1"
	defaultCognitoClientID = "jsqq9hnacm13ohfmnjfvn1bgv"
	defaultAPIBaseURL      = "https://gc6426p037.execute-api.us-east-1.amazonaws.com"
)

// Endpoints resolves the deployment configuration, applying environment
// overrides (BIFROST_REGION, BIFROST_CLIENT_ID, BIFROST_API_URL) when present.
type Endpoints struct {
	Region   string
	ClientID string
	APIBase  string
}

// Load reads the effective endpoint configuration.
func Load() Endpoints {
	return Endpoints{
		Region:   envOr("BIFROST_REGION", defaultCognitoRegion),
		ClientID: envOr("BIFROST_CLIENT_ID", defaultCognitoClientID),
		APIBase:  strings.TrimRight(envOr("BIFROST_API_URL", defaultAPIBaseURL), "/"),
	}
}

// AuthProvisionURL is the authenticated endpoint that auto-creates/returns the
// caller's device config after a Cognito login.
func (e Endpoints) AuthProvisionURL() string { return e.APIBase + "/auth/provision" }

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
