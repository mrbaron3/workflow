package designgate

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/mrbaron3/servo/apps/control-plane/internal/jsonschemaregexp"
)

// The embedded schemas are byte-for-byte mirrors of the canonical Designflow
// contracts in the repository root. Keeping them in the control binary makes
// startup validation independent of npm, the network, or a mutable provider
// branch. The mirror test prevents either copy from drifting.
//
//go:generate go run ./cmd/syncschemas
//go:embed schemas/*.schema.json
var pinnedSchemaFiles embed.FS

const designTokensSchemaRef = "https://www.designtokens.org/TR/2025.10/format/"

func validatePinnedSchema(schemaRef string, body []byte) error {
	compiler := jsonschema.NewCompiler()
	compiler.UseRegexpEngine(jsonschemaregexp.Compile)
	compiler.AssertFormat()
	entries, err := fs.Glob(pinnedSchemaFiles, "schemas/*.schema.json")
	if err != nil {
		return err
	}
	for _, name := range entries {
		raw, err := pinnedSchemaFiles.ReadFile(name)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(raw)
		if hex.EncodeToString(digest[:]) != pinnedSchemaSHA256[path.Base(name)] {
			return fmt.Errorf("pinned schema %s does not match its compiled provenance digest", path.Base(name))
		}
		var document any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&document); err != nil {
			return fmt.Errorf("decode pinned schema %s: %w", path.Base(name), err)
		}
		identifier, ok := document.(map[string]any)["$id"].(string)
		if !ok || identifier == "" {
			return fmt.Errorf("pinned schema %s has no $id", path.Base(name))
		}
		if err := compiler.AddResource(identifier, document); err != nil {
			return fmt.Errorf("register pinned schema %s: %w", identifier, err)
		}
	}
	schema, err := compiler.Compile(schemaRef)
	if err != nil {
		return fmt.Errorf("compile pinned schema %s: %w", schemaRef, err)
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("decode schema instance: %w", err)
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("%s validation failed: %w", schemaRef, err)
	}
	return nil
}

func validateDesignTokens(body []byte) error {
	var document map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("decode design tokens: %w", err)
	}
	tokenCount, err := validateTokenGroup(document, "", "")
	if err != nil {
		return err
	}
	if tokenCount == 0 {
		return fmt.Errorf("design token document has no tokens")
	}
	return nil
}

func validateTokenGroup(group map[string]any, location, inheritedType string) (int, error) {
	currentType := inheritedType
	if tokenType, present := group["$type"]; present {
		value, ok := tokenType.(string)
		if !ok || strings.TrimSpace(value) == "" {
			return 0, fmt.Errorf("design token %s has an invalid $type", location)
		}
		currentType = value
	}
	if value, isToken := group["$value"]; isToken {
		if currentType == "" {
			return 0, fmt.Errorf("design token %s has no inherited or local $type", location)
		}
		if value == nil {
			return 0, fmt.Errorf("design token %s has a null $value", location)
		}
		for key := range group {
			if !strings.HasPrefix(key, "$") {
				return 0, fmt.Errorf("design token %s mixes $value with child %s", location, key)
			}
		}
		return 1, nil
	}
	count := 0
	for key, child := range group {
		if strings.HasPrefix(key, "$") {
			continue
		}
		if key == "" {
			return 0, fmt.Errorf("design token group %s has an empty child name", location)
		}
		childObject, ok := child.(map[string]any)
		if !ok {
			return 0, fmt.Errorf("design token group %s.%s is not an object", location, key)
		}
		childCount, err := validateTokenGroup(
			childObject,
			strings.TrimPrefix(location+"."+key, "."),
			currentType,
		)
		if err != nil {
			return 0, err
		}
		count += childCount
	}
	return count, nil
}
