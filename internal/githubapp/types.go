package githubapp

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

const SchemaVersion = 1

type Role string

const (
	RoleTriage Role = "triage"
	RoleRunner Role = "runner"
)

func (role Role) Valid() bool {
	return role == RoleTriage || role == RoleRunner
}

type TokenRequest struct {
	SchemaVersion int  `json:"schemaVersion"`
	Role          Role `json:"role"`
}

type TokenResponse struct {
	SchemaVersion int               `json:"schemaVersion"`
	Role          Role              `json:"role"`
	Token         string            `json:"token"`
	ExpiresAt     time.Time         `json:"expiresAt"`
	Repositories  []string          `json:"repositories"`
	Permissions   map[string]string `json:"permissions"`
	ActorLogin    string            `json:"actorLogin"`
}

func DecodeStrict[T any](reader io.Reader, limit int64) (T, error) {
	var result T
	decoder := json.NewDecoder(io.LimitReader(reader, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return result, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return result, fmt.Errorf("unexpected trailing JSON")
		}
		return result, err
	}
	return result, nil
}

func ValidateTokenResponse(
	response TokenResponse,
	expectedRole Role,
	now time.Time,
) error {
	if response.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported credential response schema")
	}
	if response.Role != expectedRole || !response.Role.Valid() {
		return fmt.Errorf("credential response role mismatch")
	}
	if len(strings.TrimSpace(response.Token)) < 20 ||
		len(response.Token) > 4096 {
		return fmt.Errorf("credential response token is invalid")
	}
	if !response.ExpiresAt.After(now.Add(5*time.Minute)) ||
		response.ExpiresAt.After(now.Add(2*time.Hour)) {
		return fmt.Errorf("credential response expiry is invalid")
	}
	if len(response.Repositories) == 0 || len(response.Repositories) > 64 {
		return fmt.Errorf("credential response repository set is invalid")
	}
	if len(response.Permissions) == 0 || len(response.Permissions) > 16 {
		return fmt.Errorf("credential response permission set is invalid")
	}
	if response.ActorLogin == "" || len(response.ActorLogin) > 128 {
		return fmt.Errorf("credential response actor is invalid")
	}
	return nil
}
