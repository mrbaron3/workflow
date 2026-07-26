package designgate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateApprovedPinnedBundleAndCoverage(t *testing.T) {
	result, err := Validate(fixtureRoot(t), coverageFixture(t))
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if result.RevisionID != "design-revision-001" ||
		result.BundleDigest != "sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97" ||
		result.CoverageBinding != 2 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestValidateApprovedDashboardRevisionAndReconciliation(t *testing.T) {
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	result, err := ValidateDashboard(repositoryRoot)
	if err != nil {
		t.Fatalf("ValidateDashboard() error = %v", err)
	}
	if result.RevisionID != "workflow-ciso05-dashboard-r02" ||
		result.BundleDigest != ApprovedDashboardBundleDigest ||
		result.DecisionID != "workflow-ciso05-dashboard-r02-approve" ||
		result.CoverageBinding != 7 {
		t.Fatalf("unexpected dashboard result: %#v", result)
	}
}

func TestDashboardPinnedSchemasAndDesignTokenFormatRejectInvalidDocuments(t *testing.T) {
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	experience, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"evidence",
		"ciso-05",
		"design",
		"revision-02",
		"experience-contract.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	var invalidExperience map[string]any
	if err := json.Unmarshal(experience, &invalidExperience); err != nil {
		t.Fatal(err)
	}
	invalidExperience["unapprovedField"] = true
	invalidExperienceBody, _ := json.Marshal(invalidExperience)
	if err := validatePinnedSchema(
		"urn:designflow:schema:v1:experience-contract",
		invalidExperienceBody,
	); err == nil {
		t.Fatal("pinned Experience Contract schema accepted an additional property")
	}

	tokens, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"evidence",
		"ciso-05",
		"design",
		"revision-02",
		"design-tokens.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateDesignTokens(tokens); err != nil {
		t.Fatalf("approved design tokens rejected: %v", err)
	}
	if err := validateDesignTokens([]byte(
		`{"group":{"$type":"color","bad":{"$value":"#fff","child":{"$value":"#000"}}}}`,
	)); err == nil {
		t.Fatal("token validator accepted a token mixed with a child")
	}
}

func TestValidateFailsClosedForApprovalAndCoverageDefects(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, string, string)
	}{
		{
			name: "provider provenance mismatch",
			mutate: func(t *testing.T, root, _ string) {
				rewriteJSON(t, filepath.Join(root, "PROVENANCE.json"), func(value map[string]any) {
					value["commit"] = "0000000000000000000000000000000000000000"
				})
			},
		},
		{
			name: "unapproved",
			mutate: func(t *testing.T, root, _ string) {
				rewriteJSON(t, decisionPath(root), func(value map[string]any) {
					value["verdict"] = "request-changes"
				})
			},
		},
		{
			name: "decision digest mismatch",
			mutate: func(t *testing.T, root, _ string) {
				rewriteJSON(t, decisionPath(root), func(value map[string]any) {
					value["bundleDigest"] = "sha256:" + string(make([]byte, 64))
				})
			},
		},
		{
			name: "mixed coverage revision",
			mutate: func(t *testing.T, _, coveragePath string) {
				rewriteJSON(t, coveragePath, func(value map[string]any) {
					value["revisionId"] = "design-revision-mixed"
				})
			},
		},
		{
			name: "ungrounded system element",
			mutate: func(t *testing.T, _, coveragePath string) {
				rewriteJSON(t, coveragePath, func(value map[string]any) {
					bindings := value["bindings"].([]any)
					first := bindings[0].(map[string]any)
					first["systemElements"] = []any{"ARCH-registration-control-missing"}
				})
			},
		},
		{
			name: "zero capability coverage",
			mutate: func(t *testing.T, _, coveragePath string) {
				rewriteJSON(t, coveragePath, func(value map[string]any) {
					value["bindings"] = []any{}
				})
			},
		},
		{
			name: "missing audit facet",
			mutate: func(t *testing.T, _, coveragePath string) {
				rewriteJSON(t, coveragePath, func(value map[string]any) {
					bindings := value["bindings"].([]any)
					first := bindings[0].(map[string]any)
					delete(first["facets"].(map[string]any), "audit")
				})
			},
		},
		{
			name: "unresolved ambiguity",
			mutate: func(t *testing.T, root, coveragePath string) {
				rebindCapability(t, root, coveragePath, func(value map[string]any) {
					value["ambiguities"] = []any{"retry cancellation is unresolved"}
				})
			},
		},
		{
			name: "incomplete capability",
			mutate: func(t *testing.T, root, coveragePath string) {
				rebindCapability(t, root, coveragePath, func(value map[string]any) {
					capabilities := value["capabilities"].([]any)
					delete(capabilities[0].(map[string]any), "freshnessExpectation")
				})
			},
		},
		{
			name: "self-consistent but untrusted replacement bundle",
			mutate: func(t *testing.T, root, coveragePath string) {
				rebindCapability(t, root, coveragePath, func(value map[string]any) {
					capabilities := value["capabilities"].([]any)
					capabilities[0].(map[string]any)["successOutcome"] =
						"semantically altered replacement outcome"
				})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := copyFixture(t, fixtureRoot(t))
			coveragePath := filepath.Join(root, "coverage.json")
			copyFile(t, coverageFixture(t), coveragePath)
			test.mutate(t, root, coveragePath)
			if _, err := Validate(root, coveragePath); err == nil {
				t.Fatal("Validate() unexpectedly accepted invalid input")
			}
		})
	}
}

