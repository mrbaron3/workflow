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

	"github.com/mrbaron3/workflow/internal/control"
)

const (
	defaultRequestTimeout = 30 * time.Second
	maxGitHubBodyBytes    = 2 * 1024 * 1024
	refreshBeforeExpiry   = 10 * time.Minute
	maxCacheAge           = 15 * time.Minute
)

type Policy struct {
	Role         Role
	Repositories []string
	Permissions  map[string]string
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

	mu    sync.Mutex
	cache map[Role]cachedToken
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
	if !safeSlug(config.AppSlug) || !safeOwner(config.Owner) {
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
		normalized, err := normalizePolicy(policy, config.Owner)
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
		cache:          make(map[Role]cachedToken),
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
	if err := issuer.verifyIdentity(ctx); err != nil {
		return err
	}
	for _, role := range issuer.Roles() {
		if _, err := issuer.Token(ctx, role); err != nil {
			return err
		}
	}
	return nil
}

func (issuer *Issuer) Token(
	ctx context.Context,
	role Role,
) (TokenResponse, error) {
	issuer.mu.Lock()
	defer issuer.mu.Unlock()
	policy, present := issuer.policies[role]
	if !present {
		return TokenResponse{}, fmt.Errorf("GitHub App role is not configured")
	}
	now := issuer.now().UTC()
	if cached, ok := issuer.cache[role]; ok && now.Before(cached.refreshAt) {
		return cloneTokenResponse(cached.response), nil
	}
	response, err := issuer.mint(ctx, policy, now)
	if err != nil {
		return TokenResponse{}, err
	}
	refreshAt := response.ExpiresAt.Add(-refreshBeforeExpiry)
	maximum := now.Add(maxCacheAge)
	if refreshAt.After(maximum) {
		refreshAt = maximum
	}
	issuer.cache[role] = cachedToken{
		response:  cloneTokenResponse(response),
		refreshAt: refreshAt,
	}
	return cloneTokenResponse(response), nil
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
	now time.Time,
) (TokenResponse, error) {
	jwt, err := SignAppJWT(issuer.privateKey, issuer.appID, now)
	if err != nil {
		return TokenResponse{}, err
	}
	names := make([]string, 0, len(policy.Repositories))
	for _, repository := range policy.Repositories {
		_, name, _ := strings.Cut(repository, "/")
		names = append(names, name)
	}
	request := struct {
		Repositories []string          `json:"repositories"`
		Permissions  map[string]string `json:"permissions"`
	}{
		Repositories: names,
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
		policy.Repositories,
	); err != nil {
		return TokenResponse{}, err
	}
	return TokenResponse{
		SchemaVersion: SchemaVersion,
		Role:          policy.Role,
		Token:         issued.Token,
		ExpiresAt:     issued.ExpiresAt.UTC(),
		Repositories:  append([]string(nil), policy.Repositories...),
		Permissions:   cloneMap(policy.Permissions),
		ActorLogin:    issuer.appSlug + "[bot]",
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

func normalizePolicy(policy Policy, owner string) (Policy, error) {
	if !policy.Role.Valid() ||
		len(policy.Repositories) < 1 || len(policy.Repositories) > 64 ||
		len(policy.Permissions) < 1 || len(policy.Permissions) > 16 {
		return Policy{}, fmt.Errorf("GitHub App role policy is invalid")
	}
	repositories := make([]string, 0, len(policy.Repositories))
	seen := make(map[string]struct{}, len(policy.Repositories))
	for _, repository := range policy.Repositories {
		if repository != strings.ToLower(strings.TrimSpace(repository)) ||
			!control.ValidRepositoryIdentity(repository) ||
			!strings.HasPrefix(repository, owner+"/") {
			return Policy{}, fmt.Errorf(
				"GitHub App role repository is outside the installation owner",
			)
		}
		if _, duplicate := seen[repository]; duplicate {
			return Policy{}, fmt.Errorf("GitHub App role repository is duplicated")
		}
		seen[repository] = struct{}{}
		repositories = append(repositories, repository)
	}
	sort.Strings(repositories)
	permissions := make(map[string]string, len(policy.Permissions))
	for name, level := range policy.Permissions {
		if !safePermissionName(name) ||
			(level != "read" && level != "write") {
			return Policy{}, fmt.Errorf("GitHub App role permission is invalid")
		}
		permissions[name] = level
	}
	return Policy{
		Role:         policy.Role,
		Repositories: repositories,
		Permissions:  permissions,
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

func safeSlug(value string) bool {
	if value == "" || len(value) > 100 ||
		value != strings.ToLower(value) {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && character == '-') {
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
