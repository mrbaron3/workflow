package githubapp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIssuerWarmsIdentityThenMintsExactRolePoliciesAndRefreshesCache(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var lock sync.Mutex
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	mints := map[string]int{}
	tokenRepositories := map[string][]string{}
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			switch {
			case request.Method == http.MethodGet && request.URL.Path == "/app":
				_, _ = fmt.Fprint(
					response,
					`{"id":42,"slug":"agentops-test"}`,
				)
			case request.Method == http.MethodGet &&
				request.URL.Path == "/app/installations/99":
				_, _ = fmt.Fprint(response, `{
					"id":99,
					"app_id":42,
					"account":{"login":"acme"},
					"permissions":{
						"actions":"read",
						"checks":"read",
						"contents":"write",
						"issues":"write",
						"pull_requests":"write",
						"statuses":"read",
						"workflows":"write"
					}
				}`)
			case request.Method == http.MethodPost &&
				request.URL.Path == "/app/installations/99/access_tokens":
				var input struct {
					Repositories []string          `json:"repositories"`
					Permissions  map[string]string `json:"permissions"`
				}
				if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
					t.Errorf("decode mint request: %v", err)
					response.WriteHeader(http.StatusBadRequest)
					return
				}
				role := "triage"
				if input.Permissions["contents"] == "write" {
					role = "runner"
				}
				lock.Lock()
				mints[role]++
				token := fmt.Sprintf(
					"%s-installation-token-%032d",
					role,
					mints[role],
				)
				repositories := make([]string, len(input.Repositories))
				for index, name := range input.Repositories {
					repositories[index] = "acme/" + name
				}
				tokenRepositories[token] = repositories
				expiresAt := now.Add(time.Hour)
				lock.Unlock()
				_ = json.NewEncoder(response).Encode(map[string]any{
					"token":                token,
					"expires_at":           expiresAt,
					"permissions":          input.Permissions,
					"repository_selection": "selected",
				})
			case request.Method == http.MethodGet &&
				request.URL.Path == "/installation/repositories":
				token := strings.TrimPrefix(
					request.Header.Get("Authorization"),
					"Bearer ",
				)
				lock.Lock()
				repositories := append(
					[]string(nil),
					tokenRepositories[token]...,
				)
				lock.Unlock()
				items := make([]map[string]string, len(repositories))
				for index, repository := range repositories {
					items[index] = map[string]string{"full_name": repository}
				}
				_ = json.NewEncoder(response).Encode(map[string]any{
					"total_count":  len(items),
					"repositories": items,
				})
			default:
				t.Errorf(
					"unexpected GitHub request: %s %s",
					request.Method,
					request.URL.String(),
				)
				response.WriteHeader(http.StatusNotFound)
			}
		},
	))
	defer server.Close()
	issuer, err := NewIssuer(IssuerConfig{
		AppID:          42,
		InstallationID: 99,
		AppSlug:        "agentops-test",
		Owner:          "acme",
		APIBaseURL:     server.URL,
		PrivateKey:     key,
		Policies: []Policy{
			{
				Role: RoleTriage,
				Permissions: map[string]string{
					"contents":      "read",
					"issues":        "write",
					"pull_requests": "read",
				},
			},
			{
				Role: RoleRunner,
				Permissions: map[string]string{
					"actions":       "read",
					"checks":        "read",
					"contents":      "write",
					"issues":        "write",
					"pull_requests": "write",
					"statuses":      "read",
					"workflows":     "write",
				},
			},
		},
	}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := issuer.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if mints["triage"] != 0 || mints["runner"] != 0 {
		t.Fatalf("startup unexpectedly minted credentials = %#v", mints)
	}
	triage, err := issuer.Token(context.Background(), RoleTriage, "acme/widgets")
	if err != nil {
		t.Fatal(err)
	}
	runner, err := issuer.Token(context.Background(), RoleRunner, "acme/widgets")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(triage.Repositories, ",") != "acme/widgets" ||
		strings.Join(runner.Repositories, ",") != "acme/widgets" ||
		triage.ActorLogin != "agentops-test[bot]" {
		t.Fatalf("unexpected scoped credentials: %#v %#v", triage, runner)
	}
	if mints["triage"] != 1 || mints["runner"] != 1 {
		t.Fatalf("on-demand/cache mints = %#v", mints)
	}
	now = now.Add(16 * time.Minute)
	if _, err := issuer.Token(context.Background(), RoleTriage, "acme/widgets"); err != nil {
		t.Fatal(err)
	}
	if mints["triage"] != 2 || mints["runner"] != 1 {
		t.Fatalf("refresh mints = %#v", mints)
	}
}

func TestIssuerRejectsRepositoryScopeDrift(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			switch request.URL.Path {
			case "/app":
				_, _ = fmt.Fprint(response, `{"id":42,"slug":"agentops-test"}`)
			case "/app/installations/99":
				_, _ = fmt.Fprint(response, `{
					"id":99,
					"app_id":42,
					"account":{"login":"acme"},
					"permissions":{"issues":"read"}
				}`)
			case "/app/installations/99/access_tokens":
				_ = json.NewEncoder(response).Encode(map[string]any{
					"token":       strings.Repeat("x", 40),
					"expires_at":  now.Add(time.Hour),
					"permissions": map[string]string{"issues": "read"},
				})
			case "/installation/repositories":
				_, _ = fmt.Fprint(response, `{
					"total_count":2,
					"repositories":[
						{"full_name":"acme/widgets"},
						{"full_name":"acme/unexpected"}
					]
				}`)
			default:
				response.WriteHeader(http.StatusNotFound)
			}
		},
	))
	defer server.Close()
	issuer, err := NewIssuer(IssuerConfig{
		AppID: 42, InstallationID: 99,
		AppSlug: "agentops-test", Owner: "acme",
		APIBaseURL: server.URL, PrivateKey: key,
		Policies: []Policy{{
			Role:        RoleTriage,
			Permissions: map[string]string{"issues": "read"},
		}},
	}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if err := issuer.Warm(context.Background()); err != nil {
		t.Fatalf("identity warm-up failed before token scope validation: %v", err)
	}
	if _, err := issuer.Token(context.Background(), RoleTriage, "acme/widgets"); err == nil ||
		!strings.Contains(err.Error(), "scope drifted") {
		t.Fatalf("repository scope drift was accepted: %v", err)
	}
}
