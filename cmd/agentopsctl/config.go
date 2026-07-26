package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

type config struct {
	Prefix               string
	Network              string
	PostgresVolume       string
	RunnerVolume         string
	CredentialVolume     string
	PostgresContainer    string
	ControlContainer     string
	RunnerContainer      string
	PostgresImage        string
	ControlImage         string
	RunnerImage          string
	ProjectRoot          string
	ControlHostPort      int
	PostgresPassword     string
	NextPostgresPassword string
	ControlDBPassword    string
	RunnerDBPassword     string
	ControlToken         string
	DashboardToken       string
	WebhookSecret        string
	ControlGitHubToken   string
	RunnerGitHubToken    string
	Provider             string
	ProviderToken        string
	CodexAuthPath        string
	MonitorRepository    string
}

func loadConfig() (config, error) {
	root := strings.TrimSpace(os.Getenv("AGENTOPSCTL_PROJECT_ROOT"))
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			return config{}, err
		}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return config{}, err
	}
	prefix := environmentValue("AGENTOPSCTL_NAME_PREFIX", "agentops")
	port, err := strconv.Atoi(environmentValue("AGENTOPSCTL_CONTROL_HOST_PORT", "8080"))
	if err != nil || port < 1 || port > 65535 {
		return config{}, fmt.Errorf("AGENTOPSCTL_CONTROL_HOST_PORT must be 1..65535")
	}
	provider := strings.ToLower(environmentValue("AGENTOPS_RUNNER_PROVIDER", "codex"))
	var providerToken string
	var codexAuthPath string
	switch provider {
	case "codex":
		providerToken = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
		codexAuthPath = strings.TrimSpace(os.Getenv("AGENTOPS_RUNNER_CODEX_AUTH_FILE"))
		if providerToken == "" && codexAuthPath == "" {
			if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
				codexAuthPath = filepath.Join(codexHome, "auth.json")
			} else if userHome, homeErr := os.UserHomeDir(); homeErr == nil {
				codexAuthPath = filepath.Join(userHome, ".codex", "auth.json")
			}
		}
	case "claude":
		providerToken = strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	default:
		return config{}, fmt.Errorf("AGENTOPS_RUNNER_PROVIDER must be codex or claude")
	}
	return config{
		Prefix:            prefix,
		Network:           prefix + "-internal",
		PostgresVolume:    prefix + "-postgres-data",
		RunnerVolume:      prefix + "-runner-workspace",
		CredentialVolume:  prefix + "-runner-credentials",
		PostgresContainer: prefix + "-postgres",
		ControlContainer:  prefix + "-control",
		RunnerContainer:   prefix + "-runner",
		PostgresImage:     environmentValue("AGENTOPSCTL_POSTGRES_IMAGE", "agentops-postgres:dev"),
		ControlImage:      environmentValue("AGENTOPSCTL_CONTROL_IMAGE", "agentops-control:dev"),
		RunnerImage:       environmentValue("AGENTOPSCTL_RUNNER_IMAGE", "agentops-runner:dev"),
		ProjectRoot:       root,
		ControlHostPort:   port,
		PostgresPassword:  strings.TrimSpace(os.Getenv("AGENTOPS_POSTGRES_PASSWORD")),
		NextPostgresPassword: strings.TrimSpace(
			os.Getenv("AGENTOPS_NEXT_POSTGRES_PASSWORD"),
		),
		ControlDBPassword:  strings.TrimSpace(os.Getenv("AGENTOPS_CONTROL_DB_PASSWORD")),
		RunnerDBPassword:   strings.TrimSpace(os.Getenv("AGENTOPS_RUNNER_DB_PASSWORD")),
		ControlToken:       strings.TrimSpace(os.Getenv("AGENTOPS_CONTROL_TOKEN")),
		DashboardToken:     strings.TrimSpace(os.Getenv("AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN")),
		WebhookSecret:      strings.TrimSpace(os.Getenv("AGENTOPS_GITHUB_WEBHOOK_SECRET")),
		ControlGitHubToken: strings.TrimSpace(os.Getenv("AGENTOPS_CONTROL_GITHUB_TOKEN")),
		RunnerGitHubToken:  strings.TrimSpace(os.Getenv("AGENTOPS_RUNNER_GITHUB_TOKEN")),
		Provider:           provider,
		ProviderToken:      providerToken,
		CodexAuthPath:      codexAuthPath,
		MonitorRepository: strings.ToLower(environmentValue(
			"AGENTOPS_MONITOR_REPOSITORY",
			"mrbaron3/workflow",
		)),
	}, nil
}

