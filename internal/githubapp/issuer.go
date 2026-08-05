package githubapp

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mrbaron3/servo/internal/control"
)

const (
	// One mint issues mintGitHubCalls sequential GitHub requests, so a broker
	// response can take up to mintGitHubCalls*defaultRequestTimeout. That budget
	// must stay inside brokerWriteTimeout or the broker would abandon a response
	// it is still legitimately producing; TestTimeoutBudgetFitsWriteDeadline
	// keeps the two in step.
	defaultRequestTimeout = 8 * time.Second
	mintGitHubCalls       = 2
	maxGitHubBodyBytes    = 2 * 1024 * 1024
	refreshBeforeExpiry   = 10 * time.Minute
	maxCacheAge           = 15 * time.Minute
)

type Policy struct {
	Role        Role
	Permissions map[string]string
}

type IssuerConfig struct {
	AppID          int64
	InstallationID int64
	AppSlug        string
	Owner          string
	APIBaseURL     string
	PrivateKey     *rsa.PrivateKey
	Policies       []Policy
}

type cachedToken struct {
	response  TokenResponse
	refreshAt time.Time
}

// roleState serializes minting for one role. A single issuer-wide lock would
// hold every other role behind one slow installation call — including roles
// that would have been served from cache — so each role owns its own mutex.
type roleState struct {
	mu     sync.Mutex
	cached cachedToken
	valid  bool
}

type Issuer struct {
	appID          int64
	installationID int64
	appSlug        string
	owner          string
	baseURL        *url.URL
	privateKey     *rsa.PrivateKey
	policies       map[Role]Policy
	client         *http.Client
	now            func() time.Time

	// policies and states are fixed by NewIssuer and never mutated afterwards,
	// so both are safe to read concurrently without a lock.
	statesMu sync.Mutex
	states   map[string]*roleState
}

func NewIssuer(
	config IssuerConfig,
	client *http.Client,
	now func() time.Time,
) (*Issuer, error) {
	if config.AppID <= 0 || config.InstallationID <= 0 ||
		config.PrivateKey == nil {
		return nil, fmt.Errorf("GitHub App issuer identity is incomplete")
	}
	if !ValidAppSlug(config.AppSlug) || !safeOwner(config.Owner) {
		return nil, fmt.Errorf("GitHub App slug or owner is invalid")
	}
	rawBase := strings.TrimSpace(config.APIBaseURL)
	if rawBase == "" {
		rawBase = "https://api.github.com"
	}
	baseURL, err := url.Parse(rawBase)
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" ||
		baseURL.User != nil || baseURL.RawQuery != "" ||
		baseURL.Fragment != "" {
		return nil, fmt.Errorf("GitHub API base URL is invalid")
	}
	policies := make(map[Role]Policy, len(config.Policies))
	for _, policy := range config.Policies {
		normalized, err := normalizePolicy(policy)
		if err != nil {
			return nil, err
		}
		if _, duplicate := policies[normalized.Role]; duplicate {
			return nil, fmt.Errorf("GitHub App role policy is duplicated")
		}
		policies[normalized.Role] = normalized
	}
	if len(policies) == 0 {
		return nil, fmt.Errorf("GitHub App issuer requires at least one role policy")
	}
	if client == nil {
		client = &http.Client{
			Timeout: defaultRequestTimeout,
			CheckRedirect: func(
				_ *http.Request,
				_ []*http.Request,
			) error {
				return http.ErrUseLastResponse
			},
		}
	}
	if now == nil {
		now = time.Now
	}
	return &Issuer{
		appID:          config.AppID,
		installationID: config.InstallationID,
		appSlug:        config.AppSlug,
		owner:          config.Owner,
		baseURL:        baseURL,
		privateKey:     config.PrivateKey,
		policies:       policies,
		client:         client,
		now:            now,
		states:         make(map[string]*roleState),
	}, nil
}

func (issuer *Issuer) Roles() []Role {
	roles := make([]Role, 0, len(issuer.policies))
	for role := range issuer.policies {
		roles = append(roles, role)
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i] < roles[j] })
	return roles
}

func (issuer *Issuer) Warm(ctx context.Context) error {
	// Startup proves that the configured App and installation are still the
	// expected principals and that the installation contains every permission
	// a role may request. Do not mint role credentials here: broker restarts are
	// lifecycle operations, not credential use, and eagerly creating one token
	// per role can trip GitHub's endpoint-abuse protection during recovery.
	// Token performs the remaining exact issued-permission and repository-scope
	// checks before any credential is returned to a caller, so this stays
	// fail-closed without turning every restart into a token rotation.
	return issuer.verifyIdentity(ctx)
}

