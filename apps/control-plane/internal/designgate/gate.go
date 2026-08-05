package designgate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

const (
	ProviderRef    = "mrbaron3/designflow@contract-v1.0.0-rc.1"
	ProviderCommit = "ce732a80a8c3867b4ac881531ce8f7546e001dbb"
	ProviderTag    = "a5598951bbc405f9d83ebbccc184c7994844715b"
	// ApprovedBundleDigest is the locally compiled trust anchor for the exact
	// human-approved contract-v1.0.0-rc.1 Design Bundle. Recomputing internally
	// consistent digests is insufficient: an attacker must not be able to
	// replace the bundle, approval, and coverage as one self-consistent set.
	ApprovedBundleDigest                  = "sha256:df3e1fd9de05cd602a626aa77faa23d930e31a86cecbb3777a76bd6bdeb9dc97"
	ApprovedDashboardBundleDigest         = "sha256:4f7357e099985d2dce5c1941b8ee25231e3208808727362b9f87d725084b70fa"
	ApprovedDashboardReconciliationDigest = "sha256:f67fed2c8de6836072cd8fb34ce53e70bf3801717989ba9c1dc25a1793d5a1db"
)

type GateResult struct {
	RequestID       string   `json:"requestId"`
	RevisionID      string   `json:"revisionId"`
	BundleDigest    string   `json:"bundleDigest"`
	DecisionID      string   `json:"decisionId"`
	CapabilityIDs   []string `json:"capabilityIds"`
	CoverageBinding int      `json:"coverageBindingCount"`
}

type reconciliationCapability struct {
	CapabilityID          string `json:"capabilityId"`
	PlannedHTTPOperations []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	} `json:"plannedHttpOperations"`
	ArchitectureElementIDs []string `json:"architectureElementIds"`
	Ownership              struct {
		Issue               string `json:"issue"`
		AcceptanceCriterion string `json:"acceptanceCriterion"`
	} `json:"ownership"`
	ReconciliationState string `json:"reconciliationState"`
}

type dashboardReconciliation struct {
	SchemaVersion string                     `json:"schemaVersion"`
	RequestID     string                     `json:"requestId"`
	RevisionID    string                     `json:"revisionId"`
	Ambiguities   []string                   `json:"ambiguities"`
	Capabilities  []reconciliationCapability `json:"capabilities"`
}

