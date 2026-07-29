package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type BrokerClient struct {
	BaseURL    string
	Capability string
	Role       Role
	HTTPClient *http.Client
	Now        func() time.Time
}

func (client BrokerClient) Token(ctx context.Context) (TokenResponse, error) {
	base, err := validateBrokerURL(client.BaseURL)
	if err != nil {
		return TokenResponse{}, err
	}
	if len(strings.TrimSpace(client.Capability)) < 32 ||
		!client.Role.Valid() {
		return TokenResponse{}, fmt.Errorf("broker client capability is invalid")
	}
	body, err := json.Marshal(TokenRequest{
		SchemaVersion: SchemaVersion,
		Role:          client.Role,
	})
	if err != nil {
		return TokenResponse{}, err
	}
	endpoint := base.ResolveReference(&url.URL{Path: "/v1/github-token"})
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint.String(),
		bytes.NewReader(body),
	)
	if err != nil {
		return TokenResponse{}, err
	}
	request.Header.Set("Authorization", "Bearer "+client.Capability)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = brokerHTTPClient(10 * time.Second)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return TokenResponse{}, fmt.Errorf("GitHub credential broker request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return TokenResponse{}, fmt.Errorf(
			"GitHub credential broker returned HTTP %d",
			response.StatusCode,
		)
	}
	result, err := DecodeStrict[TokenResponse](response.Body, 16*1024)
	if err != nil {
		return TokenResponse{}, fmt.Errorf(
			"GitHub credential broker returned an invalid response",
		)
	}
	now := time.Now().UTC()
	if client.Now != nil {
		now = client.Now().UTC()
	}
	if err := ValidateTokenResponse(result, client.Role, now); err != nil {
		return TokenResponse{}, err
	}
	return result, nil
}

func (client BrokerClient) Health(ctx context.Context) error {
	base, err := validateBrokerURL(client.BaseURL)
	if err != nil {
		return err
	}
	endpoint := base.ResolveReference(&url.URL{Path: "/healthz"})
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		endpoint.String(),
		nil,
	)
	if err != nil {
		return err
	}
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = brokerHTTPClient(5 * time.Second)
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("GitHub credential broker health request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 16*1024))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf(
			"GitHub credential broker health returned HTTP %d",
			response.StatusCode,
		)
	}
	return nil
}

func brokerHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(
			_ *http.Request,
			_ []*http.Request,
		) error {
			return http.ErrUseLastResponse
		},
	}
}

func validateBrokerURL(raw string) (*url.URL, error) {
	value, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || value.Scheme != "http" || value.Hostname() == "" ||
		value.User != nil || value.RawQuery != "" || value.Fragment != "" ||
		(value.Path != "" && value.Path != "/") {
		return nil, fmt.Errorf("GitHub credential broker URL is invalid")
	}
	if value.Port() == "" {
		return nil, fmt.Errorf("GitHub credential broker URL requires an explicit port")
	}
	return value, nil
}
