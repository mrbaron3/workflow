package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The role capabilities are generated rather than authored. Bootstrap asks the
// operator for no additional secret, yet each role's right to mint installation
// tokens stays independent of every other credential: it is not derived from a
// database password, and destroying this store revokes only the capabilities.
//
// They live on the host rather than in the key volume because agentopsctl
// itself needs the values — it injects them into the broker, triage, and runner
// specs and compares them when checking a running topology for drift. Hiding
// them in a container volume would mean piping a secret back out on every
// command.
const (
	brokerCapabilityStoreVersion = 1
	brokerCapabilityBytes        = 32
	brokerCapabilityFileName     = "broker-capabilities.json"
	maxBrokerCapabilityStoreSize = 4096
)

type brokerCapabilityStore struct {
	Version int    `json:"version"`
	Triage  string `json:"triage"`
	Runner  string `json:"runner"`
}

func brokerCapabilityStorePath(prefix string) (string, error) {
	if !resourceName(prefix) {
		return "", fmt.Errorf(
			"AGENTOPSCTL_NAME_PREFIX must be a safe named-resource prefix",
		)
	}
	root := strings.TrimSpace(os.Getenv("AGENTOPSCTL_STATE_DIR"))
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot locate the agentopsctl state directory")
		}
		root = filepath.Join(home, ".agentops")
	}
	if !filepath.IsAbs(root) || root == "/" {
		return "", fmt.Errorf("AGENTOPSCTL_STATE_DIR must be a specific absolute path")
	}
	return filepath.Join(root, prefix, brokerCapabilityFileName), nil
}

func generateBrokerCapability() (string, error) {
	buffer := make([]byte, brokerCapabilityBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate GitHub broker capability")
	}
	// 32 raw bytes render as exactly 43 URL-safe characters, which is the
	// shortest value brokerCapabilityPattern and the workers accept.
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func readBrokerCapabilityStore(path string) (brokerCapabilityStore, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
		info.Size() < 1 || info.Size() > maxBrokerCapabilityStoreSize {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store must be a private regular file",
		)
	}
	file, err := os.Open(path)
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	defer file.Close()
	contents, err := io.ReadAll(
		io.LimitReader(file, maxBrokerCapabilityStoreSize+1),
	)
	if err != nil || len(contents) > maxBrokerCapabilityStoreSize {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store is unreadable",
		)
	}
	var store brokerCapabilityStore
	if err := json.Unmarshal(contents, &store); err != nil {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store is not valid JSON",
		)
	}
	if store.Version != brokerCapabilityStoreVersion ||
		!brokerCapabilityPattern.MatchString(store.Triage) ||
		!brokerCapabilityPattern.MatchString(store.Runner) ||
		store.Triage == store.Runner {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store is invalid; remove it while OFF to regenerate",
		)
	}
	return store, nil
}

func writeBrokerCapabilityStore(
	path string,
	store brokerCapabilityStore,
) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("prepare the agentopsctl state directory")
	}
	// MkdirAll honours the umask and leaves an existing directory alone, so the
	// private mode is asserted rather than assumed.
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("protect the agentopsctl state directory")
	}
	contents, err := json.Marshal(store)
	if err != nil {
		return err
	}
	temporary := path + ".new"
	_ = os.Remove(temporary)
	file, err := os.OpenFile(
		temporary,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create the GitHub broker capability store")
	}
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(contents); err != nil {
		return fmt.Errorf("write the GitHub broker capability store")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync the GitHub broker capability store")
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close the GitHub broker capability store")
	}
	if err := os.Rename(temporary, path); err != nil {
		return fmt.Errorf("activate the GitHub broker capability store")
	}
	removeTemporary = false
	return nil
}

// loadOrCreateBrokerCapabilities returns the persisted capabilities, generating
// and storing them on first use. It is idempotent: every later command reads
// back the same values, which is what lets a running topology keep matching its
// desired spec.
func loadOrCreateBrokerCapabilities(
	path string,
) (brokerCapabilityStore, error) {
	store, err := readBrokerCapabilityStore(path)
	if err == nil {
		return store, nil
	}
	if !os.IsNotExist(err) {
		return brokerCapabilityStore{}, err
	}
	triage, err := generateBrokerCapability()
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	runner, err := generateBrokerCapability()
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	store = brokerCapabilityStore{
		Version: brokerCapabilityStoreVersion,
		Triage:  triage,
		Runner:  runner,
	}
	if err := writeBrokerCapabilityStore(path, store); err != nil {
		return brokerCapabilityStore{}, err
	}
	return store, nil
}

// resolveBrokerCapabilities prefers an explicit operator value so an external
// secret manager can stay the source of truth, and otherwise falls back to the
// generated store. The store is only touched when something is missing.
func resolveBrokerCapabilities(
	prefix, triage, runner string,
) (string, string, error) {
	if triage != "" && runner != "" {
		return triage, runner, nil
	}
	path, err := brokerCapabilityStorePath(prefix)
	if err != nil {
		return "", "", err
	}
	store, err := loadOrCreateBrokerCapabilities(path)
	if err != nil {
		return "", "", err
	}
	if triage == "" {
		triage = store.Triage
	}
	if runner == "" {
		runner = store.Runner
	}
	return triage, runner, nil
}
