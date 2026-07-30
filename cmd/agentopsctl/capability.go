package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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

// brokerCapabilityStoreOwnedByCaller reports whether the invoking account owns
// the entry. An unreadable owner is treated as foreign: a store whose provenance
// cannot be established is not one to mint GitHub tokens from.
func brokerCapabilityStoreOwnedByCaller(info os.FileInfo) bool {
	status, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(status.Uid) == os.Geteuid()
}

func readBrokerCapabilityStore(path string) (brokerCapabilityStore, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	// Write permission on the containing directory is enough to rename a chosen
	// store over this one, so a private file mode alone would not keep the
	// capabilities the operator's. A store that could have been substituted is
	// refused rather than tightened: the mode is repairable, the value is not.
	directory, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return brokerCapabilityStore{}, err
	}
	if !directory.IsDir() || directory.Mode().Perm()&0o077 != 0 {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store must sit in a private directory",
		)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
		info.Size() < 1 || info.Size() > maxBrokerCapabilityStoreSize {
		return brokerCapabilityStore{}, fmt.Errorf(
			"GitHub broker capability store must be a private regular file",
		)
	}
	// Ownership is what makes the mode checks above mean anything. Substituting a
	// store means presenting a directory and file that look private, and only
	// root may chown one to another account — so an unprivileged principal who
	// can write an ancestor can replace this directory but never forge whose it
	// is. Checking the owner is what still holds when the mode bits do not
	// decide access: agentopsctl running privileged traverses any directory, and
	// an ACL can grant access the permission bits do not express.
	for _, entry := range []os.FileInfo{directory, info} {
		if !brokerCapabilityStoreOwnedByCaller(entry) {
			return brokerCapabilityStore{}, fmt.Errorf(
				"GitHub broker capability store must belong to the account running agentopsctl",
			)
		}
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

// errBrokerCapabilityStoreExists reports that another command created the store
// first. The command that lost the race must adopt the persisted capabilities
// rather than the ones it generated, or the two would inject different values.
var errBrokerCapabilityStoreExists = errors.New(
	"GitHub broker capability store already exists",
)

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
	// The temporary carries a unique name so two commands bootstrapping at once
	// cannot collide on it, and it is a sibling because the link below cannot
	// cross a filesystem.
	file, err := os.CreateTemp(directory, brokerCapabilityFileName+".*")
	if err != nil {
		return fmt.Errorf("create the GitHub broker capability store")
	}
	temporary := file.Name()
	defer func() {
		_ = file.Close()
		_ = os.Remove(temporary)
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
	// Linking rather than renaming makes activation exclusive as well as atomic:
	// a rename would silently clobber a store another command had just created,
	// leaving that command with a capability the store no longer holds. Nothing
	// may overwrite a capability store in place — rotation removes it first.
	if err := os.Link(temporary, path); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return errBrokerCapabilityStoreExists
		}
		return fmt.Errorf("activate the GitHub broker capability store")
	}
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
		if !errors.Is(err, errBrokerCapabilityStoreExists) {
			return brokerCapabilityStore{}, err
		}
		// Another command bootstrapped first. Its capabilities are the ones the
		// broker will be started with, so this command returns them too instead
		// of the pair it generated and threw away.
		return readBrokerCapabilityStore(path)
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
