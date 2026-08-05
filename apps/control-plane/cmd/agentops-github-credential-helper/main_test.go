package main

import (
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// GIT_ASKPASS answers for every remote a repository references, so the helper
// must recognise the exact prompt and its destination before it will speak.
func TestAskpassAnswersOnlyRecognisedGitHubPrompts(t *testing.T) {
	for name, prompt := range map[string]string{
		"github username": "Username for 'https://github.com': ",
		"github password": "Password for 'https://x-access-token@github.com': ",
	} {
		field, err := askpassField([]string{prompt})
		if err != nil {
			t.Fatalf("%s was refused: %v", name, err)
		}
		if !strings.HasSuffix(name, field) {
			t.Fatalf("%s resolved to field %q", name, field)
		}
	}
	for name, prompt := range map[string]string{
		"foreign host": "Password for 'https://evil.example.com': ",
		"host suffix confusion": "Password for " +
			"'https://github.com.evil.example': ",
		"embedded host":       "Password for 'https://evil.example/github.com': ",
		"plaintext github":    "Password for 'http://github.com': ",
		"unstructured prompt": "Enter your credential for github.com",
		"passphrase prompt": "Enter passphrase for key " +
			"'/home/agentops/.ssh/id_ed25519': ",
		"empty prompt": "",
	} {
		if field, err := askpassField([]string{prompt}); err == nil {
			t.Fatalf("%s was answered with field %q", name, field)
		}
	}
}

func TestStaticGitHubTokenEnvironmentFailsClosed(t *testing.T) {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		t.Setenv(key, "static-operator-token")
		if err := forbidStaticGitHubToken(); err == nil {
			t.Fatalf("%s did not fail closed", key)
		}
		t.Setenv(key, "")
	}
	if err := forbidStaticGitHubToken(); err != nil {
		t.Fatalf("credential-free environment was refused: %v", err)
	}
}

// The real gh inherits this environment, so the broker credential must not be
// reachable from anything gh starts in turn.
func TestScrubbedEnvironmentKeepsNoBrokerCredential(t *testing.T) {
	scrubbed := scrubBrokerEnvironment([]string{
		"PATH=/usr/local/bin",
		brokerURLKey + "=http://broker:8083",
		brokerCapabilityKey + "=capability-value",
		brokerRoleKey + "=triage",
		"GH_TOKEN=stale",
		"GITHUB_TOKEN=stale",
		"HOME=/home/agentops",
	})
	sort.Strings(scrubbed)
	want := []string{"HOME=/home/agentops", "PATH=/usr/local/bin"}
	if !reflect.DeepEqual(scrubbed, want) {
		t.Fatalf("scrubbed environment = %#v, want %#v", scrubbed, want)
	}
}

func TestPreparePrivateKeyDirectoryUsesOnlyChownCapability(t *testing.T) {
	var calls []string
	err := preparePrivateKeyDirectory(
		"/private-volume",
		func(path string, mode os.FileMode) error {
			calls = append(calls, "mkdir:"+path+":"+mode.String())
			return nil
		},
		func(path string, uid, gid int) error {
			calls = append(
				calls,
				"chown:"+path+":"+strconv.Itoa(uid)+":"+strconv.Itoa(gid),
			)
			return nil
		},
		func(path string, mode os.FileMode) error {
			calls = append(calls, "chmod:"+path+":"+mode.String())
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"mkdir:/private-volume:-rwx------",
		"chown:/private-volume:0:0",
		"chmod:/private-volume:-rwx------",
		"chown:/private-volume:65532:65532",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}
