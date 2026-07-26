package control

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type monitorBrokerResponse struct {
	Items      []monitorBrokerItem `json:"items"`
	NextCursor struct {
		UpdatedAfter string `json:"updatedAfter"`
	} `json:"nextCursor"`
	ObservedAt time.Time `json:"observedAt"`
}

type monitorBrokerItem struct {
	Repository string    `json:"repository"`
	Kind       string    `json:"kind"`
	Number     int64     `json:"number"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// BrokeredGitHubSource is a typed PostgreSQL request/response boundary. It
// exposes no URL or arbitrary method: only issue and pull_request monitor reads
// for one configured repository can cross from credential-free control to the
// credential-bearing runner.
type BrokeredGitHubSource struct {
	Store             *Store
	AllowedRepository string
	Timeout           time.Duration
}

func (source BrokeredGitHubSource) Poll(
	ctx context.Context,
	registration Registration,
	kind string,
	cursor map[string]any,
) ([]WorkItem, map[string]any, time.Time, error) {
	allowed := strings.ToLower(strings.TrimSpace(source.AllowedRepository))
	if registration.Repository != allowed {
		return nil, nil, time.Time{}, fmt.Errorf(
			"monitor broker repository is outside the configured allowlist",
		)
	}
	if kind != "issue" && kind != "pull_request" {
		return nil, nil, time.Time{}, fmt.Errorf("monitor broker kind is not allowed")
	}
	updatedAfter := ""
	if len(cursor) != 0 {
		value, present := cursor["updatedAfter"]
		if !present || len(cursor) != 1 {
			return nil, nil, time.Time{}, fmt.Errorf("monitor broker cursor shape is invalid")
		}
		var ok bool
		updatedAfter, ok = value.(string)
		if !ok {
			return nil, nil, time.Time{}, fmt.Errorf("monitor broker cursor is not a string")
		}
		if updatedAfter != "" {
			if _, err := time.Parse(time.RFC3339Nano, updatedAfter); err != nil {
				return nil, nil, time.Time{}, fmt.Errorf("monitor broker cursor timestamp is invalid")
			}
		}
	}
	requestContext := ctx
	cancel := func() {}
	timeout := source.Timeout
	if timeout <= 0 || timeout > 30*time.Second {
		timeout = 25 * time.Second
	}
	requestContext, cancel = context.WithTimeout(ctx, timeout)
	defer cancel()
	response, err := source.Store.monitorBrokerPoll(
		requestContext,
		registration,
		kind,
		map[string]any{"updatedAfter": updatedAfter},
	)
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	items := make([]WorkItem, 0, len(response.Items))
	for _, item := range response.Items {
		if item.Repository != registration.Repository ||
			item.Kind != kind ||
			item.Number < 1 ||
			item.UpdatedAt.IsZero() {
			return nil, nil, time.Time{}, fmt.Errorf(
				"monitor broker response escaped its typed request",
			)
		}
		items = append(items, WorkItem{
			Repository: item.Repository,
			Kind:       item.Kind,
			Number:     item.Number,
			UpdatedAt:  item.UpdatedAt.UTC(),
		})
	}
	return items,
		map[string]any{"updatedAfter": response.NextCursor.UpdatedAfter},
		response.ObservedAt.UTC(),
		nil
}

func (store *Store) monitorBrokerPoll(
	ctx context.Context,
	registration Registration,
	kind string,
	cursor map[string]any,
) (monitorBrokerResponse, error) {
	cursorJSON, err := json.Marshal(cursor)
	if err != nil {
		return monitorBrokerResponse{}, err
	}
	cursorDigest := sha256.Sum256(cursorJSON)
	requestID := ""
	for attempt := 0; attempt < 3 && requestID == ""; attempt++ {
		candidate, idErr := randomUUID()
		if idErr != nil {
			return monitorBrokerResponse{}, idErr
		}
		err = store.pool.QueryRow(ctx,
			`INSERT INTO agentops_control.monitor_broker_requests(
			   id, registration_id, registration_version, repository,
			   monitor_kind, cursor, cursor_sha256
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT DO NOTHING
			 RETURNING id`,
			candidate,
			registration.ID,
			registration.Version,
			registration.Repository,
			kind,
			cursor,
			hex.EncodeToString(cursorDigest[:]),
		).Scan(&requestID)
		inserted := err == nil
		if errors.Is(err, pgx.ErrNoRows) {
			err = store.pool.QueryRow(ctx,
				`SELECT id
				   FROM agentops_control.monitor_broker_requests
				  WHERE registration_id = $1
				    AND registration_version = $2
				    AND monitor_kind = $3
				    AND cursor_sha256 = $4
				    AND status IN ('pending', 'leased')
				  ORDER BY created_at
				  LIMIT 1`,
				registration.ID,
				registration.Version,
				kind,
				hex.EncodeToString(cursorDigest[:]),
			).Scan(&requestID)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			requestID = ""
			continue
		}
		if err != nil {
			return monitorBrokerResponse{}, unavailable(err)
		}
		if inserted {
			registrationID := registration.ID
			if err := store.AppendAudit(
				ctx,
				"monitor-broker",
				"monitor.broker.requested",
				&registrationID,
				nil,
				map[string]any{
					"requestId":           requestID,
					"registrationVersion": registration.Version,
					"repository":          registration.Repository,
					"monitorKind":         kind,
				},
			); err != nil {
				return monitorBrokerResponse{}, err
			}
		}
	}
	if requestID == "" {
		return monitorBrokerResponse{}, fmt.Errorf("monitor broker request dedup race did not converge")
	}

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		var status string
		var responseJSON []byte
		var errorCode, errorMessage *string
		err := store.pool.QueryRow(ctx,
			`SELECT status, response, error_code, error_message
			   FROM agentops_control.monitor_broker_requests
			  WHERE id = $1`,
			requestID,
		).Scan(&status, &responseJSON, &errorCode, &errorMessage)
		if err != nil {
			return monitorBrokerResponse{}, unavailable(err)
		}
		switch status {
		case "succeeded":
			if len(responseJSON) == 0 || len(responseJSON) > 256*1024 {
				return monitorBrokerResponse{}, fmt.Errorf(
					"monitor broker response is empty or exceeds 256KiB",
				)
			}
			var response monitorBrokerResponse
			decoder := json.NewDecoder(bytes.NewReader(responseJSON))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&response); err != nil {
				return monitorBrokerResponse{}, fmt.Errorf(
					"monitor broker response schema is invalid",
				)
			}
			if len(response.Items) > 1_000 ||
				response.ObservedAt.IsZero() ||
				(response.NextCursor.UpdatedAfter != "" &&
					!validBrokerTimestamp(response.NextCursor.UpdatedAfter)) {
				return monitorBrokerResponse{}, fmt.Errorf(
					"monitor broker response limits are invalid",
				)
			}
			return response, nil
		case "failed":
			code := "unknown"
			if errorCode != nil && *errorCode != "" {
				code = *errorCode
			}
			// The runner persists only a bounded sanitized message. Never expose
			// a provider response body or credential-bearing request.
			message := "typed monitor request failed"
			if errorMessage != nil && *errorMessage != "" {
				message = *errorMessage
			}
			return monitorBrokerResponse{}, fmt.Errorf(
				"monitor broker %s: %s",
				code,
				message,
			)
		case "pending", "leased":
		default:
			return monitorBrokerResponse{}, fmt.Errorf("monitor broker status is invalid")
		}
		select {
		case <-ctx.Done():
			return monitorBrokerResponse{}, fmt.Errorf("monitor broker timed out: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func validBrokerTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}
