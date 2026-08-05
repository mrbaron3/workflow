package githubapp

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/mrbaron3/servo/apps/control-plane/internal/jsonschemaregexp"
	"github.com/mrbaron3/servo/apps/control-plane/internal/reporoot"
)

func compileContract(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	root, err := reporoot.Find(".")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(
		root, "contracts", "github-credential", "v1", name,
	))
	if err != nil {
		t.Fatal(err)
	}
	var document any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		t.Fatal(err)
	}
	identifier, ok := document.(map[string]any)["$id"].(string)
	if !ok || identifier == "" {
		t.Fatalf("contract %s has no $id", name)
	}
	compiler := jsonschema.NewCompiler()
	compiler.UseRegexpEngine(jsonschemaregexp.Compile)
	compiler.AssertFormat()
	if err := compiler.AddResource(identifier, document); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile(identifier)
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

// contractInstance renders a value exactly as it would cross the broker socket,
// so the contract is measured against the wire form rather than the Go struct.
func contractInstance(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var instance any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&instance); err != nil {
		t.Fatal(err)
	}
	return instance
}

func contractIssuer(t *testing.T, now time.Time) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
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
					"permissions":{"contents":"read","issues":"write"}
				}`)
			case "/app/installations/99/access_tokens":
				_ = json.NewEncoder(response).Encode(map[string]any{
					"token":                "triage-installation-token-000001",
					"expires_at":           now.Add(time.Hour),
					"permissions":          map[string]string{"contents": "read", "issues": "write"},
					"repository_selection": "selected",
				})
			case "/installation/repositories":
				_, _ = fmt.Fprint(response, `{
					"total_count":1,
					"repositories":[{"full_name":"acme/widgets"}]
				}`)
			default:
				response.WriteHeader(http.StatusNotFound)
			}
		},
	))
	t.Cleanup(server.Close)
	issuer, err := NewIssuer(IssuerConfig{
		AppID: 42, InstallationID: 99,
		AppSlug: "agentops-test", Owner: "acme",
		APIBaseURL: server.URL, PrivateKey: key,
		Policies: []Policy{{
			Role:        RoleTriage,
			Permissions: map[string]string{"contents": "read", "issues": "write"},
		}},
	}, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return issuer
}

// Pinning a contract is only worth doing if the process that produces the
// credential is measured against it. This mints through the real issuer, so a
// struct change the schema forbids fails here instead of at a worker.
func TestMintedCredentialSatisfiesPublishedContract(t *testing.T) {
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	requestSchema := compileContract(t, "token-request.schema.json")
	responseSchema := compileContract(t, "token-response.schema.json")
	if err := requestSchema.Validate(contractInstance(t, TokenRequest{
		SchemaVersion: SchemaVersion,
		Role:          RoleTriage,
		Repository:    "acme/widgets",
	})); err != nil {
		t.Fatalf("broker request violates the published contract: %v", err)
	}
	credential, err := contractIssuer(t, now).Token(
		context.Background(),
		RoleTriage,
		"acme/widgets",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := responseSchema.Validate(
		contractInstance(t, credential),
	); err != nil {
		t.Fatalf("minted credential violates the published contract: %v", err)
	}
	if err := ValidateTokenResponse(credential, RoleTriage, "acme/widgets", now); err != nil {
		t.Fatalf("minted credential failed runtime validation: %v", err)
	}
}

// The schema guards the wire and ValidateTokenResponse guards the consumer.
// They are only one contract if they reject the same credentials.
func TestContractAndRuntimeValidationRejectTheSameCredentials(t *testing.T) {
	schema := compileContract(t, "token-response.schema.json")
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	valid := TokenResponse{
		SchemaVersion: SchemaVersion,
		Role:          RoleTriage,
		Token:         "triage-installation-token-000001",
		ExpiresAt:     now.Add(time.Hour),
		Repositories:  []string{"acme/widgets"},
		Permissions:   map[string]string{"issues": "write"},
		ActorLogin:    "agentops-test[bot]",
	}
	if err := schema.Validate(contractInstance(t, valid)); err != nil {
		t.Fatalf("contract rejected a valid credential: %v", err)
	}
	if err := ValidateTokenResponse(valid, RoleTriage, "acme/widgets", now); err != nil {
		t.Fatalf("runtime validation rejected a valid credential: %v", err)
	}
	for name, mutate := range map[string]func(*TokenResponse){
		"future schema version": func(candidate *TokenResponse) {
			candidate.SchemaVersion = 2
		},
		"uppercase repository": func(candidate *TokenResponse) {
			candidate.Repositories = []string{"Acme/widgets"}
		},
		"relative repository": func(candidate *TokenResponse) {
			candidate.Repositories = []string{"acme/.."}
		},
		"duplicated repository": func(candidate *TokenResponse) {
			candidate.Repositories = []string{"acme/widgets", "acme/widgets"}
		},
		"escalated permission level": func(candidate *TokenResponse) {
			candidate.Permissions = map[string]string{"issues": "admin"}
		},
		"non-canonical permission name": func(candidate *TokenResponse) {
			candidate.Permissions = map[string]string{"Issues": "write"}
		},
		"human actor": func(candidate *TokenResponse) {
			candidate.ActorLogin = "operator"
		},
		"empty repository set": func(candidate *TokenResponse) {
			candidate.Repositories = nil
		},
	} {
		candidate := valid
		candidate.Repositories = append([]string(nil), valid.Repositories...)
		candidate.Permissions = cloneMap(valid.Permissions)
		mutate(&candidate)
		if schema.Validate(contractInstance(t, candidate)) == nil {
			t.Errorf("published contract accepted %s", name)
		}
		if ValidateTokenResponse(candidate, RoleTriage, "acme/widgets", now) == nil {
			t.Errorf("runtime validation accepted %s", name)
		}
	}
}

// A mint spends two sequential GitHub calls before the broker writes anything,
// so the request budget has to stay inside the response deadline and the client
// has to outwait the broker.
func TestTimeoutBudgetFitsWriteDeadline(t *testing.T) {
	worstMint := mintGitHubCalls * defaultRequestTimeout
	if worstMint >= brokerWriteTimeout {
		t.Fatalf(
			"worst-case mint %s does not fit inside write timeout %s",
			worstMint,
			brokerWriteTimeout,
		)
	}
	if BrokerTokenTimeout <= worstMint ||
		BrokerTokenTimeout >= brokerWriteTimeout {
		t.Fatalf(
			"client timeout %s must sit between %s and %s",
			BrokerTokenTimeout,
			worstMint,
			brokerWriteTimeout,
		)
	}
}
