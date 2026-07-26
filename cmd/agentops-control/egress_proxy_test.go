package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunnerEgressProxyAllowlist(t *testing.T) {
	server, err := runnerEgressProxy(
		"0.0.0.0:8082",
		"codex",
		"api-key",
	)
	if err != nil {
		t.Fatal(err)
	}
	if server == nil {
		t.Fatal("proxy was not constructed")
	}
	for _, test := range []struct {
		method string
		host   string
		status int
	}{
		{http.MethodGet, "api.openai.com:443", http.StatusMethodNotAllowed},
		{http.MethodConnect, "localhost:443", http.StatusForbidden},
		{http.MethodConnect, "api.anthropic.com:443", http.StatusForbidden},
	} {
		request := httptest.NewRequest(test.method, "http://proxy", nil)
		request.Host = test.host
		response := httptest.NewRecorder()
		server.Handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("%s %s status=%d", test.method, test.host, response.Code)
		}
	}
}

func TestRunnerEgressDestinationsAreProviderSpecific(t *testing.T) {
	codex, err := runnerEgressDestinations("codex", "api-key")
	if err != nil {
		t.Fatal(err)
	}
	if !codex["api.openai.com:443"] || codex["api.anthropic.com:443"] {
		t.Fatalf("codex allowlist = %#v", codex)
	}
	login, err := runnerEgressDestinations("codex", "codex-login")
	if err != nil {
		t.Fatal(err)
	}
	if !login["chatgpt.com:443"] || !login["auth.openai.com:443"] ||
		login["api.openai.com:443"] {
		t.Fatalf("Codex login allowlist = %#v", login)
	}
	monitor, err := runnerEgressDestinations("codex", "none")
	if err != nil {
		t.Fatal(err)
	}
	if monitor["api.openai.com:443"] || monitor["chatgpt.com:443"] {
		t.Fatalf("MONITOR_ONLY provider egress = %#v", monitor)
	}
	claude, err := runnerEgressDestinations("claude", "api-key")
	if err != nil {
		t.Fatal(err)
	}
	if !claude["api.anthropic.com:443"] || claude["api.openai.com:443"] {
		t.Fatalf("claude allowlist = %#v", claude)
	}
	if _, err := runnerEgressDestinations("other", "api-key"); err == nil {
		t.Fatal("unknown provider was accepted")
	}
}
