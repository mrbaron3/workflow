package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/mrbaron3/servo/apps/control-plane/internal/githubapp"
)

// Git asks for one field at a time with a fixed prompt. Matching the whole
// prompt — rather than searching it for a keyword — is what lets the helper
// read the destination back out and refuse to answer for anyone but GitHub.
var askpassPromptPattern = regexp.MustCompile(
	`^(username|password) for '([^']+)':?$`,
)

const (
	brokerURLKey        = "AGENTOPS_GITHUB_BROKER_URL"
	brokerCapabilityKey = "AGENTOPS_GITHUB_BROKER_CAPABILITY"
	brokerRoleKey       = "AGENTOPS_GITHUB_BROKER_ROLE"
	brokerRepositoryKey = "AGENTOPS_GITHUB_REPOSITORY"
	privateKeyDirectory = "/run/agentops-github-app"
	privateKeyPath      = privateKeyDirectory + "/private-key.pem"
	realGitHubCLI       = "/usr/local/libexec/agentops-gh-real"
)

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "GitHub credential helper failed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	switch filepath.Base(os.Args[0]) {
	case "gh":
		return runGitHubCLI()
	case "agentops-git-askpass":
		return runAskpass()
	}
	if len(os.Args) != 2 {
		return fmt.Errorf("expected actor, health, seed, or seed-wait")
	}
	switch os.Args[1] {
	case "actor":
		return printActorLogin()
	case "health":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return client().Health(ctx)
	case "seed":
		return seedPrivateKey()
	case "seed-wait":
		return seedWait()
	default:
		return fmt.Errorf("unsupported helper operation")
	}
}

func client() githubapp.BrokerClient {
	return githubapp.BrokerClient{
		BaseURL:    strings.TrimSpace(os.Getenv(brokerURLKey)),
		Capability: strings.TrimSpace(os.Getenv(brokerCapabilityKey)),
		Role: githubapp.Role(
			strings.TrimSpace(os.Getenv(brokerRoleKey)),
		),
	}
}

func credential() (githubapp.TokenResponse, error) {
	// The broker may spend two sequential GitHub calls before it answers, so
	// this context has to outlast the client's own transport timeout.
	ctx, cancel := context.WithTimeout(
		context.Background(),
		githubapp.BrokerTokenTimeout+5*time.Second,
	)
	defer cancel()
	repository := strings.TrimSpace(os.Getenv(brokerRepositoryKey))
	return client().Token(ctx, repository)
}

func forbidStaticGitHubToken() error {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if strings.TrimSpace(os.Getenv(key)) != "" {
			return fmt.Errorf("static GitHub token environment is forbidden")
		}
	}
	return nil
}

// printActorLogin resolves the App identity the broker already verified against
// GitHub, so consumers read the actor from the credential itself instead of
// keeping a second configured copy that can drift. The token stays here.
func printActorLogin() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	response, err := client().Actor(ctx)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, response.ActorLogin)
	return err
}

func runGitHubCLI() error {
	if err := forbidStaticGitHubToken(); err != nil {
		return err
	}
	if info, err := os.Stat(realGitHubCLI); err != nil ||
		!info.Mode().IsRegular() {
		return fmt.Errorf("real GitHub CLI is unavailable")
	}
	response, err := credential()
	if err != nil {
		return err
	}
	environment := scrubBrokerEnvironment(os.Environ())
	environment = append(
		environment,
		"GH_TOKEN="+response.Token,
		"GITHUB_TOKEN="+response.Token,
		"GH_HOST=github.com",
	)
	arguments := append([]string{"gh"}, os.Args[1:]...)
	return syscall.Exec(realGitHubCLI, arguments, environment)
}

// askpassField reports which credential field Git is asking for, and refuses
// any prompt it does not recognise or that names a host other than GitHub.
// GIT_ASKPASS answers every remote a repository happens to reference, so an
// unrecognised prompt must fail rather than fall through to the token.
func askpassField(arguments []string) (string, error) {
	prompt := strings.ToLower(strings.TrimSpace(strings.Join(arguments, " ")))
	match := askpassPromptPattern.FindStringSubmatch(prompt)
	if match == nil {
		return "", fmt.Errorf("credential prompt is unsupported")
	}
	target, err := url.Parse(match[2])
	if err != nil || target.Scheme != "https" ||
		target.Hostname() != "github.com" {
		return "", fmt.Errorf("credential prompt is outside github.com")
	}
	return match[1], nil
}

func runAskpass() error {
	if err := forbidStaticGitHubToken(); err != nil {
		return err
	}
	field, err := askpassField(os.Args[1:])
	if err != nil {
		return err
	}
	if field == "username" {
		_, err := fmt.Fprintln(os.Stdout, "x-access-token")
		return err
	}
	response, err := credential()
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(os.Stdout, response.Token)
	return err
}

func scrubBrokerEnvironment(source []string) []string {
	result := make([]string, 0, len(source))
	for _, entry := range source {
		key, _, present := strings.Cut(entry, "=")
		if present && (key == brokerURLKey ||
			key == brokerCapabilityKey ||
			key == brokerRoleKey ||
			key == brokerRepositoryKey ||
			key == "GH_TOKEN" ||
			key == "GITHUB_TOKEN") {
			continue
		}
		result = append(result, entry)
	}
	return result
}

func seedWait() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("seed initializer must start as root")
	}
	if err := preparePrivateKeyDirectory(
		privateKeyDirectory,
		os.MkdirAll,
		os.Chown,
		os.Chmod,
	); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer cancel()
	timer := time.NewTimer(10 * time.Minute)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
	return nil
}

func preparePrivateKeyDirectory(
	directory string,
	mkdirAll func(string, os.FileMode) error,
	chown func(string, int, int) error,
	chmod func(string, os.FileMode) error,
) error {
	if err := mkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("prepare private key volume")
	}
	// The initializer deliberately retains only CAP_CHOWN. Reclaim ownership
	// before chmod so a reused volume can be hardened without CAP_FOWNER, then
	// hand the directory back to the non-root broker identity.
	if err := chown(directory, 0, 0); err != nil {
		return fmt.Errorf("reclaim private key volume ownership")
	}
	if err := chmod(directory, 0o700); err != nil {
		return fmt.Errorf("protect private key volume")
	}
	if err := chown(directory, 65532, 65532); err != nil {
		return fmt.Errorf("assign private key volume ownership")
	}
	return nil
}

func seedPrivateKey() error {
	if os.Geteuid() != 65532 {
		return fmt.Errorf("seed writer must run as the broker identity")
	}
	info, err := os.Lstat(privateKeyDirectory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private key volume is not ready")
	}
	contents, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024+1))
	if err != nil || len(contents) < 1 || len(contents) > 64*1024 {
		return fmt.Errorf("private key input is invalid")
	}
	if _, err := githubapp.ParseRSAPrivateKeyPEM(contents); err != nil {
		return err
	}
	temporary := privateKeyPath + ".new"
	_ = os.Remove(temporary)
	file, err := os.OpenFile(
		temporary,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o400,
	)
	if err != nil {
		return fmt.Errorf("create private key volume file")
	}
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(contents); err != nil {
		return fmt.Errorf("write private key volume file")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync private key volume file")
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close private key volume file")
	}
	if err := os.Rename(temporary, privateKeyPath); err != nil {
		return fmt.Errorf("activate private key volume file")
	}
	removeTemporary = false
	return nil
}
