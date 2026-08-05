package main

import (
	"context"
	"crypto/rsa"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mrbaron3/servo/apps/control-plane/internal/githubapp"
	"github.com/mrbaron3/servo/apps/control-plane/internal/lifecycle"
)

const (
	privateKeyPath = "/run/agentops-github-app/private-key.pem"
	maxKeyBytes    = 64 * 1024
)

func main() {
	if err := run(); err != nil {
		log.Printf("agentops GitHub credential broker failed closed: %v", err)
		os.Exit(1)
	}
}

func run() error {
	appID, err := positiveInt64("AGENTOPS_GITHUB_APP_ID")
	if err != nil {
		return err
	}
	installationID, err := positiveInt64(
		"AGENTOPS_GITHUB_APP_INSTALLATION_ID",
	)
	if err != nil {
		return err
	}
	mode, err := lifecycle.ParseMode(required("AGENTOPS_OPERATING_MODE"))
	if err != nil || (mode != lifecycle.ModeMonitorOnly &&
		!DevelopmentMode(mode)) {
		return fmt.Errorf(
			"AGENTOPS_OPERATING_MODE must be MONITOR_ONLY, ACTIVE, or DRAINING",
		)
	}
	owner := required("AGENTOPS_GITHUB_APP_OWNER")
	appSlug := required("AGENTOPS_GITHUB_APP_SLUG")
	policies := brokerPolicies(mode)
	capabilities := map[githubapp.Role]string{
		githubapp.RoleTriage: required(
			"AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY",
		),
	}
	if DevelopmentMode(mode) {
		capabilities[githubapp.RoleRunner] = required(
			"AGENTOPS_GITHUB_BROKER_RUNNER_CAPABILITY",
		)
	}
	key, err := loadPrivateKey()
	if err != nil {
		return err
	}
	issuer, err := githubapp.NewIssuer(githubapp.IssuerConfig{
		AppID:          appID,
		InstallationID: installationID,
		AppSlug:        appSlug,
		Owner:          owner,
		PrivateKey:     key,
		Policies:       policies,
	}, nil, nil)
	if err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer cancel()
	warmContext, warmCancel := context.WithTimeout(ctx, 90*time.Second)
	defer warmCancel()
	if err := issuer.Warm(warmContext); err != nil {
		return fmt.Errorf("GitHub App startup verification failed: %w", err)
	}
	broker, err := githubapp.NewServer(issuer, capabilities)
	if err != nil {
		return err
	}
	server := githubapp.HTTPServer(
		environmentValue("AGENTOPS_GITHUB_BROKER_LISTEN", "0.0.0.0:8083"),
		broker.Handler(),
	)
	errors := make(chan error, 1)
	go func() {
		log.Printf(
			"agentops GitHub credential broker ready app=%s installation=%d roles=%s",
			appSlug,
			installationID,
			roles(issuer.Roles()),
		)
		errors <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownContext, shutdownCancel := context.WithTimeout(
			context.Background(),
			10*time.Second,
		)
		defer shutdownCancel()
		return server.Shutdown(shutdownContext)
	case serveErr := <-errors:
		if serveErr == http.ErrServerClosed {
			return nil
		}
		return serveErr
	}
}

func loadPrivateKey() (*rsa.PrivateKey, error) {
	info, err := os.Lstat(privateKeyPath)
	if err != nil || !info.Mode().IsRegular() ||
		info.Mode().Perm()&0o077 != 0 ||
		info.Size() < 1 || info.Size() > maxKeyBytes {
		return nil, fmt.Errorf(
			"GitHub App private key volume has an invalid file boundary",
		)
	}
	contents, err := os.ReadFile(privateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("GitHub App private key is unavailable")
	}
	return githubapp.ParseRSAPrivateKeyPEM(contents)
}

func positiveInt64(name string) (int64, error) {
	value, err := strconv.ParseInt(required(name), 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func required(name string) string {
	return strings.TrimSpace(os.Getenv(name))
}

func environmentValue(name, fallback string) string {
	if value := required(name); value != "" {
		return value
	}
	return fallback
}

// DevelopmentMode reports whether the lifecycle state still carries development
// work. DRAINING is reachable only from ACTIVE, and a draining runner has to
// push and close the attempt it was told to finish, so it keeps exactly ACTIVE's
// role policies. Refusing to start while draining would strand that runner
// without a credential source; widening the policies is never the answer either.
func DevelopmentMode(mode lifecycle.Mode) bool {
	return mode == lifecycle.ModeActive || mode == lifecycle.ModeDraining
}

// brokerPolicies is the whole role/scope table. It is pure so the scopes each
// mode grants can be asserted without standing up an issuer.
func brokerPolicies(mode lifecycle.Mode) []githubapp.Policy {
	policies := []githubapp.Policy{{
		Role: githubapp.RoleTriage,
		Permissions: map[string]string{
			"contents":      "read",
			"issues":        triageIssuePermission(mode),
			"pull_requests": "read",
		},
	}}
	if !DevelopmentMode(mode) {
		return policies
	}
	return append(policies, githubapp.Policy{
		Role: githubapp.RoleRunner,
		Permissions: map[string]string{
			"actions":       "read",
			"checks":        "read",
			"contents":      "write",
			"issues":        "write",
			"pull_requests": "write",
			"statuses":      "read",
			"workflows":     "write",
		},
	})
}

func triageIssuePermission(mode lifecycle.Mode) string {
	if DevelopmentMode(mode) {
		return "write"
	}
	return "read"
}

func roles(values []githubapp.Role) string {
	rendered := make([]string, len(values))
	for index, role := range values {
		rendered[index] = string(role)
	}
	return strings.Join(rendered, ",")
}
