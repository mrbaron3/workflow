package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fixedIssuer struct {
	calls []Role
}

func (issuer *fixedIssuer) Token(
	_ context.Context,
	role Role,
) (TokenResponse, error) {
	issuer.calls = append(issuer.calls, role)
	return TokenResponse{
		SchemaVersion: SchemaVersion,
		Role:          role,
		Token:         strings.Repeat("t", 40),
		ExpiresAt:     time.Now().UTC().Add(time.Hour),
		Repositories:  []string{"acme/widgets"},
		Permissions:   map[string]string{"issues": "read"},
		ActorLogin:    "agentops-test[bot]",
	}, nil
}

func TestServerEnforcesRoleSpecificCapabilities(t *testing.T) {
	issuer := &fixedIssuer{}
	server, err := NewServer(issuer, map[Role]string{
		RoleTriage: strings.Repeat("a", 32),
		RoleRunner: strings.Repeat("b", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(server.Handler())
	defer endpoint.Close()

	status, body := brokerRequest(
		t,
		endpoint.URL,
		RoleRunner,
		strings.Repeat("a", 32),
	)
	if status != http.StatusUnauthorized ||
		strings.Contains(body, strings.Repeat("t", 20)) ||
		len(issuer.calls) != 0 {
		t.Fatalf(
			"cross-role capability status=%d body=%q calls=%v",
			status,
			body,
			issuer.calls,
		)
	}

	status, body = brokerRequest(
		t,
		endpoint.URL,
		RoleTriage,
		strings.Repeat("a", 32),
	)
	if status != http.StatusOK ||
		!strings.Contains(body, `"role":"triage"`) ||
		len(issuer.calls) != 1 ||
		issuer.calls[0] != RoleTriage {
		t.Fatalf(
			"authorized request status=%d body=%q calls=%v",
			status,
			body,
			issuer.calls,
		)
	}
}

func TestServerRejectsOversizeOrUnknownRequestWithoutIssuing(t *testing.T) {
	issuer := &fixedIssuer{}
	server, err := NewServer(issuer, map[Role]string{
		RoleTriage: strings.Repeat("a", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"schemaVersion":1,"role":"triage","unknown":true}`,
		`{"schemaVersion":1,"role":"triage"}` + strings.Repeat(" ", 4097),
	} {
		request := httptest.NewRequest(
			http.MethodPost,
			"/v1/github-token",
			strings.NewReader(body),
		)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(
			"Authorization",
			"Bearer "+strings.Repeat("a", 32),
		)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("request status=%d body=%q", response.Code, body)
		}
	}
	if len(issuer.calls) != 0 {
		t.Fatalf("invalid request reached issuer: %v", issuer.calls)
	}
}

func TestBrokerClientRejectsMalformedCredentialResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(response, `{
				"schemaVersion":1,
				"role":"runner",
				"token":"not-the-expected-role",
				"expiresAt":"2099-01-01T00:00:00Z",
				"repositories":["acme/widgets"],
				"permissions":{"contents":"write"},
				"actorLogin":"agentops-test[bot]"
			}`)
		},
	))
	defer server.Close()
	_, err := (BrokerClient{
		BaseURL:    server.URL,
		Capability: strings.Repeat("a", 32),
		Role:       RoleTriage,
	}).Token(context.Background())
	if err == nil {
		t.Fatal("role-confused broker response was accepted")
	}
}

func brokerRequest(
	t *testing.T,
	baseURL string,
	role Role,
	capability string,
) (int, string) {
	t.Helper()
	body, err := json.Marshal(TokenRequest{
		SchemaVersion: SchemaVersion,
		Role:          role,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/v1/github-token",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+capability)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(contents)
}