func (issuer *Issuer) Token(
	ctx context.Context,
	role Role,
	repository string,
) (TokenResponse, error) {
	policy, present := issuer.policies[role]
	if !present {
		return TokenResponse{}, fmt.Errorf("GitHub App role is not configured")
	}
	repository = strings.TrimSpace(repository)
	if repository != strings.ToLower(repository) ||
		!control.ValidRepositoryIdentity(repository) ||
		!strings.HasPrefix(repository, issuer.owner+"/") {
		return TokenResponse{}, fmt.Errorf("GitHub App repository is outside the installation owner")
	}
	state := issuer.stateFor(role, repository)
	state.mu.Lock()
	defer state.mu.Unlock()
	now := issuer.now().UTC()
	if state.valid && now.Before(state.cached.refreshAt) {
		return cloneTokenResponse(state.cached.response), nil
	}
	response, err := issuer.mint(ctx, policy, repository, now)
	if err != nil {
		return TokenResponse{}, err
	}
	refreshAt := response.ExpiresAt.Add(-refreshBeforeExpiry)
	maximum := now.Add(maxCacheAge)
	if refreshAt.After(maximum) {
		refreshAt = maximum
	}
	state.cached = cachedToken{
		response:  cloneTokenResponse(response),
		refreshAt: refreshAt,
	}
	state.valid = true
	return cloneTokenResponse(response), nil
}

func (issuer *Issuer) ActorLogin() string {
	return issuer.appSlug + "[bot]"
}

func (issuer *Issuer) stateFor(role Role, repository string) *roleState {
	key := string(role) + "\x00" + repository
	issuer.statesMu.Lock()
	defer issuer.statesMu.Unlock()
	state := issuer.states[key]
	if state == nil {
		state = &roleState{}
		issuer.states[key] = state
	}
	return state
}

