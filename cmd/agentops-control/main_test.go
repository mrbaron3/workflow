package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoopbackPublishProxyRequiresLoopbackBackendAndExactHost(t *testing.T) {
	if _, err := loopbackPublishProxy(
		"0.0.0.0:8080",
		"0.0.0.0:8081",
		"http://127.0.0.1:8080",
	); err == nil {
		t.Fatal("non-loopback proxy backend was accepted")
	}

	observedPeer := ""
	backend := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		observedPeer = request.RemoteAddr
		if request.Header.Get("Forwarded") != "" ||
			request.Header.Get("X-Forwarded-For") != "" {
			t.Error("forwarding provenance headers reached loopback backend")
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	backendAddress := strings.TrimPrefix(backend.URL, "http://")
	proxy, err := loopbackPublishProxy(
		"0.0.0.0:8080",
		backendAddress,
		"http://127.0.0.1:8080",
	)
	if err != nil {
		t.Fatal(err)
	}

	invalid := httptest.NewRequest(http.MethodGet, "http://localhost:8080/healthz", nil)
	invalid.Host = "localhost:8080"
	invalidResponse := httptest.NewRecorder()
	proxy.Handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusForbidden {
		t.Fatalf("invalid Host status = %d", invalidResponse.Code)
	}

	valid := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/healthz", nil)
	valid.Host = "127.0.0.1:8080"
	valid.Header.Set("Forwarded", "for=203.0.113.1")
	valid.Header.Set("X-Forwarded-For", "203.0.113.1")
	validResponse := httptest.NewRecorder()
	proxy.Handler.ServeHTTP(validResponse, valid)
	if validResponse.Code != http.StatusNoContent {
		t.Fatalf("exact Host status = %d body=%s", validResponse.Code, validResponse.Body)
	}
	if !strings.HasPrefix(observedPeer, "127.0.0.1:") {
		t.Fatalf("backend peer = %q", observedPeer)
	}
}