func ValidateDashboard(repositoryRoot string) (GateResult, error) {
	bundleRoot := filepath.Join(repositoryRoot, "evidence", "ciso-05", "design", "revision-02")
	manifestPath := filepath.Join(bundleRoot, "design-bundle-manifest.json")
	decisionPath := filepath.Join(
		repositoryRoot,
		"evidence",
		"ciso-05",
		"design",
		"decisions",
		"approve-r02.json",
	)
	sourcePath := filepath.Join(
		repositoryRoot,
		"evidence",
		"ciso-05",
		"design",
		"design-request.json",
	)
	reconciliationPath := filepath.Join(bundleRoot, "capability-reconciliation.json")

	var bundle manifest
	manifestRaw, err := readStrict(manifestPath, &bundle)
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard manifest: %w", err)
	}
	if err := validatePinnedSchema(
		"urn:designflow:schema:v1:design-bundle-manifest",
		manifestRaw,
	); err != nil {
		return GateResult{}, fmt.Errorf("dashboard manifest schema: %w", err)
	}
	if bundle.SchemaVersion != "1.0" ||
		bundle.RevisionID != "workflow-ciso05-dashboard-r02" ||
		bundle.BundleDigest != ApprovedDashboardBundleDigest {
		return GateResult{}, fmt.Errorf("dashboard manifest does not match the compiled approved revision")
	}
	computedBundleDigest, err := manifestDigest(manifestRaw)
	if err != nil || computedBundleDigest != bundle.BundleDigest {
		return GateResult{}, fmt.Errorf("dashboard bundleDigest mismatch")
	}
	sourceRaw, err := os.ReadFile(sourcePath)
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard Design Request: %w", err)
	}
	if err := validatePinnedSchema(
		"urn:designflow:schema:v1:design-request",
		sourceRaw,
	); err != nil {
		return GateResult{}, fmt.Errorf("dashboard Design Request schema: %w", err)
	}
	sourceDigest, err := digestArtifact(sourceRaw, "application/json")
	if err != nil || sourceDigest != bundle.SourceDigest {
		return GateResult{}, fmt.Errorf("dashboard sourceDigest mismatch")
	}
	for key, artifact := range bundle.Artifacts {
		if empty(artifact.Path, artifact.Digest, artifact.MediaType, artifact.SchemaRef) {
			return GateResult{}, fmt.Errorf("dashboard artifact %s is incomplete", key)
		}
		artifactPath, err := safeArtifactPath(repositoryRoot, artifact.Path)
		if err != nil {
			return GateResult{}, fmt.Errorf("dashboard artifact %s: %w", key, err)
		}
		body, err := os.ReadFile(artifactPath)
		if err != nil {
			return GateResult{}, fmt.Errorf("dashboard artifact %s: %w", key, err)
		}
		digest, err := digestArtifact(body, artifact.MediaType)
		if err != nil || digest != artifact.Digest {
			return GateResult{}, fmt.Errorf("dashboard artifact %s digest mismatch", key)
		}
		switch artifact.SchemaRef {
		case "urn:designflow:schema:v1:experience-contract",
			"urn:designflow:schema:v1:design-system-delta",
			"urn:designflow:schema:v1:capability-requirements":
			if err := validatePinnedSchema(artifact.SchemaRef, body); err != nil {
				return GateResult{}, fmt.Errorf("dashboard artifact %s schema: %w", key, err)
			}
		case designTokensSchemaRef:
			if err := validateDesignTokens(body); err != nil {
				return GateResult{}, fmt.Errorf("dashboard artifact %s token format: %w", key, err)
			}
		case "none":
			if artifact.MediaType != "text/html" {
				return GateResult{}, fmt.Errorf("dashboard artifact %s has no schema for non-preview media", key)
			}
		default:
			return GateResult{}, fmt.Errorf(
				"dashboard artifact %s references an unpinned schema %s",
				key,
				artifact.SchemaRef,
			)
		}
	}

	var approval decision
	approvalRaw, err := readStrict(decisionPath, &approval)
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard Human Design Decision: %w", err)
	}
	if err := validatePinnedSchema(
		"urn:designflow:schema:v1:human-design-decision",
		approvalRaw,
	); err != nil {
		return GateResult{}, fmt.Errorf("dashboard Human Design Decision schema: %w", err)
	}
	if approval.DecisionID != "workflow-ciso05-dashboard-r02-approve" ||
		approval.Verdict != "approve" ||
		approval.RequestID != bundle.RequestID ||
		approval.RevisionID != bundle.RevisionID ||
		approval.BundleDigest != bundle.BundleDigest ||
		empty(approval.Rationale, approval.DecidedAt) {
		return GateResult{}, fmt.Errorf("dashboard approval is missing or bound to a different revision")
	}

	capabilityRef, present := bundle.Artifacts["capabilityRequirements"]
	if !present {
		return GateResult{}, fmt.Errorf("dashboard bundle has no capability requirements")
	}
	capabilityPath, err := safeArtifactPath(repositoryRoot, capabilityRef.Path)
	if err != nil {
		return GateResult{}, err
	}
	var requirements capabilityDocument
	if _, err := readStrict(capabilityPath, &requirements); err != nil {
		return GateResult{}, fmt.Errorf("dashboard Capability Requirements: %w", err)
	}
	if requirements.RequestID != bundle.RequestID ||
		requirements.RevisionID != bundle.RevisionID ||
		len(requirements.Ambiguities) != 0 ||
		len(requirements.Capabilities) != 7 {
		return GateResult{}, fmt.Errorf("dashboard capability requirements are incomplete or ambiguous")
	}
	requiredCapabilities := make(map[string]bool, len(requirements.Capabilities))
	for _, item := range requirements.Capabilities {
		if err := validateCapability(item); err != nil {
			return GateResult{}, err
		}
		if requiredCapabilities[item.ID] {
			return GateResult{}, fmt.Errorf("duplicate dashboard capability %s", item.ID)
		}
		requiredCapabilities[item.ID] = true
	}

	var trace dashboardReconciliation
	reconciliationRaw, err := os.ReadFile(reconciliationPath)
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard capability reconciliation: %w", err)
	}
	if err := json.Unmarshal(reconciliationRaw, &trace); err != nil {
		return GateResult{}, fmt.Errorf("dashboard capability reconciliation: %w", err)
	}
	reconciliationDigest, err := digestArtifact(reconciliationRaw, "application/json")
	if err != nil || reconciliationDigest != ApprovedDashboardReconciliationDigest {
		return GateResult{}, fmt.Errorf("dashboard capability reconciliation does not match its compiled trust anchor")
	}
	if trace.SchemaVersion != "1.0" ||
		trace.RequestID != bundle.RequestID ||
		trace.RevisionID != bundle.RevisionID ||
		len(trace.Ambiguities) != 0 ||
		len(trace.Capabilities) != len(requiredCapabilities) {
		return GateResult{}, fmt.Errorf("dashboard capability reconciliation is incomplete or ambiguous")
	}
	openAPI, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"contracts",
		"control-api",
		"v1",
		"openapi.yaml",
	))
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard Control API contract: %w", err)
	}
	publishedOperations, err := parseOpenAPICapabilityOperations(openAPI)
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard Control API capability operations: %w", err)
	}
	system, err := os.ReadFile(filepath.Join(
		repositoryRoot,
		"docs",
		"_system",
		"registration-control",
		"architecture.md",
	))
	if err != nil {
		return GateResult{}, fmt.Errorf("dashboard system contract: %w", err)
	}
	seen := make(map[string]bool, len(trace.Capabilities))
	for _, binding := range trace.Capabilities {
		if !requiredCapabilities[binding.CapabilityID] || seen[binding.CapabilityID] {
			return GateResult{}, fmt.Errorf("dashboard capability %s is missing or duplicated", binding.CapabilityID)
		}
		seen[binding.CapabilityID] = true
		if binding.ReconciliationState != "proposed-complete" ||
			binding.Ownership.Issue != "mrbaron3/workflow#15" ||
			binding.Ownership.AcceptanceCriterion != "AC-CISO-010" ||
			len(binding.PlannedHTTPOperations) == 0 ||
			len(binding.ArchitectureElementIDs) == 0 {
			return GateResult{}, fmt.Errorf("dashboard capability %s is not completely reconciled", binding.CapabilityID)
		}
		for _, operation := range binding.PlannedHTTPOperations {
			key := strings.ToUpper(operation.Method) + " " + operation.Path
			if publishedOperations[key] != binding.CapabilityID {
				return GateResult{}, fmt.Errorf(
					"dashboard capability %s has ungrounded or mismatched API operation %s %s",
					binding.CapabilityID,
					operation.Method,
					operation.Path,
				)
			}
		}
		for _, element := range binding.ArchitectureElementIDs {
			if !strings.Contains(string(system), "**"+element+" ") {
				return GateResult{}, fmt.Errorf(
					"dashboard capability %s has ungrounded system element %s",
					binding.CapabilityID,
					element,
				)
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return GateResult{
		RequestID:       bundle.RequestID,
		RevisionID:      bundle.RevisionID,
		BundleDigest:    bundle.BundleDigest,
		DecisionID:      approval.DecisionID,
		CapabilityIDs:   ids,
		CoverageBinding: len(trace.Capabilities),
	}, nil
}

func parseOpenAPICapabilityOperations(document []byte) (map[string]string, error) {
	operations := make(map[string]string)
	currentPath := ""
	currentMethod := ""
	for lineNumber, line := range strings.Split(string(document), "\n") {
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 2 && strings.HasPrefix(trimmed, "/") &&
			strings.HasSuffix(trimmed, ":") {
			currentPath = strings.TrimSuffix(trimmed, ":")
			currentMethod = ""
			continue
		}
		if indent == 4 && currentPath != "" && strings.HasSuffix(trimmed, ":") {
			method := strings.TrimSuffix(trimmed, ":")
			switch method {
			case "get", "post", "put", "patch", "delete", "head", "options", "trace":
				currentMethod = strings.ToUpper(method)
			default:
				currentMethod = ""
			}
			continue
		}
		if indent == 6 && currentPath != "" && currentMethod != "" &&
			strings.HasPrefix(trimmed, "x-designflow-capability:") {
			capabilityID := strings.TrimSpace(strings.TrimPrefix(
				trimmed,
				"x-designflow-capability:",
			))
			if capabilityID == "" {
				return nil, fmt.Errorf("line %d has an empty capability id", lineNumber+1)
			}
			key := currentMethod + " " + currentPath
			if previous, duplicate := operations[key]; duplicate {
				return nil, fmt.Errorf(
					"operation %s declares duplicate capabilities %s and %s",
					key,
					previous,
					capabilityID,
				)
			}
			operations[key] = capabilityID
		}
	}
	return operations, nil
}

type provenance struct {
	ProviderRef  string `json:"providerRef"`
	TagObject    string `json:"tagObject"`
	Commit       string `json:"commit"`
	RetrievedAt  string `json:"retrievedAt"`
	ContractPath string `json:"contractPath"`
	Purpose      string `json:"purpose"`
}

type artifactRef struct {
	Path      string `json:"path"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
	SchemaRef string `json:"schemaRef"`
}

type manifest struct {
	SchemaVersion            string                 `json:"schemaVersion"`
	BundleID                 string                 `json:"bundleId"`
	RequestID                string                 `json:"requestId"`
	RevisionID               string                 `json:"revisionId"`
	PreviousRevisionID       *string                `json:"previousRevisionId"`
	SourceDigest             string                 `json:"sourceDigest"`
	DesignSystemBaseRevision map[string]any         `json:"designSystemBaseRevision"`
	Artifacts                map[string]artifactRef `json:"artifacts"`
	AuthorInvocationRefs     []map[string]any       `json:"authorInvocationRefs"`
	BundleDigest             string                 `json:"bundleDigest"`
	CreatedAt                string                 `json:"createdAt"`
}

type decision struct {
	SchemaVersion        string         `json:"schemaVersion"`
	DecisionID           string         `json:"decisionId"`
	RequestID            string         `json:"requestId"`
	RevisionID           string         `json:"revisionId"`
	BundleDigest         string         `json:"bundleDigest"`
	Verdict              string         `json:"verdict"`
	Rationale            string         `json:"rationale"`
	DecidedBy            map[string]any `json:"decidedBy"`
	DecidedAt            string         `json:"decidedAt"`
	SupersedesDecisionID *string        `json:"supersedesDecisionId"`
}

type failureSemantics struct {
	Condition          string `json:"condition"`
	UserVisibleOutcome string `json:"userVisibleOutcome"`
	Recoverability     string `json:"recoverability"`
}

type capability struct {
	ID                    string             `json:"id"`
	Kind                  string             `json:"kind"`
	UserIntent            string             `json:"userIntent"`
	SourceInteractionIDs  []string           `json:"sourceInteractionIds"`
	SourceRequirementIDs  []string           `json:"sourceRequirementIds"`
	InputDescription      string             `json:"inputDescription"`
	SuccessOutcome        string             `json:"successOutcome"`
	FailureSemantics      []failureSemantics `json:"failureSemantics"`
	Authorization         string             `json:"authorization"`
	LatencyExpectation    string             `json:"latencyExpectation"`
	FreshnessExpectation  string             `json:"freshnessExpectation"`
	ConcurrencySemantics  string             `json:"concurrencySemantics"`
	IdempotencySemantics  string             `json:"idempotencySemantics"`
	RetrySemantics        string             `json:"retrySemantics"`
	CancellationSemantics string             `json:"cancellationSemantics"`
	PaginationSemantics   string             `json:"paginationSemantics"`
	AuditSemantics        string             `json:"auditSemantics"`
}

type capabilityDocument struct {
	SchemaVersion string       `json:"schemaVersion"`
	RequestID     string       `json:"requestId"`
	RevisionID    string       `json:"revisionId"`
	Capabilities  []capability `json:"capabilities"`
	Ambiguities   []string     `json:"ambiguities"`
}

type coverage struct {
	SchemaVersion  string            `json:"schemaVersion"`
	ProviderRef    string            `json:"providerRef"`
	ProviderCommit string            `json:"providerCommit"`
	RequestID      string            `json:"requestId"`
	RevisionID     string            `json:"revisionId"`
	BundleDigest   string            `json:"bundleDigest"`
	Issue          string            `json:"issue"`
	Bindings       []coverageBinding `json:"bindings"`
}

type coverageBinding struct {
	CapabilityID   string              `json:"capabilityId"`
	APIElements    []string            `json:"apiElements"`
	SystemElements []string            `json:"systemElements"`
	IssueACs       []string            `json:"issueACs"`
	Facets         map[string][]string `json:"facets"`
}

var requiredFacets = []string{
	"queryCommand",
	"authorization",
	"freshness",
	"idempotency",
	"failure",
	"retryCancel",
	"audit",
}

var expectedCoverage = map[string]struct {
	api    []string
	system []string
}{
	"cap-list-registration-status": {
		api: []string{"GET /v1/registrations"},
		system: []string{
			"ARCH-registration-control-001",
			"ARCH-registration-control-002",
			"ARCH-registration-control-003",
		},
	},
	"cap-retry-delivery": {
		api: []string{
			"GET /v1/deliveries/{deliveryId}",
			"POST /v1/deliveries/{deliveryId}/retry",
		},
		system: []string{
			"ARCH-registration-control-004",
			"ARCH-registration-control-005",
			"ARCH-registration-control-006",
		},
	},
}

func Validate(bundleRoot, coveragePath string) (GateResult, error) {
	var origin provenance
	if _, err := readStrict(filepath.Join(bundleRoot, "PROVENANCE.json"), &origin); err != nil {
		return GateResult{}, fmt.Errorf("provider provenance: %w", err)
	}
	if origin.ProviderRef != ProviderRef ||
		origin.TagObject != ProviderTag ||
		origin.Commit != ProviderCommit ||
		origin.ContractPath != "contracts/v1" ||
		empty(origin.RetrievedAt, origin.Purpose) {
		return GateResult{}, fmt.Errorf("provider provenance does not match the fixed Experience Contract input")
	}
	manifestPath := filepath.Join(
		bundleRoot,
		"contracts",
		"v1",
		"examples",
		"design-bundle-manifest.example.json",
	)
	decisionPath := filepath.Join(
		bundleRoot,
		"contracts",
		"v1",
		"examples",
		"human-design-decision.example.json",
	)
	sourcePath := filepath.Join(
		bundleRoot,
		"contracts",
		"v1",
		"examples",
		"design-request.example.json",
	)
	var bundle manifest
	manifestRaw, err := readStrict(manifestPath, &bundle)
	if err != nil {
		return GateResult{}, fmt.Errorf("manifest: %w", err)
	}
	if bundle.SchemaVersion != "1.0" || empty(
		bundle.BundleID,
		bundle.RequestID,
		bundle.RevisionID,
		bundle.SourceDigest,
		bundle.BundleDigest,
	) {
		return GateResult{}, fmt.Errorf("manifest is incomplete or has an unsupported schemaVersion")
	}
	sourceRaw, err := os.ReadFile(sourcePath)
	if err != nil {
		return GateResult{}, fmt.Errorf("source Design Request: %w", err)
	}
	if digest, err := digestArtifact(sourceRaw, "application/json"); err != nil {
		return GateResult{}, err
	} else if digest != bundle.SourceDigest {
		return GateResult{}, fmt.Errorf("sourceDigest mismatch")
	}
	var source map[string]any
	if err := json.Unmarshal(sourceRaw, &source); err != nil {
		return GateResult{}, fmt.Errorf("Design Request: %w", err)
	}
	if stringField(source, "requestId") != bundle.RequestID {
		return GateResult{}, fmt.Errorf("Design Request mixes request lineage")
	}
	if len(bundle.Artifacts) == 0 {
		return GateResult{}, fmt.Errorf("bundle has no artifacts")
	}
	for key, artifact := range bundle.Artifacts {
		if empty(artifact.Path, artifact.Digest, artifact.MediaType, artifact.SchemaRef) {
			return GateResult{}, fmt.Errorf("artifact %s is incomplete", key)
		}
		path, err := safeArtifactPath(bundleRoot, artifact.Path)
		if err != nil {
			return GateResult{}, fmt.Errorf("artifact %s: %w", key, err)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return GateResult{}, fmt.Errorf("artifact %s: %w", key, err)
		}
		digest, err := digestArtifact(body, artifact.MediaType)
		if err != nil {
			return GateResult{}, fmt.Errorf("artifact %s: %w", key, err)
		}
		if digest != artifact.Digest {
			return GateResult{}, fmt.Errorf("artifact %s digest mismatch", key)
		}
	}
	for _, key := range []string{"experience", "designSystemDelta"} {
		artifact, present := bundle.Artifacts[key]
		if !present {
			return GateResult{}, fmt.Errorf("bundle has no %s artifact", key)
		}
		path, err := safeArtifactPath(bundleRoot, artifact.Path)
		if err != nil {
			return GateResult{}, err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return GateResult{}, err
		}
		var lineaged map[string]any
		if err := json.Unmarshal(body, &lineaged); err != nil {
			return GateResult{}, fmt.Errorf("artifact %s is invalid JSON: %w", key, err)
		}
		if stringField(lineaged, "requestId") != bundle.RequestID ||
			stringField(lineaged, "revisionId") != bundle.RevisionID {
			return GateResult{}, fmt.Errorf("artifact %s mixes request or revision lineage", key)
		}
		if ambiguities, present := lineaged["ambiguities"]; present {
			values, ok := ambiguities.([]any)
			if !ok || len(values) != 0 {
				return GateResult{}, fmt.Errorf("artifact %s has unresolved ambiguities", key)
			}
		}
	}
	bundleDigest, err := manifestDigest(manifestRaw)
	if err != nil {
		return GateResult{}, err
	}
	if bundleDigest != bundle.BundleDigest {
		return GateResult{}, fmt.Errorf("bundleDigest mismatch")
	}
	if bundle.BundleDigest != ApprovedBundleDigest {
		return GateResult{}, fmt.Errorf("bundleDigest does not match the exact approved trust anchor")
	}

	var approval decision
	if _, err := readStrict(decisionPath, &approval); err != nil {
		return GateResult{}, fmt.Errorf("Human Design Decision: %w", err)
	}
	if approval.SchemaVersion != "1.0" || empty(
		approval.DecisionID,
		approval.RequestID,
		approval.RevisionID,
		approval.BundleDigest,
		approval.Verdict,
		approval.Rationale,
	) {
		return GateResult{}, fmt.Errorf("Human Design Decision is incomplete")
	}
	if approval.Verdict != "approve" {
		return GateResult{}, fmt.Errorf("Design Bundle is not human-approved")
	}
	if approval.RequestID != bundle.RequestID ||
		approval.RevisionID != bundle.RevisionID ||
		approval.BundleDigest != bundle.BundleDigest {
		return GateResult{}, fmt.Errorf("Human Design Decision is bound to a different revision or digest")
	}

	capabilityRef, present := bundle.Artifacts["capabilityRequirements"]
	if !present {
		return GateResult{}, fmt.Errorf("bundle has no capabilityRequirements artifact")
	}
	capabilityPath, err := safeArtifactPath(bundleRoot, capabilityRef.Path)
	if err != nil {
		return GateResult{}, err
	}
	var requirements capabilityDocument
	if _, err := readStrict(capabilityPath, &requirements); err != nil {
		return GateResult{}, fmt.Errorf("Capability Requirements: %w", err)
	}
	if requirements.SchemaVersion != "1.0" ||
		requirements.RequestID != bundle.RequestID ||
		requirements.RevisionID != bundle.RevisionID {
		return GateResult{}, fmt.Errorf("Capability Requirements mix request or revision lineage")
	}
	if len(requirements.Ambiguities) != 0 {
		return GateResult{}, fmt.Errorf("Capability Requirements have unresolved ambiguities")
	}
	if len(requirements.Capabilities) == 0 {
		return GateResult{}, fmt.Errorf("Capability Requirements have zero capabilities")
	}
	capabilities := make(map[string]capability, len(requirements.Capabilities))
	for _, requirement := range requirements.Capabilities {
		if err := validateCapability(requirement); err != nil {
			return GateResult{}, err
		}
		if _, duplicate := capabilities[requirement.ID]; duplicate {
			return GateResult{}, fmt.Errorf("duplicate capability %s", requirement.ID)
		}
		capabilities[requirement.ID] = requirement
	}

	var trace coverage
	if _, err := readStrict(coveragePath, &trace); err != nil {
		return GateResult{}, fmt.Errorf("capability coverage: %w", err)
	}
	if trace.SchemaVersion != "1.0" ||
		trace.ProviderRef != ProviderRef ||
		trace.ProviderCommit != ProviderCommit ||
		trace.RequestID != bundle.RequestID ||
		trace.RevisionID != bundle.RevisionID ||
		trace.BundleDigest != bundle.BundleDigest ||
		trace.Issue != "mrbaron3/workflow#13" {
		return GateResult{}, fmt.Errorf("capability coverage mixes provider, request, revision, digest, or Issue lineage")
	}
	covered := make(map[string]bool, len(trace.Bindings))
	for _, binding := range trace.Bindings {
		if _, present := capabilities[binding.CapabilityID]; !present {
			return GateResult{}, fmt.Errorf("coverage has dangling capability %s", binding.CapabilityID)
		}
		if covered[binding.CapabilityID] {
			return GateResult{}, fmt.Errorf("capability %s is covered more than once", binding.CapabilityID)
		}
		if len(binding.APIElements) == 0 ||
			len(binding.SystemElements) == 0 ||
			len(binding.IssueACs) == 0 {
			return GateResult{}, fmt.Errorf("capability %s has zero coverage", binding.CapabilityID)
		}
		expected, present := expectedCoverage[binding.CapabilityID]
		if !present ||
			!equalStringSet(binding.APIElements, expected.api) ||
			!equalStringSet(binding.SystemElements, expected.system) ||
			!equalStringSet(binding.IssueACs, []string{"AC-CISO-001", "AC-CISO-002"}) {
			return GateResult{}, fmt.Errorf(
				"capability %s coverage is not grounded in the approved API/system/Issue mapping",
				binding.CapabilityID,
			)
		}
		for _, acceptance := range binding.IssueACs {
			if acceptance != "AC-CISO-001" && acceptance != "AC-CISO-002" {
				return GateResult{}, fmt.Errorf(
					"capability %s references an Issue #13 AC outside its ownership",
					binding.CapabilityID,
				)
			}
		}
		for _, facet := range requiredFacets {
			if len(binding.Facets[facet]) == 0 {
				return GateResult{}, fmt.Errorf(
					"capability %s does not trace required facet %s",
					binding.CapabilityID,
					facet,
				)
			}
		}
		for facet := range binding.Facets {
			if !contains(requiredFacets, facet) {
				return GateResult{}, fmt.Errorf(
					"capability %s has unknown coverage facet %s",
					binding.CapabilityID,
					facet,
				)
			}
		}
		covered[binding.CapabilityID] = true
	}
	if len(covered) != len(capabilities) {
		return GateResult{}, fmt.Errorf("not every Capability Requirement is covered")
	}
	ids := make([]string, 0, len(requirements.Capabilities))
	for _, requirement := range requirements.Capabilities {
		ids = append(ids, requirement.ID)
	}
	return GateResult{
		RequestID:       bundle.RequestID,
		RevisionID:      bundle.RevisionID,
		BundleDigest:    bundle.BundleDigest,
		DecisionID:      approval.DecisionID,
		CapabilityIDs:   ids,
		CoverageBinding: len(trace.Bindings),
	}, nil
}

func validateCapability(requirement capability) error {
	if requirement.Kind != "query" && requirement.Kind != "command" && requirement.Kind != "event" {
		return fmt.Errorf("capability %s has an unknown kind", requirement.ID)
	}
	if empty(
		requirement.ID,
		requirement.UserIntent,
		requirement.InputDescription,
		requirement.SuccessOutcome,
		requirement.Authorization,
		requirement.LatencyExpectation,
		requirement.FreshnessExpectation,
		requirement.ConcurrencySemantics,
		requirement.IdempotencySemantics,
		requirement.RetrySemantics,
		requirement.CancellationSemantics,
		requirement.PaginationSemantics,
		requirement.AuditSemantics,
	) || len(requirement.SourceInteractionIDs) == 0 ||
		len(requirement.SourceRequirementIDs) == 0 ||
		len(requirement.FailureSemantics) == 0 {
		return fmt.Errorf("capability %s is incomplete", requirement.ID)
	}
	for _, failure := range requirement.FailureSemantics {
		if empty(failure.Condition, failure.UserVisibleOutcome, failure.Recoverability) {
			return fmt.Errorf("capability %s has incomplete failure semantics", requirement.ID)
		}
	}
	return nil
}

func readStrict(path string, destination any) ([]byte, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("multiple JSON values")
	}
	return body, nil
}

func safeArtifactPath(root, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("absolute artifact path is forbidden")
	}
	clean := filepath.Clean(relative)
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", fmt.Errorf("artifact path escapes the bundle root")
	}
	path := filepath.Join(root, clean)
	relativePath, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(relativePath, "..") {
		return "", fmt.Errorf("artifact path escapes the bundle root")
	}
	return path, nil
}

func digestArtifact(body []byte, mediaType string) (string, error) {
	parsed, _, err := mime.ParseMediaType(mediaType)
	if err != nil {
		return "", fmt.Errorf("invalid artifact mediaType: %w", err)
	}
	value := body
	if parsed == "application/json" || strings.HasSuffix(parsed, "+json") {
		value, err = jsoncanonicalizer.Transform(body)
		if err != nil {
			return "", fmt.Errorf("RFC 8785 canonicalization failed: %w", err)
		}
	}
	digest := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func manifestDigest(body []byte) (string, error) {
	var value map[string]any
	if err := json.Unmarshal(body, &value); err != nil {
		return "", err
	}
	delete(value, "bundleDigest")
	withoutDigest, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return digestArtifact(withoutDigest, "application/json")
}

func empty(values ...string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return true
		}
	}
	return false
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func equalStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	counts := make(map[string]int, len(left))
	for _, value := range left {
		counts[value]++
	}
	for _, value := range right {
		if counts[value] == 0 {
			return false
		}
		counts[value]--
	}
	return true
}

func stringField(value map[string]any, name string) string {
	field, _ := value[name].(string)
	return field
}
