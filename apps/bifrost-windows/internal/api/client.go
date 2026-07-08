// Package api is the HTTP client for the Bifrost provisioning endpoints.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/bifrost-vpn/bifrost-windows/internal/config"
)

// Client talks to the Bifrost API Gateway provisioning routes.
type Client struct {
	http *http.Client
}

// New returns an API client with sensible timeouts.
func New() *Client {
	return &Client{http: &http.Client{Timeout: 15 * time.Second}}
}

// provisionResponse is the union of fields returned by GET /provision/{token}
// and POST /auth/provision. Not every field is present on both, so all are
// optional except deviceId/nodes.
type provisionResponse struct {
	Provisioned *bool               `json:"provisioned,omitempty"`
	DeviceID    string              `json:"deviceId"`
	Name        string              `json:"name"`
	AssignedIP  string              `json:"assignedIp"`
	Config      string              `json:"config"`
	Nodes       []config.NodeConfig `json:"nodes"`
}

// FetchProvision retrieves a device config from a public provision URL
// (GET /provision/{token}). Used for QR / pasted-URL onboarding and for the
// periodic refresh that drives failover.
func (c *Client) FetchProvision(ctx context.Context, url string) (*config.DeviceConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return c.doProvision(req, false)
}

// AutoProvision calls the authenticated POST /auth/provision endpoint with a
// Cognito id token, returning the caller's device config (auto-created on first
// login). Returns (nil, nil) when the account has no VPN device to provision.
func (c *Client) AutoProvision(ctx context.Context, endpoints config.Endpoints, idToken string) (*config.DeviceConfig, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoints.AuthProvisionURL(), bytes.NewReader([]byte("{}")))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+idToken)
	req.Header.Set("Content-Type", "application/json")
	return c.doProvision(req, true)
}

// doProvision executes a provision request and normalises the response into a
// DeviceConfig. When requireProvisioned is set (auth flow), a response with
// provisioned=false yields (nil, nil).
func (c *Client) doProvision(req *http.Request, requireProvisioned bool) (*config.DeviceConfig, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s", errorMessage(raw, resp.StatusCode))
	}

	var pr provisionResponse
	if err := json.Unmarshal(raw, &pr); err != nil {
		return nil, fmt.Errorf("unexpected provision response: %w", err)
	}
	if requireProvisioned && pr.Provisioned != nil && !*pr.Provisioned {
		return nil, nil
	}
	if pr.DeviceID == "" {
		return nil, fmt.Errorf("provision response missing deviceId")
	}

	nodes := pr.Nodes
	// Backwards-compat: a bare top-level config with no nodes array.
	if len(nodes) == 0 && pr.Config != "" {
		nodes = []config.NodeConfig{{
			NodeID:   "default",
			Name:     "Default",
			WgConfig: pr.Config,
		}}
	}
	if len(nodes) == 0 {
		return nil, fmt.Errorf("no VPN nodes available for this device")
	}

	return &config.DeviceConfig{
		DeviceID:   pr.DeviceID,
		Name:       pr.Name,
		AssignedIP: pr.AssignedIP,
		Nodes:      nodes,
	}, nil
}

// errorMessage pulls a readable message from an API error body.
func errorMessage(raw []byte, status int) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil {
		if e.Error != "" {
			return e.Error
		}
		if e.Message != "" {
			return e.Message
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}