func (issuer *Issuer) verifyIdentity(ctx context.Context) error {
	jwt, err := SignAppJWT(issuer.privateKey, issuer.appID, issuer.now().UTC())
	if err != nil {
		return err
	}
	var app struct {
		ID   int64  `json:"id"`
		Slug string `json:"slug"`
	}
	if err := issuer.githubJSON(
		ctx,
		http.MethodGet,
		"/app",
		jwt,
		nil,
		&app,
	); err != nil {
		return fmt.Errorf("verify GitHub App identity: %w", err)
	}
	if app.ID != issuer.appID || app.Slug != issuer.appSlug {
		return fmt.Errorf("GitHub App identity does not match configuration")
	}
	var installation struct {
		ID      int64 `json:"id"`
		AppID   int64 `json:"app_id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
		Permissions map[string]string `json:"permissions"`
	}
	if err := issuer.githubJSON(
		ctx,
		http.MethodGet,
		fmt.Sprintf("/app/installations/%d", issuer.installationID),
		jwt,
		nil,
		&installation,
	); err != nil {
		return fmt.Errorf("verify GitHub App installation: %w", err)
	}
	if installation.ID != issuer.installationID ||
		installation.AppID != issuer.appID ||
		!strings.EqualFold(installation.Account.Login, issuer.owner) {
		return fmt.Errorf("GitHub App installation identity does not match")
	}
	for _, policy := range issuer.policies {
		for permission, required := range policy.Permissions {
			if !permissionContains(installation.Permissions[permission], required) {
				return fmt.Errorf(
					"GitHub App installation permission %s is insufficient",
					permission,
				)
			}
		}
	}
	return nil
}

func (issuer *Issuer) mint(
	ctx context.Context,
	policy Policy,
	repository string,
	now time.Time,
) (TokenResponse, error) {
	jwt, err := SignAppJWT(issuer.privateKey, issuer.appID, now)
	if err != nil {
		return TokenResponse{}, err
	}
	_, name, _ := strings.Cut(repository, "/")
	request := struct {
		Repositories []string          `json:"repositories"`
		Permissions  map[string]string `json:"permissions"`
	}{
		Repositories: []string{name},
		Permissions:  policy.Permissions,
	}
	var issued struct {
		Token               string            `json:"token"`
		ExpiresAt           time.Time         `json:"expires_at"`
		Permissions         map[string]string `json:"permissions"`
		RepositorySelection string            `json:"repository_selection"`
	}
	if err := issuer.githubJSON(
		ctx,
		http.MethodPost,
		fmt.Sprintf(
			"/app/installations/%d/access_tokens",
			issuer.installationID,
		),
		jwt,
		request,
		&issued,
	); err != nil {
		return TokenResponse{}, fmt.Errorf(
			"issue GitHub App installation credential: %w",
			err,
		)
	}
	if len(strings.TrimSpace(issued.Token)) < 20 ||
		!issued.ExpiresAt.After(now.Add(20*time.Minute)) ||
		issued.ExpiresAt.After(now.Add(2*time.Hour)) {
		return TokenResponse{}, fmt.Errorf(
			"GitHub App installation credential response is invalid",
		)
	}
	if err := exactIssuedPermissions(issued.Permissions, policy.Permissions); err != nil {
		return TokenResponse{}, err
	}
	if err := issuer.verifyRepositories(
		ctx,
		issued.Token,
		[]string{repository},
	); err != nil {
		return TokenResponse{}, err
	}
	return TokenResponse{
		SchemaVersion: SchemaVersion,
		Role:          policy.Role,
		Token:         issued.Token,
		ExpiresAt:     issued.ExpiresAt.UTC(),
		Repositories:  []string{repository},
		Permissions:   cloneMap(policy.Permissions),
		ActorLogin:    issuer.ActorLogin(),
	}, nil
}

func (issuer *Issuer) verifyRepositories(
	ctx context.Context,
	token string,
	expected []string,
) error {
	var response struct {
		TotalCount   int `json:"total_count"`
		Repositories []struct {
			FullName string `json:"full_name"`
		} `json:"repositories"`
	}
	if err := issuer.githubJSON(
		ctx,
		http.MethodGet,
		"/installation/repositories?per_page=100",
		token,
		nil,
		&response,
	); err != nil {
		return fmt.Errorf("verify installation credential repositories: %w", err)
	}
	actual := make([]string, 0, len(response.Repositories))
	for _, repository := range response.Repositories {
		actual = append(actual, strings.ToLower(repository.FullName))
	}
	sort.Strings(actual)
	wanted := append([]string(nil), expected...)
	sort.Strings(wanted)
	if response.TotalCount != len(wanted) ||
		strings.Join(actual, "\x00") != strings.Join(wanted, "\x00") {
		return fmt.Errorf("GitHub App installation credential repository scope drifted")
	}
	return nil
}

func (issuer *Issuer) githubJSON(
	ctx context.Context,
	method, path, bearer string,
	input any,
	output any,
) error {
	endpoint := issuer.baseURL.ResolveReference(&url.URL{Path: path})
	if strings.Contains(path, "?") {
		parsed, err := url.Parse(path)
		if err != nil {
			return err
		}
		endpoint = issuer.baseURL.ResolveReference(parsed)
	}
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("Authorization", "Bearer "+bearer)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := issuer.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxGitHubBodyBytes))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode GitHub API response: %w", err)
	}
	return nil
}

func normalizePolicy(policy Policy) (Policy, error) {
	if !policy.Role.Valid() ||
		len(policy.Permissions) < 1 || len(policy.Permissions) > 16 {
		return Policy{}, fmt.Errorf("GitHub App role policy is invalid")
	}
	permissions := make(map[string]string, len(policy.Permissions))
	for name, level := range policy.Permissions {
		if !safePermissionName(name) ||
			(level != "read" && level != "write") {
			return Policy{}, fmt.Errorf("GitHub App role permission is invalid")
		}
		permissions[name] = level
	}
	return Policy{
		Role:        policy.Role,
		Permissions: permissions,
	}, nil
}

func exactIssuedPermissions(
	issued, requested map[string]string,
) error {
	for name, level := range requested {
		if issued[name] != level {
			return fmt.Errorf("GitHub App credential permission %s drifted", name)
		}
	}
	for name, level := range issued {
		if name == "metadata" && level == "read" {
			continue
		}
		if expected, present := requested[name]; !present || expected != level {
			return fmt.Errorf("GitHub App credential gained unexpected permission")
		}
	}
	return nil
}

func permissionContains(actual, required string) bool {
	if required == "read" {
		return actual == "read" || actual == "write"
	}
	return required == "write" && actual == "write"
}

func safePermissionName(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || character == '_' {
			continue
		}
		return false
	}
	return true
}

// ValidAppSlug reports whether value is a canonical GitHub App slug. The issuer
// and the lifecycle manager both gate on it so a slug that starts the broker
// cannot be one the manager would have rejected, or the reverse.
func ValidAppSlug(value string) bool {
	if value == "" || len(value) > 100 ||
		value != strings.ToLower(value) ||
		strings.HasPrefix(value, "-") || strings.HasSuffix(value, "-") {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			character == '-' {
			continue
		}
		return false
	}
	return true
}

func safeOwner(value string) bool {
	return control.ValidRepositoryIdentity(value + "/repository")
}

func cloneMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneTokenResponse(source TokenResponse) TokenResponse {
	source.Repositories = append([]string(nil), source.Repositories...)
	source.Permissions = cloneMap(source.Permissions)
	return source
}
