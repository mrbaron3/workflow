package githubapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/mrbaron3/servo/apps/control-plane/internal/control"
)

const (
	maxBrokerRequestBytes = 4096
	// brokerWriteTimeout must outlast the slowest legitimate mint; see
	// defaultRequestTimeout.
	brokerWriteTimeout = 35 * time.Second
)

type TokenIssuer interface {
	Token(context.Context, Role, string) (TokenResponse, error)
	ActorLogin() string
}

type Server struct {
	issuer       TokenIssuer
	capabilities map[Role][sha256.Size]byte
}

func NewServer(
	issuer TokenIssuer,
	capabilities map[Role]string,
) (*Server, error) {
	if issuer == nil || len(capabilities) == 0 {
		return nil, fmt.Errorf("GitHub credential broker is incomplete")
	}
	hashed := make(map[Role][sha256.Size]byte, len(capabilities))
	for role, capability := range capabilities {
		if !role.Valid() || len(strings.TrimSpace(capability)) < 32 {
			return nil, fmt.Errorf("GitHub credential broker capability is invalid")
		}
		hashed[role] = sha256.Sum256([]byte(capability))
	}
	return &Server{issuer: issuer, capabilities: hashed}, nil
}

func (server *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", server.health)
	mux.HandleFunc("/v1/github-token", server.token)
	mux.HandleFunc("/v1/github-actor", server.actor)
	return securityHeaders(mux)
}

func (server *Server) health(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write([]byte(`{"status":"ready"}`))
}

func (server *Server) token(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodPost {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if request.Header.Get("Content-Type") != "application/json" {
		http.Error(response, "content type required", http.StatusUnsupportedMediaType)
		return
	}
	request.Body = http.MaxBytesReader(
		response,
		request.Body,
		maxBrokerRequestBytes,
	)
	body, err := io.ReadAll(request.Body)
	if err != nil || len(body) > maxBrokerRequestBytes {
		http.Error(response, "invalid request", http.StatusBadRequest)
		return
	}
	input, err := DecodeStrict[TokenRequest](
		bytes.NewReader(body),
		maxBrokerRequestBytes,
	)
	if err != nil || input.SchemaVersion != SchemaVersion ||
		!input.Role.Valid() || !control.ValidRepositoryIdentity(input.Repository) {
		http.Error(response, "invalid request", http.StatusBadRequest)
		return
	}
	expected, present := server.capabilities[input.Role]
	if !present || !constantTimeBearer(request.Header.Get("Authorization"), expected) {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	credential, err := server.issuer.Token(request.Context(), input.Role, input.Repository)
	if err != nil {
		http.Error(response, "credential unavailable", http.StatusServiceUnavailable)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(credential); err != nil {
		return
	}
}

func (server *Server) actor(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/json" {
		http.Error(response, "invalid request", http.StatusBadRequest)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBrokerRequestBytes)
	input, err := DecodeStrict[ActorRequest](request.Body, maxBrokerRequestBytes)
	if err != nil || input.SchemaVersion != SchemaVersion || !input.Role.Valid() {
		http.Error(response, "invalid request", http.StatusBadRequest)
		return
	}
	expected, present := server.capabilities[input.Role]
	if !present || !constantTimeBearer(request.Header.Get("Authorization"), expected) {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(response).Encode(ActorResponse{
		SchemaVersion: SchemaVersion,
		Role:          input.Role,
		ActorLogin:    server.issuer.ActorLogin(),
	})
}

func constantTimeBearer(header string, expected [sha256.Size]byte) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	observed := sha256.Sum256([]byte(strings.TrimSpace(header[len(prefix):])))
	return subtle.ConstantTimeCompare(observed[:], expected[:]) == 1
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("Content-Security-Policy", "default-src 'none'")
		response.Header().Set("Permissions-Policy", "interest-cohort=()")
		next.ServeHTTP(response, request)
	})
}

func HTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      brokerWriteTimeout,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
}
