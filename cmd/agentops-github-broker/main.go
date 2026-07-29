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

	"github.com/mrbaron3/workflow/internal/control"
	"github.com/mrbaron3/workflow/internal/githubapp"
	"github.com/mrbaron3/workflow/internal/lifecycle"
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
		mode != lifecycle.ModeActive) {
		return fmt.Errorf(
			"AGENTOPS_OPERATING_MODE must be MONITOR_ONLY or ACTIVE",
		)
	}
	owner := required("AGENTOPS_GITHUB_APP_OWNER")
	appSlug := required("AGENTOPS_GITHUB_APP_SLUG")
	monitorRepositories, err := repositories(
		"AGENTOPS_MONITOR_REPOSITORIES",
		owner,
	)
	if err != nil {
		return err
	}
	policies := []githubapp.Policy{{
		Role:         githubapp.RoleTriage,
		Repositories: monitorRepositories,
		Permissions: map[string]string{
			"contents":      "read",
			"issues":        triageIssuePermission(mode),
			"pull_requests": "read",
		},
	}}
	capabilities := map[githubapp.Role]string{
		githubapp.RoleTriage: required(
			"AGENTOPS_GITHUB_BROKER_TRIAGE_CAPABILITY",
		),
	}
	if mode == lifecycle.ModeActive {
		runnerRepositories, repositoryErr := repositories(
			"AGENTOPS_RUNNER_REPOSITORIES",
			owner,
		)
		if repositoryErr != nil {
			return repositoryErr
		}
		policies = append(policies, githubapp.Policy{
			Role:         githubapp.RoleRunner,
			Repositories: runnerRepositories,
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

func repositories(name, owner string) ([]string, error) {
	raw := required(name)
	values := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(values))
	if len(values) < 1 || len(values) > 64 {
		return nil, fmt.Errorf("%s must contain 1..64 repositories", name)
	}
	for index := range values {
		values[index] = strings.TrimSpace(values[index])
		if values[index] != strings.ToLower(values[index]) ||
			!control.ValidRepositoryIdentity(values[index]) ||
			!strings.HasPrefix(values[index], owner+"/") {
			return nil, fmt.Errorf(
				"%s must contain canonical repositories owned by the App installation account",
				name,
			)
		}
		if _, duplicate := seen[values[index]]; duplicate {
			return nil, fmt.Errorf("%s must not contain duplicates", name)
		}
		seen[values[index]] = struct{}{}
	}
	return values, nil
}

func triageIssuePermission(mode lifecycle.Mode) string {
	if mode == lifecycle.ModeActive {
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
