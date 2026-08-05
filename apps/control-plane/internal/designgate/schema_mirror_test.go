package designgate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/mrbaron3/servo/apps/control-plane/internal/reporoot"
)

func TestEmbeddedSchemasMatchCanonicalDesignflowContracts(t *testing.T) {
	root, err := reporoot.Find(".")
	if err != nil {
		t.Fatal(err)
	}
	canonicalRoot := filepath.Join(
		root,
		"contracts",
		"designflow",
		"contract-v1.0.0-rc.1",
		"contracts",
		"v1",
	)
	canonicalPaths, err := filepath.Glob(filepath.Join(canonicalRoot, "*.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(canonicalPaths) == 0 {
		t.Fatal("canonical Designflow schema set is empty")
	}
	embeddedPaths, err := fs.Glob(pinnedSchemaFiles, "schemas/*.schema.json")
	if err != nil {
		t.Fatal(err)
	}

	canonicalNames := make([]string, 0, len(canonicalPaths))
	for _, schemaPath := range canonicalPaths {
		canonicalNames = append(canonicalNames, filepath.Base(schemaPath))
	}
	embeddedNames := make([]string, 0, len(embeddedPaths))
	for _, schemaPath := range embeddedPaths {
		embeddedNames = append(embeddedNames, filepath.Base(schemaPath))
	}
	sort.Strings(canonicalNames)
	sort.Strings(embeddedNames)
	if !reflect.DeepEqual(embeddedNames, canonicalNames) {
		t.Fatalf(
			"embedded schema set = %v, canonical schema set = %v; run go generate ./apps/control-plane/internal/designgate",
			embeddedNames,
			canonicalNames,
		)
	}
	if len(pinnedSchemaSHA256) != len(canonicalNames) {
		t.Fatalf(
			"compiled schema digest set has %d entries, want %d",
			len(pinnedSchemaSHA256),
			len(canonicalNames),
		)
	}

	for _, name := range canonicalNames {
		canonical, readErr := os.ReadFile(filepath.Join(canonicalRoot, name))
		if readErr != nil {
			t.Fatal(readErr)
		}
		embedded, readErr := pinnedSchemaFiles.ReadFile("schemas/" + name)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !bytes.Equal(embedded, canonical) {
			t.Fatalf(
				"embedded schema %s differs from its canonical contract; run go generate ./apps/control-plane/internal/designgate",
				name,
			)
		}
		digest := sha256.Sum256(canonical)
		actualDigest := hex.EncodeToString(digest[:])
		expectedDigest, ok := pinnedSchemaSHA256[name]
		if !ok {
			t.Fatalf("compiled schema digest is missing %s", name)
		}
		if actualDigest != expectedDigest {
			t.Fatalf(
				"compiled digest for %s = %s, canonical digest = %s",
				name,
				expectedDigest,
				actualDigest,
			)
		}
	}
}