func TestCoverageReferencesPublishedAPIAndSystemDocuments(t *testing.T) {
	body, err := os.ReadFile(coverageFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	var trace coverage
	if err := json.Unmarshal(body, &trace); err != nil {
		t.Fatal(err)
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	openAPI, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"contracts",
		"control-api",
		"v1",
		"openapi.yaml",
	))
	if err != nil {
		t.Fatal(err)
	}
	system, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"docs",
		"_system",
		"registration-control",
		"architecture.md",
	))
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range trace.Bindings {
		for _, apiElement := range binding.APIElements {
			parts := strings.SplitN(apiElement, " ", 2)
			if len(parts) != 2 ||
				!strings.Contains(string(openAPI), "  "+parts[1]+":") ||
				!strings.Contains(string(openAPI), "    "+strings.ToLower(parts[0])+":") {
				t.Errorf("API element %q is not grounded in OpenAPI", apiElement)
			}
		}
		for _, systemElement := range binding.SystemElements {
			if !strings.Contains(string(system), "**"+systemElement+" ") {
				t.Errorf("system element %q is not grounded in architecture", systemElement)
			}
		}
	}
}

func rebindCapability(
	t *testing.T,
	root, coveragePath string,
	mutate func(map[string]any),
) {
	t.Helper()
	capabilityPath := filepath.Join(
		root,
		"contracts",
		"v1",
		"examples",
		"capability-requirements.example.json",
	)
	rewriteJSON(t, capabilityPath, mutate)
	capabilityBody, err := os.ReadFile(capabilityPath)
	if err != nil {
		t.Fatal(err)
	}
	capabilityDigest, err := digestArtifact(capabilityBody, "application/json")
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(
		root,
		"contracts",
		"v1",
		"examples",
		"design-bundle-manifest.example.json",
	)
	rewriteJSON(t, manifestPath, func(value map[string]any) {
		artifacts := value["artifacts"].(map[string]any)
		capability := artifacts["capabilityRequirements"].(map[string]any)
		capability["digest"] = capabilityDigest
		value["bundleDigest"] = "sha256:" + "0000000000000000000000000000000000000000000000000000000000000000"
	})
	manifestBody, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	bundleDigest, err := manifestDigest(manifestBody)
	if err != nil {
		t.Fatal(err)
	}
	rewriteJSON(t, manifestPath, func(value map[string]any) {
		value["bundleDigest"] = bundleDigest
	})
	rewriteJSON(t, decisionPath(root), func(value map[string]any) {
		value["bundleDigest"] = bundleDigest
	})
	rewriteJSON(t, coveragePath, func(value map[string]any) {
		value["bundleDigest"] = bundleDigest
	})
}

func fixtureRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join(
		"..",
		"..",
		"contracts",
		"designflow",
		"contract-v1.0.0-rc.1",
	))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func coverageFixture(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join(
		"..",
		"..",
		"evidence",
		"ciso-03",
		"design-capability-trace.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func decisionPath(root string) string {
	return filepath.Join(
		root,
		"contracts",
		"v1",
		"examples",
		"human-design-decision.example.json",
	)
}

func copyFixture(t *testing.T, source string) string {
	t.Helper()
	destination := t.TempDir()
	err := filepath.Walk(source, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, info.Mode())
	})
	if err != nil {
		t.Fatal(err)
	}
	return destination
}

func copyFile(t *testing.T, source, destination string) {
	t.Helper()
	body, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func rewriteJSON(t *testing.T, path string, mutate func(map[string]any)) {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	mutate(value)
	updated, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	updated = append(updated, '\n')
	if err := os.WriteFile(path, updated, 0o600); err != nil {
		t.Fatal(err)
	}
}