func (value config) validateStart(mode lifecycle.Mode) error {
	if !resourceName(value.Prefix) {
		return fmt.Errorf("AGENTOPSCTL_NAME_PREFIX must be a safe named-resource prefix")
	}
	if value.ProjectRoot == "/" || !filepath.IsAbs(value.ProjectRoot) {
		return fmt.Errorf("AGENTOPSCTL_PROJECT_ROOT must be a specific absolute repository path")
	}
	if _, err := os.Stat(filepath.Join(value.ProjectRoot, "deploy", "Containerfile")); err != nil {
		return fmt.Errorf("AGENTOPSCTL_PROJECT_ROOT has no deploy/Containerfile: %w", err)
	}
	secrets := map[string]string{
		"AGENTOPS_POSTGRES_PASSWORD":         value.PostgresPassword,
		"AGENTOPS_CONTROL_DB_PASSWORD":       value.ControlDBPassword,
		"AGENTOPS_RUNNER_DB_PASSWORD":        value.RunnerDBPassword,
		"AGENTOPS_CONTROL_TOKEN":             value.ControlToken,
		"AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN": value.DashboardToken,
		"AGENTOPS_GITHUB_WEBHOOK_SECRET":     value.WebhookSecret,
	}
	for name, secret := range secrets {
		if len(secret) < 32 {
			return fmt.Errorf("%s must be at least 32 bytes", name)
		}
	}
	if value.PostgresPassword == value.ControlDBPassword ||
		value.PostgresPassword == value.RunnerDBPassword ||
		value.ControlDBPassword == value.RunnerDBPassword {
		return fmt.Errorf("PostgreSQL admin, control, and runner credentials must be distinct")
	}
	if value.MonitorRepository != "mrbaron3/workflow" {
		return fmt.Errorf(
			"AGENTOPS_MONITOR_REPOSITORY is bounded to mrbaron3/workflow for CISO-07",
		)
	}
	if len(value.RunnerGitHubToken) < 20 {
		return fmt.Errorf(
			"AGENTOPS_RUNNER_GITHUB_TOKEN is required for the private monitor broker",
		)
	}
	if mode == lifecycle.ModeActive {
		if value.Provider == "codex" && len(value.ProviderToken) < 20 {
			if err := validateCodexAuthSource(value.CodexAuthPath); err != nil {
				return err
			}
		} else if len(value.ProviderToken) < 20 {
			return fmt.Errorf("ANTHROPIC_API_KEY is required for the isolated runner")
		}
	}
	if value.ControlGitHubToken != "" {
		return fmt.Errorf(
			"AGENTOPS_CONTROL_GITHUB_TOKEN is forbidden for the private monitor broker",
		)
	}
	return nil
}

func (value config) usesCodexAuthFile() bool {
	return value.Provider == "codex" && len(value.ProviderToken) < 20
}

func (value config) providerAuth(mode lifecycle.Mode) string {
	if mode != lifecycle.ModeActive {
		return "none"
	}
	if value.usesCodexAuthFile() {
		return "codex-login"
	}
	return "api-key"
}

func (value config) usesCodexAuthFileFor(mode lifecycle.Mode) bool {
	return mode == lifecycle.ModeActive && value.usesCodexAuthFile()
}

func (value config) validatePostgresRotation() error {
	if len(value.PostgresPassword) < 32 {
		return fmt.Errorf("AGENTOPS_POSTGRES_PASSWORD must be at least 32 bytes")
	}
	if len(value.NextPostgresPassword) < 32 {
		return fmt.Errorf("AGENTOPS_NEXT_POSTGRES_PASSWORD must be at least 32 bytes")
	}
	if value.NextPostgresPassword == value.PostgresPassword ||
		value.NextPostgresPassword == value.ControlDBPassword ||
		value.NextPostgresPassword == value.RunnerDBPassword {
		return fmt.Errorf(
			"next PostgreSQL administrator credential must be distinct from current database credentials",
		)
	}
	return nil
}

func validateCodexAuthSource(source string) error {
	if strings.TrimSpace(source) == "" {
		return fmt.Errorf(
			"OPENAI_API_KEY or AGENTOPS_RUNNER_CODEX_AUTH_FILE is required for ACTIVE codex runner",
		)
	}
	absolute, err := filepath.Abs(source)
	if err != nil || absolute != source || filepath.Base(absolute) != "auth.json" {
		return fmt.Errorf("Codex auth source must be an absolute auth.json file")
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return fmt.Errorf("Codex auth source is unavailable")
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Codex auth source must be a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("Codex auth source must not be group/world accessible")
	}
	return nil
}

func (value config) adminDatabaseURL(host string) string {
	return databaseURL("postgres", value.PostgresPassword, host)
}

func (value config) controlDatabaseURL(host string) string {
	return databaseURL(
		"agentops_control_app",
		value.ControlDBPassword,
		host,
	)
}

func (value config) runnerDatabaseURL(host string) string {
	return databaseURL("agentops_runner", value.RunnerDBPassword, host)
}

func databaseURL(user, password, host string) string {
	return (&url.URL{
		Scheme: "postgresql",
		User:   url.UserPassword(user, password),
		Host:   host + ":5432",
		Path:   "/agentops",
	}).String()
}

func environmentValue(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func resourceName(value string) bool {
	if value == "" || len(value) > 80 {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '-' || character == '_' || character == '.')) {
			continue
		}
		return false
	}
	return true
}
