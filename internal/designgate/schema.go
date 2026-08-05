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

	"github.com/mrbaron3/servo/internal/jsonschemaregexp"
)

// The schemas are semantic copies from ProviderCommit with trailing blank
// lines normalized. Keeping them in the control binary makes startup
// validation independent of npm, the network, or a mutable provider branch.
//
//go:embed schemas/*.schema.json
var pinnedSchemaFiles embed.FS

const designTokensSchemaRef = "https://www.designtokens.org/TR/2025.10/format/"

var pinnedSchemaSHA256 = map[string]string{
	"capability-requirements.schema.json": "a8c2f5270b1839fdd81c701b25ee3e09ad2e93c43850d55bfcea91093ee71622",
	"common.schema.json":                  "81f243e22e1cf01491748ef2bd819d1827de2dbbb28b895f54e2b0c69f97c86f",
	"design-bundle-manifest.schema.json":  "dcd52f3402483d1e00d27ec45f619dc2b1006d1c99f2c6fc5e910407ddba42aa",
	"design-request.schema.json":          "581241ace55da2b2570375a365dcc897d45d2cf32475458fb8f9aae30835256a",
	"design-system-delta.schema.json":     "849bd066c52acee07736c9f6de4cf6f2661875199d440ccf29704dba3d57c3fa",
	"experience-contract.schema.json":     "2c59fb85b8dfbce406b0d1b84bd4a5f0b711171eea2dc53b14f7dcb9c8d1861f",
	"human-design-decision.schema.json":   "943e60948feffc2c6dd82568a30cc8618407aac275e33581065037dec5f24f01",
}

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
