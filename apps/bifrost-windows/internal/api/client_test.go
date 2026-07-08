package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bifrost-vpn/bifrost-windows/internal/config"
)

func TestFetchProvisionParsesNodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"deviceId": "dev-1",
			"name": "Laptop",
			"assignedIp": "10.7.0.5",
			"nodes": [
				{"nodeId":"n1","name":"Home","role":"primary","endpoint":"1.2.3.4","port":51820,"wgConfig":"[Interface]\nA"},
				{"nodeId":"n2","name":"Backup","role":"secondary","wgConfig":"[Interface]\nB"}
			],
			"config": "[Interface]\nA"
		}`))
	}))
	defer srv.Close()

	dc, err := New().FetchProvision(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dc.DeviceID != "dev-1" || dc.AssignedIP != "10.7.0.5" || len(dc.Nodes) != 2 {
		t.Fatalf("unexpected device: %+v", dc)
	}
	if !dc.Nodes[0].IsPrimary() || dc.Nodes[0].Port != 51820 {
		t.Fatalf("primary node parsed wrong: %+v", dc.Nodes[0])
	}
}

func TestFetchProvisionBackwardsCompatConfigOnly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"deviceId":"d","name":"X","assignedIp":"10.0.0.1","config":"[Interface]\nOnly"}`))
	}))
	defer srv.Close()

	dc, err := New().FetchProvision(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dc.Nodes) != 1 || dc.Nodes[0].WgConfig != "[Interface]\nOnly" {
		t.Fatalf("expected synthesized single node, got %+v", dc.Nodes)
	}
}

func TestFetchProvisionErrorBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Device has been revoked"}`))
	}))
	defer srv.Close()

	_, err := New().FetchProvision(context.Background(), srv.URL)
	if err == nil || err.Error() != "Device has been revoked" {
		t.Fatalf("expected revoked error, got %v", err)
	}
}

func TestAutoProvisionNotProvisioned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok123" {
			t.Errorf("missing bearer token, got %q", got)
		}
		_, _ = w.Write([]byte(`{"provisioned": false}`))
	}))
	defer srv.Close()

	e := config.Endpoints{APIBase: srv.URL}
	dc, err := New().AutoProvision(context.Background(), e, "tok123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dc != nil {
		t.Fatalf("expected nil device when not provisioned, got %+v", dc)
	}
}

func TestAutoProvisionSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"provisioned":true,"deviceId":"d2","name":"Phone","assignedIp":"10.7.0.9",
			"nodes":[{"nodeId":"n1","name":"Home","role":"primary","wgConfig":"[Interface]\nA"}]}`))
	}))
	defer srv.Close()

	e := config.Endpoints{APIBase: srv.URL}
	dc, err := New().AutoProvision(context.Background(), e, "tok123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dc == nil || dc.DeviceID != "d2" || len(dc.Nodes) != 1 {
		t.Fatalf("unexpected device: %+v", dc)
	}
}
