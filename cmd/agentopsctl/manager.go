package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

type manager struct {
	config  config
	runtime *lifecycle.AppleRuntime
}

type mutationReceipt struct {
	Mutated bool
}

func newManager(config config, runtime *lifecycle.AppleRuntime) *manager {
	return &manager{config: config, runtime: runtime}
}

func (manager *manager) Start(
	ctx context.Context,
	mode lifecycle.Mode,
	build bool,
	requestID string,
) (resultErr error) {
	if err := manager.config.validateStart(mode); err != nil {
		return err
	}
	if err := manager.ensureRuntime(ctx); err != nil {
		return err
	}
	if build || !manager.runtime.ImageExists(ctx, manager.config.PostgresImage) {
		if err := manager.runtime.BuildImage(
			ctx,
			manager.config.PostgresImage,
			"postgres",
			filepath.Join(manager.config.ProjectRoot, "deploy", "Containerfile"),
			manager.config.ProjectRoot,
		); err != nil {
			return err
		}
	}
	if build || !manager.runtime.ImageExists(ctx, manager.config.ControlImage) {
		if err := manager.runtime.BuildImage(
			ctx,
			manager.config.ControlImage,
			"control",
			filepath.Join(manager.config.ProjectRoot, "deploy", "Containerfile"),
			manager.config.ProjectRoot,
		); err != nil {
			return err
		}
	}
	if build || !manager.runtime.ImageExists(ctx, manager.config.RunnerImage) {
		if err := manager.runtime.BuildImage(
			ctx,
			manager.config.RunnerImage,
			"runner",
			filepath.Join(manager.config.ProjectRoot, "deploy", "Containerfile"),
			manager.config.ProjectRoot,
		); err != nil {
			return err
		}
	}
	if err := manager.runtime.EnsureNetwork(ctx, manager.config.Network); err != nil {
		return err
	}
	if err := manager.runtime.EnsureVolume(ctx, manager.config.PostgresVolume); err != nil {
		return err
	}
	if err := manager.runtime.EnsureVolume(ctx, manager.config.RunnerVolume); err != nil {
		return err
	}
	if manager.config.usesCodexAuthFileFor(mode) {
		if err := manager.runtime.EnsureVolume(
			ctx,
			manager.config.CredentialVolume,
		); err != nil {
			return err
		}
	}
	postgresStarted := false
	controlChanged := false
	runnerChanged := false
	var initialMode *lifecycle.Mode
	defer func() {
		if resultErr != nil {
			_ = manager.recordFailure(
				context.Background(),
				"start",
				resultErr.Error(),
				false,
			)
			_ = manager.compensateStart(
				context.Background(),
				postgresStarted,
				controlChanged,
				runnerChanged,
				initialMode,
				requestID,
			)
		}
	}()
	started, err := manager.ensurePostgres(ctx)
	if err != nil {
		return err
	}
	postgresStarted = started
	if err := manager.migrateAndBootstrap(ctx); err != nil {
		return err
	}
	persisted, err := manager.databaseStatus(ctx)
	if err != nil {
		return err
	}
	startingMode := persisted.State.Mode
	initialMode = &startingMode
	if err := manager.validateExistingTopology(ctx, persisted.State.Mode); err != nil {
		return err
	}
	if persisted.State.Mode == lifecycle.ModeActive {
		actualControl, err := manager.runtime.Container(ctx, manager.config.ControlContainer)
		if err != nil {
			return err
		}
		actualRunner, err := manager.runtime.Container(ctx, manager.config.RunnerContainer)
		if err != nil {
			return err
		}
		if mode == lifecycle.ModeActive &&
			!build &&
			actualControl != nil && actualControl.Status.State == "running" &&
			actualRunner != nil && actualRunner.Status.State == "running" {
			if err := manager.verifyPublishedSurface(
				ctx,
				true,
				true,
				lifecycle.ModeActive,
			); err == nil {
				return nil
			}
			// A mutable tag or credential/configuration rotation invalidates
			// the canonical spec label. Enter the durable drain path before
			// replacing either process.
		}
		if _, err := manager.transition(
			ctx,
			lifecycle.ModeDraining,
			requestID+":recover-draining",
			time.Now().UTC().Add(10*time.Minute),
		); err != nil {
			return fmt.Errorf("recover persisted ACTIVE mode: %w", err)
		}
		persisted, err = manager.databaseStatus(ctx)
		if err != nil {
			return err
		}
	}
	if persisted.State.Mode == lifecycle.ModeDraining {
		persisted, err = manager.recoverDraining(ctx, persisted)
		if err != nil {
			return err
		}
		if _, err := manager.transition(
			ctx,
			lifecycle.ModeMonitorOnly,
			requestID+":recover-monitor",
			time.Time{},
		); err != nil {
			return err
		}
		persisted, err = manager.databaseStatus(ctx)
		if err != nil {
			return err
		}
	}
	if persisted.State.Mode == lifecycle.ModeActive && mode == lifecycle.ModeMonitorOnly {
		return fmt.Errorf("ACTIVE must drain before MONITOR_ONLY")
	}
	if persisted.State.Mode == lifecycle.ModeOff ||
		persisted.State.Mode == lifecycle.ModeMonitorOnly {
		receipt, err := manager.replaceControl(ctx, mode)
		controlChanged = controlChanged || receipt.Mutated
		if err != nil {
			return err
		}
		if persisted.State.Mode == lifecycle.ModeOff {
			if _, err := manager.transition(
				ctx,
				lifecycle.ModeMonitorOnly,
				requestID+":monitor",
				time.Time{},
			); err != nil {
				return err
			}
		}
	}
	receipt, err := manager.replaceRunner(ctx, mode)
	runnerChanged = runnerChanged || receipt.Mutated
	if err != nil {
		return err
	}
	if mode == lifecycle.ModeActive {
		current, err := manager.databaseStatus(ctx)
		if err != nil {
			return err
		}
		if current.State.Mode == lifecycle.ModeMonitorOnly {
			if _, err := manager.transition(
				ctx,
				lifecycle.ModeActive,
				requestID+":active",
				time.Time{},
			); err != nil {
				return err
			}
		}
	}
	return manager.verifyPublishedSurface(
		ctx,
		true,
		true,
		mode,
	)
}

func (manager *manager) Drain(
	ctx context.Context,
	timeout time.Duration,
	requestID string,
) error {
	if err := manager.ensureRuntime(ctx); err != nil {
		return err
	}
	status, err := manager.databaseStatus(ctx)
	if err != nil {
		return err
	}
	switch status.State.Mode {
	case lifecycle.ModeOff:
		return nil
	case lifecycle.ModeMonitorOnly:
		return fmt.Errorf("MONITOR_ONLY has no execution to drain; use stop for OFF")
	case lifecycle.ModeActive, lifecycle.ModeDraining:
	default:
		return fmt.Errorf("unsupported persisted mode %s", status.State.Mode)
	}
	deadline := status.DatabaseTime.UTC().Add(timeout)
	if status.State.Mode == lifecycle.ModeDraining &&
		status.State.DrainDeadlineAt != nil {
		// DRAINING is already authoritative. Preserve its original absolute
		// deadline so a same-key retry is semantically identical and a new
		// key cannot extend the audited drain window.
		deadline = status.State.DrainDeadlineAt.UTC()
	}
	drainState, err := manager.transition(
		ctx,
		lifecycle.ModeDraining,
		requestID,
		deadline,
	)
	if err != nil {
		return err
	}
	if drainState.DrainDeadlineAt == nil {
		return fmt.Errorf("persisted DRAINING state has no drain deadline")
	}
	deadline = drainState.DrainDeadlineAt.UTC()
	// Keep the existing control process and its current internal address alive.
	// PostgreSQL fences routing/enqueue/lease after the DRAINING commit, while
	// the stable CONNECT proxy lets the current attempt reach a natural stop.
	runner, err := manager.runtime.Container(ctx, manager.config.RunnerContainer)
	if err != nil {
		return err
	}
	if runner != nil && runner.Status.State == "running" {
		if err := manager.runtime.SignalTerm(ctx, manager.config.RunnerContainer); err != nil {
			return err
		}
	}
	if err := manager.reconcileExpiredRunnerWork(ctx); err != nil {
		return err
	}
	active, attempts, err := manager.inFlight(ctx)
	if err == nil && active == 0 && attempts == 0 {
		runner, runtimeErr := manager.runtime.Container(
			ctx,
			manager.config.RunnerContainer,
		)
		if runtimeErr != nil {
			return runtimeErr
		}
		if runner == nil || runner.Status.State != "running" {
			return nil
		}
	}
	drainContext, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := manager.reconcileExpiredRunnerWork(drainContext); err != nil {
			return err
		}
		active, attempts, err := manager.inFlight(drainContext)
		if err == nil && active == 0 && attempts == 0 {
			runner, runtimeErr := manager.runtime.Container(
				drainContext,
				manager.config.RunnerContainer,
			)
			if runtimeErr != nil {
				return runtimeErr
			}
			if runner == nil || runner.Status.State != "running" {
				return nil
			}
		}
		select {
		case <-drainContext.Done():
			message := fmt.Sprintf(
				"drain deadline reached; active leases and attempts remain unresolved",
			)
			_ = manager.recordFailure(
				context.Background(),
				"drain",
				message,
				true,
			)
			return fmt.Errorf("%s; runner was not force-killed", message)
		case <-ticker.C:
		}
	}
}

func (manager *manager) reconcileExpiredRunnerWork(ctx context.Context) error {
	_, err := manager.admin(
		ctx,
		[]string{
			"lifecycle",
			"reconcile-expired",
			"--max-attempts", "3",
			"--retry-base", "5s",
		},
		nil,
	)
	if err != nil {
		return fmt.Errorf("reconcile expired runner work: %w", err)
	}
	return nil
}

func (manager *manager) Stop(
	ctx context.Context,
	timeout time.Duration,
	requestID string,
) error {
	if err := manager.ensureRuntime(ctx); err != nil {
		return err
	}
	status, err := manager.databaseStatus(ctx)
	if err != nil {
		containers, listErr := manager.runtime.Containers(ctx)
		if listErr == nil && !hasManagedService(containers, manager.config) {
			return nil
		}
		return err
	}
	if status.State.Mode == lifecycle.ModeActive ||
		status.State.Mode == lifecycle.ModeDraining {
		if err := manager.Drain(ctx, timeout, requestID+":drain"); err != nil {
			return err
		}
		status, err = manager.databaseStatus(ctx)
		if err != nil {
			return err
		}
	}
	if status.ActiveLeases != 0 || status.InFlightAttempts != 0 {
		return fmt.Errorf("refusing OFF with active leases or in-flight attempts")
	}
	for _, name := range []string{
		manager.config.RunnerContainer,
		manager.config.ControlContainer,
	} {
		if err := manager.gracefulStop(ctx, name, 30*time.Second); err != nil {
			_ = manager.recordFailure(ctx, "stop."+name, err.Error(), false)
			return err
		}
		if err := manager.runtime.Delete(ctx, name); err != nil {
			return err
		}
	}
	current, err := manager.databaseStatus(ctx)
	if err != nil {
		return err
	}
	if current.State.Mode != lifecycle.ModeOff {
		if _, err := manager.transition(
			ctx,
			lifecycle.ModeOff,
			requestID+":off",
			time.Time{},
		); err != nil {
			return err
		}
	}
	if err := manager.gracefulStop(
		ctx,
		manager.config.PostgresContainer,
		30*time.Second,
	); err != nil {
		_ = manager.recordFailure(ctx, "stop.postgres", err.Error(), false)
		return err
	}
	if err := manager.runtime.Delete(ctx, manager.config.PostgresContainer); err != nil {
		return err
	}
	return manager.verifyPublishedSurface(ctx, false, false, lifecycle.ModeOff)
}

type combinedStatus struct {
	Persisted            *lifecycle.Status                     `json:"persisted"`
	PersistedError       *string                               `json:"persistedError"`
	Containers           map[string]*lifecycle.ContainerActual `json:"containers"`
	ControlReachable     bool                                  `json:"controlReachable"`
	OffLoopbackReachable bool                                  `json:"offLoopbackReachable"`
	LoopbackOnly         bool                                  `json:"loopbackOnly"`
}

func (manager *manager) Status(ctx context.Context) (combinedStatus, error) {
	if err := manager.ensureRuntime(ctx); err != nil {
		return combinedStatus{}, err
	}
	result := combinedStatus{
		Containers: make(map[string]*lifecycle.ContainerActual),
	}
	for role, name := range map[string]string{
		"control":  manager.config.ControlContainer,
		"runner":   manager.config.RunnerContainer,
		"postgres": manager.config.PostgresContainer,
	} {
		actual, err := manager.runtime.Container(ctx, name)
		if err != nil {
			return combinedStatus{}, err
		}
		result.Containers[role] = redactContainerStatus(actual)
	}
	if result.Containers["postgres"] != nil &&
		result.Containers["postgres"].Status.State == "running" &&
		manager.runtime.ImageExists(ctx, manager.config.ControlImage) {
		persisted, err := manager.databaseStatus(ctx)
		if err != nil {
			message := redactedError(err, manager.config)
			result.PersistedError = &message
		} else {
			result.Persisted = &persisted
		}
	} else {
		message := "PostgreSQL is stopped; persisted lifecycle state is not mutated or inferred"
		result.PersistedError = &message
	}
	result.ControlReachable = tcpReachable(
		"127.0.0.1",
		manager.config.ControlHostPort,
		300*time.Millisecond,
	)
	result.OffLoopbackReachable = manager.offLoopbackReachable()
	control := result.Containers["control"]
	result.LoopbackOnly = control != nil &&
		exactLoopbackPublication(control, manager.config.ControlHostPort) &&
		result.ControlReachable &&
		!result.OffLoopbackReachable
	if control == nil {
		result.LoopbackOnly = !result.ControlReachable && !result.OffLoopbackReachable
	}
	return result, nil
}

func redactContainerStatus(
	actual *lifecycle.ContainerActual,
) *lifecycle.ContainerActual {
	if actual == nil {
		return nil
	}
	redacted := *actual
	redacted.Configuration = actual.Configuration
	redacted.Configuration.InitProcess = actual.Configuration.InitProcess
	redacted.Configuration.InitProcess.Environment = append(
		[]string(nil),
		actual.Configuration.InitProcess.Environment...,
	)
	for index, entry := range redacted.Configuration.InitProcess.Environment {
		key, _, present := strings.Cut(entry, "=")
		if present && lifecycle.CredentialEnvironmentKey(key) {
			redacted.Configuration.InitProcess.Environment[index] = key + "=***"
		}
	}
	return &redacted
}

func printStatus(status combinedStatus) {
	mode := "unavailable"
	if status.Persisted != nil {
		mode = string(status.Persisted.State.Mode)
	}
	fmt.Printf("mode: %s\n", mode)
	for _, role := range []string{"control", "runner", "postgres"} {
		state := "absent"
		if status.Containers[role] != nil {
			state = status.Containers[role].Status.State
		}
		fmt.Printf("%s: %s\n", role, state)
	}
	fmt.Printf(
		"control loopback reachable: %t (off-loopback: %t)\n",
		status.ControlReachable,
		status.OffLoopbackReachable,
	)
	if status.Persisted != nil {
		fmt.Printf(
			"queued=%d active-leases=%d in-flight-attempts=%d drain-timeout=%t\n",
			status.Persisted.QueuedJobs,
			status.Persisted.ActiveLeases,
			status.Persisted.InFlightAttempts,
			status.Persisted.State.DrainTimedOut,
		)
		if status.Persisted.State.LastError != nil {
			fmt.Printf("last error: %s\n", *status.Persisted.State.LastError)
		}
	} else if status.PersistedError != nil {
		fmt.Printf("persisted status: %s\n", *status.PersistedError)
	}
}

func (manager *manager) Logs(
	ctx context.Context,
	component string,
	lines int,
	follow bool,
) error {
	name, present := map[string]string{
		"control":  manager.config.ControlContainer,
		"runner":   manager.config.RunnerContainer,
		"postgres": manager.config.PostgresContainer,
	}[strings.ToLower(strings.TrimSpace(component))]
	if !present {
		return fmt.Errorf("component must be control, runner, or postgres")
	}
	actual, err := manager.runtime.Container(ctx, name)
	if err != nil {
		return err
	}
	if actual == nil {
		return fmt.Errorf("%s container is absent", component)
	}
	return manager.runtime.FollowLogs(ctx, name, lines, follow)
}

func (manager *manager) Open(ctx context.Context) error {
	if !tcpReachable(
		"127.0.0.1",
		manager.config.ControlHostPort,
		time.Second,
	) {
		return fmt.Errorf("Control API is not reachable on loopback")
	}
	dashboardURL := fmt.Sprintf(
		"http://127.0.0.1:%d/dashboard",
		manager.config.ControlHostPort,
	)
	command := exec.CommandContext(ctx, "open", dashboardURL)
	return command.Run()
}

func (manager *manager) RotatePostgresAdmin(
	ctx context.Context,
	requestID string,
) error {
	if err := manager.config.validatePostgresRotation(); err != nil {
		return err
	}
	if err := manager.ensureRuntime(ctx); err != nil {
		return err
	}
	_, err := manager.admin(
		ctx,
		[]string{"rotate-postgres-admin", "--request-id", requestID},
		map[string]string{
			"AGENTOPS_NEXT_POSTGRES_PASSWORD": manager.config.NextPostgresPassword,
		},
	)
	return err
}

func (manager *manager) ensureRuntime(ctx context.Context) error {
	capability := manager.runtime.Capability(ctx)
	if !capability.Available {
		return fmt.Errorf("Apple Container CLI is not available")
	}
	if !capability.ServiceRunning {
		if err := manager.runtime.StartSystem(ctx); err != nil {
			return fmt.Errorf("start Apple Container system: %w", err)
		}
		capability = manager.runtime.Capability(ctx)
		if !capability.ServiceRunning {
			return fmt.Errorf("Apple Container system did not become ready")
		}
	}
	return nil
}

func (manager *manager) ensurePostgres(ctx context.Context) (bool, error) {
	spec := manager.postgresSpec()
	if err := manager.sealSpec(ctx, &spec); err != nil {
		return false, err
	}
	actual, err := manager.runtime.Container(ctx, manager.config.PostgresContainer)
	if err != nil {
		return false, err
	}
	if actual != nil {
		if actual.Configuration.Labels["com.mrbaron3.workflow.agentopsctl"] != "v1" {
			return false, fmt.Errorf("postgres container name is owned by another deployment")
		}
		if actual.Status.State == "running" {
			if err := validatePostgresActual(actual, manager.config); err != nil {
				return false, err
			}
			if err := validateSpecActual(actual, spec); err != nil {
				return false, fmt.Errorf(
					"PostgreSQL image/spec drift requires DRAINING, stop, and volume-preserving restart: %w",
					err,
				)
			}
			return false, manager.waitPostgres(ctx)
		}
		if err := manager.runtime.Delete(ctx, manager.config.PostgresContainer); err != nil {
			return false, err
		}
	}
	_, err = manager.runtime.RunContainer(ctx, spec)
	if err != nil {
		return false, err
	}
	return true, manager.waitPostgres(ctx)
}

func (manager *manager) postgresSpec() lifecycle.ContainerSpec {
	return lifecycle.ContainerSpec{
		Name:     manager.config.PostgresContainer,
		Role:     "postgres",
		Image:    manager.config.PostgresImage,
		Networks: []string{manager.config.Network},
		Environment: map[string]string{
			"POSTGRES_PASSWORD": manager.config.PostgresPassword,
			"POSTGRES_DB":       "agentops",
			"PGDATA":            "/var/lib/postgresql/data",
		},
		Mounts: []lifecycle.Mount{{
			Volume: manager.config.PostgresVolume,
			Target: "/var/lib/postgresql",
		}},
		Tmpfs: []string{"/tmp", "/run/postgresql"},
		Init:  true, Detach: true,
	}
}

func (manager *manager) waitPostgres(ctx context.Context) error {
	wait, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		result := manager.runtime.Exec(
			wait,
			manager.config.PostgresContainer,
			"pg_isready", "-U", "postgres", "-d", "agentops",
		)
		if result.Status == 0 {
			return nil
		}
		select {
		case <-wait.Done():
			return fmt.Errorf("PostgreSQL readiness timeout: %w", wait.Err())
		case <-ticker.C:
		}
	}
}

func (manager *manager) migrateAndBootstrap(ctx context.Context) error {
	if _, err := manager.admin(ctx, []string{"migrate"}, nil); err != nil {
		return err
	}
	if _, err := manager.admin(
		ctx,
		[]string{"bootstrap-roles"},
		map[string]string{
			"AGENTOPS_CONTROL_DB_PASSWORD": manager.config.ControlDBPassword,
			"AGENTOPS_RUNNER_DB_PASSWORD":  manager.config.RunnerDBPassword,
		},
	); err != nil {
		return err
	}
	return nil
}

func (manager *manager) admin(
	ctx context.Context,
	command []string,
	extra map[string]string,
) (string, error) {
	databaseHost, err := manager.databaseHost(ctx)
	if err != nil {
		return "", err
	}
	environment := map[string]string{
		"AGENTOPS_DATABASE_URL": manager.config.adminDatabaseURL(databaseHost),
		"AGENTOPS_APP_ROOT":     "/app",
	}
	for key, value := range extra {
		environment[key] = value
	}
	name := fmt.Sprintf(
		"%s-admin-%d-%d",
		manager.config.Prefix,
		os.Getpid(),
		time.Now().UTC().UnixNano()%1_000_000,
	)
	return manager.runtime.RunContainer(ctx, lifecycle.ContainerSpec{
		Name:        name,
		Role:        "admin",
		Image:       manager.config.ControlImage,
		Networks:    []string{manager.config.Network},
		Environment: environment,
		Tmpfs:       []string{"/tmp"},
		ReadOnly:    true,
		CapDropAll:  true,
		Remove:      true,
		Command:     command,
	})
}

func (manager *manager) databaseStatus(ctx context.Context) (lifecycle.Status, error) {
	output, err := manager.admin(ctx, []string{"lifecycle", "status"}, nil)
	if err != nil {
		return lifecycle.Status{}, err
	}
	var status lifecycle.Status
	if err := json.Unmarshal([]byte(output), &status); err != nil {
		return lifecycle.Status{}, fmt.Errorf("parse lifecycle status: %w", err)
	}
	return status, nil
}

func (manager *manager) recoverDraining(
	ctx context.Context,
	status lifecycle.Status,
) (lifecycle.Status, error) {
	deadline := time.Now().UTC().Add(10 * time.Minute)
	if status.State.DrainDeadlineAt != nil {
		deadline = *status.State.DrainDeadlineAt
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := manager.reconcileExpiredRunnerWork(ctx); err != nil {
			return lifecycle.Status{}, err
		}
		current, err := manager.databaseStatus(ctx)
		if err != nil {
			return lifecycle.Status{}, err
		}
		if current.ActiveLeases == 0 && current.InFlightAttempts == 0 {
			return current, nil
		}
		if !time.Now().UTC().Before(deadline) {
			message := fmt.Sprintf(
				"recovery drain deadline reached with %d active leases and %d in-flight attempts",
				current.ActiveLeases,
				current.InFlightAttempts,
			)
			_ = manager.recordFailure(
				context.Background(),
				"start.recovery",
				message,
				true,
			)
			return lifecycle.Status{}, fmt.Errorf("%s", message)
		}
		select {
		case <-ctx.Done():
			return lifecycle.Status{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (manager *manager) transition(
	ctx context.Context,
	to lifecycle.Mode,
	requestID string,
	deadline time.Time,
) (lifecycle.State, error) {
	command := []string{
		"lifecycle", "transition",
		"--to", string(to),
		"--idempotency-key", requestID,
		"--actor", "agentopsctl",
	}
	if !deadline.IsZero() {
		command = append(
			command,
			"--drain-deadline",
			deadline.UTC().Format(time.RFC3339Nano),
		)
	}
	output, err := manager.admin(ctx, command, nil)
	if err != nil {
		return lifecycle.State{}, err
	}
	var result struct {
		State lifecycle.State `json:"state"`
	}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return lifecycle.State{}, fmt.Errorf("parse lifecycle transition: %w", err)
	}
	if result.State.Mode != to {
		return result.State, fmt.Errorf(
			"lifecycle transition did not establish %s (current=%s)",
			to,
			result.State.Mode,
		)
	}
	return result.State, nil
}

func (manager *manager) recordFailure(
	ctx context.Context,
	operation, message string,
	drainTimeout bool,
) error {
	message = redactedError(errors.New(message), manager.config)
	command := []string{
		"lifecycle", "failure",
		"--operation", operation,
		"--message", message,
	}
	if drainTimeout {
		command = append(command, "--drain-timeout")
	}
	_, err := manager.admin(ctx, command, nil)
	return err
}

func (manager *manager) replaceControl(
	ctx context.Context,
	mode lifecycle.Mode,
) (mutationReceipt, error) {
	databaseHost, err := manager.databaseHost(ctx)
	if err != nil {
		return mutationReceipt{}, err
	}
	spec := manager.controlSpec(mode, databaseHost)
	if err := manager.sealSpec(ctx, &spec); err != nil {
		return mutationReceipt{}, err
	}
	receipt := mutationReceipt{Mutated: true}
	if err := manager.gracefulStop(
		ctx,
		manager.config.ControlContainer,
		20*time.Second,
	); err != nil {
		return receipt, err
	}
	if err := manager.runtime.Delete(ctx, manager.config.ControlContainer); err != nil {
		return receipt, err
	}
	_, err = manager.runtime.RunContainer(ctx, spec)
	if err != nil {
		return receipt, err
	}
	health, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		request, _ := http.NewRequestWithContext(
			health,
			http.MethodGet,
			fmt.Sprintf(
				"http://127.0.0.1:%d/healthz",
				manager.config.ControlHostPort,
			),
			nil,
		)
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return receipt, nil
			}
		}
		select {
		case <-health.Done():
			return receipt, fmt.Errorf("Control API readiness timeout: %w", health.Err())
		case <-ticker.C:
		}
	}
}

func (manager *manager) controlSpec(
	mode lifecycle.Mode,
	databaseHost string,
) lifecycle.ContainerSpec {
	return lifecycle.ContainerSpec{
		Name:  manager.config.ControlContainer,
		Role:  "control",
		Image: manager.config.ControlImage,
		// Apple Container assigns the default route to the first network.
		// Keep public egress on default while retaining the host-only network
		// solely for runner/PostgreSQL connectivity.
		Networks: []string{"default", manager.config.Network},
		Environment: map[string]string{
			"AGENTOPS_DATABASE_URL":              manager.config.controlDatabaseURL(databaseHost),
			"AGENTOPS_CONTROL_TOKEN":             manager.config.ControlToken,
			"AGENTOPS_DASHBOARD_BOOTSTRAP_TOKEN": manager.config.DashboardToken,
			"AGENTOPS_GITHUB_WEBHOOK_SECRET":     manager.config.WebhookSecret,
			"AGENTOPS_OPERATING_MODE":            string(mode),
			"AGENTOPS_DASHBOARD_ORIGIN": fmt.Sprintf(
				"http://127.0.0.1:%d",
				manager.config.ControlHostPort,
			),
			"AGENTOPS_CONTROL_LISTEN":                   "127.0.0.1:8081",
			"AGENTOPS_CONTROL_PROXY_LISTEN":             "0.0.0.0:8080",
			"AGENTOPS_RUNNER_EGRESS_PROXY_LISTEN":       "0.0.0.0:8082",
			"AGENTOPS_RUNNER_PROVIDER":                  manager.config.Provider,
			"AGENTOPS_RUNNER_PROVIDER_AUTH":             manager.config.providerAuth(mode),
			"AGENTOPS_GITHUB_MONITOR_BROKER_REPOSITORY": manager.config.MonitorRepository,
			"AGENTOPS_APP_ROOT":                         "/app",
		},
		Publish: []lifecycle.Publication{{
			HostIP:        "127.0.0.1",
			HostPort:      manager.config.ControlHostPort,
			ContainerPort: 8080,
		}},
		Tmpfs:      []string{"/tmp"},
		ReadOnly:   true,
		CapDropAll: true,
		Init:       true,
		Detach:     true,
	}
}

func (manager *manager) ensureRunnerVolumeOwner(ctx context.Context) error {
	_, err := manager.runtime.RunContainer(ctx, lifecycle.ContainerSpec{
		Name: fmt.Sprintf(
			"%s-volume-init-%d",
			manager.config.Prefix,
			os.Getpid(),
		),
		Role:  "volume-init",
		Image: manager.config.RunnerImage,
		Networks: []string{
			manager.config.Network,
		},
		Mounts: []lifecycle.Mount{{
			Volume: manager.config.RunnerVolume,
			Target: "/workspace",
		}},
		User:       "root",
		Entrypoint: "/bin/sh",
		Command: []string{
			"-c",
			"mkdir -p /workspace/registrations /workspace/store && " +
				"chown -R 65532:65532 /workspace/registrations /workspace/store",
		},
		CapDropAll: true,
		CapAdd:     []string{"CAP_CHOWN"},
		Remove:     true,
	})
	return err
}

func (manager *manager) seedCodexCredentialVolume(
	ctx context.Context,
	mode lifecycle.Mode,
) error {
	if !manager.config.usesCodexAuthFileFor(mode) {
		return nil
	}
	if err := validateCodexAuthSource(manager.config.CodexAuthPath); err != nil {
		return err
	}
	name := fmt.Sprintf(
		"%s-credential-init-%d",
		manager.config.Prefix,
		os.Getpid(),
	)
	_, err := manager.runtime.RunContainer(ctx, lifecycle.ContainerSpec{
		Name:     name,
		Role:     "volume-init",
		Image:    manager.config.RunnerImage,
		Networks: []string{manager.config.Network},
		Mounts: []lifecycle.Mount{{
			Volume: manager.config.CredentialVolume,
			Target: "/credentials",
		}},
		User:       "root",
		Entrypoint: "/bin/sh",
		Command: []string{
			"-c",
			"mkdir -p /credentials/codex && " +
				"chown 0:0 /credentials/codex && " +
				"chmod 0700 /credentials/codex && " +
				"chown 65532:65532 /credentials/codex && sleep 600",
		},
		CapDropAll: true,
		CapAdd:     []string{"CAP_CHOWN"},
		Detach:     true,
		Remove:     true,
	})
	if err != nil {
		return err
	}
	defer func() {
		_ = manager.runtime.Stop(context.Background(), name, 5)
		_ = manager.runtime.Delete(context.Background(), name)
	}()
	ready, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := manager.runtime.WaitState(
		ready,
		name,
		"running",
		250*time.Millisecond,
	); err != nil {
		return err
	}
	if err := manager.runtime.CopyFileToContainer(
		ctx,
		name,
		manager.config.CodexAuthPath,
		"/credentials/codex/auth.json",
	); err != nil {
		return err
	}
	return nil
}

func (manager *manager) replaceRunner(
	ctx context.Context,
	mode lifecycle.Mode,
) (mutationReceipt, error) {
	databaseHost, err := manager.databaseHost(ctx)
	if err != nil {
		return mutationReceipt{}, err
	}
	controlHost, err := manager.networkHost(ctx, manager.config.ControlContainer)
	if err != nil {
		return mutationReceipt{}, err
	}
	spec := manager.runnerSpec(mode, databaseHost, controlHost)
	if err := manager.sealSpec(ctx, &spec); err != nil {
		return mutationReceipt{}, err
	}
	receipt := mutationReceipt{Mutated: true}
	if err := manager.gracefulStop(
		ctx,
		manager.config.RunnerContainer,
		20*time.Second,
	); err != nil {
		return receipt, err
	}
	if err := manager.runtime.Delete(ctx, manager.config.RunnerContainer); err != nil {
		return receipt, err
	}
	if err := manager.ensureRunnerVolumeOwner(ctx); err != nil {
		return receipt, err
	}
	if err := manager.seedCodexCredentialVolume(ctx, mode); err != nil {
		return receipt, err
	}
	_, err = manager.runtime.RunContainer(ctx, spec)
	if err != nil {
		return receipt, err
	}
	ready, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := manager.runtime.WaitState(
		ready,
		manager.config.RunnerContainer,
		"running",
		500*time.Millisecond,
	); err != nil {
		return receipt, err
	}
	select {
	case <-ready.Done():
		return receipt, ready.Err()
	case <-time.After(2 * time.Second):
	}
	actual, err := manager.runtime.Container(ctx, manager.config.RunnerContainer)
	if err != nil {
		return receipt, err
	}
	if actual == nil || actual.Status.State != "running" {
		logs := manager.runtime.RecentLogs(
			ctx,
			manager.config.RunnerContainer,
			100,
		)
		detail := strings.TrimSpace(logs.Stdout + logs.Stderr)
		if detail == "" {
			detail = "no runner log output"
		}
		return receipt, fmt.Errorf(
			"runner exited during readiness stabilization: %s",
			redactedError(errors.New(detail), manager.config),
		)
	}
	if mode == lifecycle.ModeActive {
		if err := manager.probeRunnerProvider(ctx); err != nil {
			return receipt, err
		}
	}
	return receipt, nil
}

func (manager *manager) probeRunnerProvider(ctx context.Context) error {
	probeContext, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var command []string
	switch manager.config.Provider {
	case "codex":
		// The catalog request exercises the selected login/API credential and
		// its exact egress path without running an agent or persisting output.
		command = []string{"codex", "debug", "models"}
	case "claude":
		// Claude's status command validates the CLI credential boundary. The
		// CISO-07 grounded execution provider is Codex; Claude remains review-only.
		command = []string{"claude", "auth", "status", "--json"}
	default:
		return fmt.Errorf("runner provider readiness is unsupported")
	}
	result := manager.runtime.Exec(
		probeContext,
		manager.config.RunnerContainer,
		command...,
	)
	if probeContext.Err() != nil || result.Status != 0 {
		return fmt.Errorf("runner provider authentication readiness failed")
	}
	return nil
}

func (manager *manager) runnerSpec(
	mode lifecycle.Mode,
	databaseHost, controlHost string,
) lifecycle.ContainerSpec {
	outbound := []map[string]any{
		{"host": databaseHost, "port": 5432},
		{"host": "github.com", "port": 443},
		{"host": "api.github.com", "port": 443},
	}
	providerAuth := manager.config.providerAuth(mode)
	if mode == lifecycle.ModeActive {
		if manager.config.Provider == "codex" && providerAuth == "codex-login" {
			outbound = append(
				outbound,
				map[string]any{"host": "chatgpt.com", "port": 443},
				map[string]any{"host": "auth.openai.com", "port": 443},
			)
		} else if manager.config.Provider == "codex" {
			outbound = append(
				outbound,
				map[string]any{"host": "api.openai.com", "port": 443},
			)
		} else {
			outbound = append(
				outbound,
				map[string]any{"host": "api.anthropic.com", "port": 443},
			)
		}
	}
	outboundJSON, _ := json.Marshal(outbound)
	mounts := []map[string]any{{
		"source":   manager.config.RunnerVolume,
		"target":   "/workspace",
		"readOnly": false,
	}}
	runtimeMounts := []lifecycle.Mount{{
		Volume: manager.config.RunnerVolume,
		Target: "/workspace",
	}}
	if manager.config.usesCodexAuthFileFor(mode) {
		mounts = append(mounts, map[string]any{
			"source":   manager.config.CredentialVolume,
			"target":   "/run/agentops-credentials",
			"readOnly": true,
		})
		runtimeMounts = append(runtimeMounts, lifecycle.Mount{
			Volume:   manager.config.CredentialVolume,
			Target:   "/run/agentops-credentials",
			ReadOnly: true,
		})
	}
	mountJSON, _ := json.Marshal(mounts)
	environment := map[string]string{
		"AGENTOPS_RUNNER_DATABASE_URL":         manager.config.runnerDatabaseURL(databaseHost),
		"AGENTOPS_RUNNER_WORKER_ID":            manager.config.RunnerContainer,
		"AGENTOPS_RUNNER_PROVIDER":             manager.config.Provider,
		"AGENTOPS_RUNNER_PROVIDER_AUTH":        providerAuth,
		"AGENTOPS_OPERATING_MODE":              string(mode),
		"AGENTOPS_RUNNER_MOUNTS_JSON":          string(mountJSON),
		"AGENTOPS_RUNNER_PUBLISHED_PORTS_JSON": "[]",
		"AGENTOPS_RUNNER_OUTBOUND_JSON":        string(outboundJSON),
		"AGENTOPS_RUNNER_GITHUB_TOKEN":         manager.config.RunnerGitHubToken,
		"AGENTOPS_MONITOR_REPOSITORY":          manager.config.MonitorRepository,
		"HTTPS_PROXY":                          "http://" + controlHost + ":8082",
		"HTTP_PROXY":                           "http://" + controlHost + ":8082",
		"NO_PROXY":                             databaseHost + ",127.0.0.1,localhost",
	}
	if mode == lifecycle.ModeActive && manager.config.Provider == "codex" {
		if manager.config.usesCodexAuthFileFor(mode) {
			environment["CODEX_HOME"] = "/run/agentops-credentials/codex"
		} else {
			environment["OPENAI_API_KEY"] = manager.config.ProviderToken
		}
	} else if mode == lifecycle.ModeActive {
		environment["ANTHROPIC_API_KEY"] = manager.config.ProviderToken
	}
	return lifecycle.ContainerSpec{
		Name:        manager.config.RunnerContainer,
		Role:        "runner",
		Image:       manager.config.RunnerImage,
		Networks:    []string{manager.config.Network},
		Environment: environment,
		Mounts:      runtimeMounts,
		Tmpfs:       []string{"/tmp", "/home/agentops"},
		ReadOnly:    true,
		CapDropAll:  true,
		Init:        true,
		Detach:      true,
	}
}

func (manager *manager) sealSpec(
	ctx context.Context,
	spec *lifecycle.ContainerSpec,
) error {
	imageDigest, err := manager.runtime.ImageDigest(ctx, spec.Image)
	if err != nil {
		return err
	}
	specDigest, err := lifecycle.SpecDigest(*spec, imageDigest)
	if err != nil {
		return err
	}
	spec.SpecDigest = specDigest
	return nil
}

func (manager *manager) databaseHost(ctx context.Context) (string, error) {
	return manager.networkHost(ctx, manager.config.PostgresContainer)
}

func (manager *manager) networkHost(
	ctx context.Context,
	containerName string,
) (string, error) {
	actual, err := manager.runtime.Container(ctx, containerName)
	if err != nil {
		return "", err
	}
	if actual == nil || actual.Status.State != "running" {
		return "", fmt.Errorf("container %s is not running", containerName)
	}
	for _, network := range actual.Status.Networks {
		if network.Network != manager.config.Network {
			continue
		}
		host, _, _ := strings.Cut(network.IPv4Address, "/")
		if net.ParseIP(host) == nil {
			continue
		}
		return host, nil
	}
	return "", fmt.Errorf(
		"container %s has no IPv4 address on network %s",
		containerName,
		manager.config.Network,
	)
}

func (manager *manager) gracefulStop(
	ctx context.Context,
	name string,
	timeout time.Duration,
) error {
	actual, err := manager.runtime.Container(ctx, name)
	if err != nil || actual == nil || actual.Status.State != "running" {
		return err
	}
	if actual.Configuration.Labels["com.mrbaron3.workflow.agentopsctl"] != "v1" {
		return fmt.Errorf("container %s is not owned by agentopsctl", name)
	}
	if err := manager.runtime.SignalTerm(ctx, name); err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return manager.runtime.WaitState(wait, name, "stopped", 500*time.Millisecond)
}

func (manager *manager) inFlight(ctx context.Context) (int64, int64, error) {
	result := manager.runtime.Exec(
		ctx,
		manager.config.PostgresContainer,
		"psql", "-U", "postgres", "-d", "agentops", "-Atqc",
		`SELECT
		   count(DISTINCT l.id) FILTER (
		     WHERE l.status = 'active' AND l.expires_at > clock_timestamp()
		   )::text || ':' ||
		   count(DISTINCT a.id) FILTER (WHERE a.status = 'running')::text
		 FROM agentops_control.job_leases l
		 FULL JOIN agentops_control.job_attempts a ON a.id = l.attempt_id`,
	)
	if result.Status != 0 {
		return 0, 0, fmt.Errorf("query in-flight state failed")
	}
	parts := strings.Split(strings.TrimSpace(result.Stdout), ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid in-flight state response")
	}
	active, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	attempts, err := strconv.ParseInt(parts[1], 10, 64)
	return active, attempts, err
}

func (manager *manager) compensateStart(
	ctx context.Context,
	postgresStarted, controlChanged, runnerChanged bool,
	initialMode *lifecycle.Mode,
	requestID string,
) error {
	target := lifecycle.ModeOff
	if initialMode != nil {
		target = *initialMode
	}
	current, currentErr := manager.databaseStatus(ctx)
	if currentErr == nil &&
		(current.State.Mode == lifecycle.ModeActive ||
			current.State.Mode == lifecycle.ModeDraining) {
		// Never skip a drain merely to restore the pre-command mode: a runner
		// can acquire work between the ACTIVE commit and a later failure.
		target = lifecycle.ModeDraining
	} else if target == lifecycle.ModeActive || target == lifecycle.ModeDraining {
		// A partially replaced execution topology must never be advertised as
		// ACTIVE. Preserve DRAINING until work is reconciled; if recovery
		// already reached MONITOR_ONLY, retain that later safe boundary.
		if currentErr == nil &&
			(current.State.Mode == lifecycle.ModeMonitorOnly ||
				current.State.Mode == lifecycle.ModeOff) {
			target = current.State.Mode
		} else {
			target = lifecycle.ModeDraining
		}
	}
	if err := manager.rollbackLifecycle(
		ctx,
		target,
		requestID+":compensate",
	); err != nil {
		_ = manager.recordFailure(
			ctx,
			"start.compensation.lifecycle",
			err.Error(),
			false,
		)
	}

	names := make([]string, 0, 1)
	if runnerChanged {
		names = append(names, manager.config.RunnerContainer)
	}
	if controlChanged && target == lifecycle.ModeOff {
		names = append(names, manager.config.ControlContainer)
	}
	for _, name := range names {
		_ = manager.gracefulStop(ctx, name, 10*time.Second)
		_ = manager.runtime.Delete(ctx, name)
	}
	if controlChanged && target != lifecycle.ModeOff {
		// Recreate the control plane from current credentials and the safe
		// durable mode; this restores a pre-existing MONITOR_ONLY topology and
		// retains the recovery proxy for DRAINING.
		_, _ = manager.replaceControl(ctx, target)
	}
	if postgresStarted {
		if target == lifecycle.ModeOff {
			_ = manager.gracefulStop(ctx, manager.config.PostgresContainer, 15*time.Second)
			_ = manager.runtime.Delete(ctx, manager.config.PostgresContainer)
		}
	}
	return nil
}

func (manager *manager) rollbackLifecycle(
	ctx context.Context,
	target lifecycle.Mode,
	requestID string,
) error {
	status, err := manager.databaseStatus(ctx)
	if err != nil {
		return err
	}
	current := status.State.Mode
	if current == target {
		return nil
	}
	if current == lifecycle.ModeActive {
		state, err := manager.transition(
			ctx,
			lifecycle.ModeDraining,
			requestID+":draining",
			time.Now().UTC().Add(10*time.Minute),
		)
		if err != nil {
			return err
		}
		current = state.Mode
	}
	if target == lifecycle.ModeDraining {
		if current != lifecycle.ModeDraining {
			return fmt.Errorf("cannot compensate %s to DRAINING", current)
		}
		return nil
	}
	if current == lifecycle.ModeDraining {
		state, err := manager.transition(
			ctx,
			target,
			requestID+":"+strings.ToLower(string(target)),
			time.Time{},
		)
		if err != nil {
			return err
		}
		current = state.Mode
	}
	if current == lifecycle.ModeOff && target == lifecycle.ModeMonitorOnly {
		state, err := manager.transition(
			ctx,
			target,
			requestID+":monitor",
			time.Time{},
		)
		if err != nil {
			return err
		}
		current = state.Mode
	}
	if current == lifecycle.ModeMonitorOnly && target == lifecycle.ModeOff {
		state, err := manager.transition(
			ctx,
			target,
			requestID+":off",
			time.Time{},
		)
		if err != nil {
			return err
		}
		current = state.Mode
	}
	if current != target {
		return fmt.Errorf("compensation established %s instead of %s", current, target)
	}
	return nil
}

func (manager *manager) verifyPublishedSurface(
	ctx context.Context,
	controlExpected, runnerExpected bool,
	mode lifecycle.Mode,
) error {
	reachable := tcpReachable(
		"127.0.0.1",
		manager.config.ControlHostPort,
		time.Second,
	)
	if reachable != controlExpected {
		return fmt.Errorf(
			"control loopback publication expected=%t observed=%t",
			controlExpected,
			reachable,
		)
	}
	if tcpReachable("127.0.0.1", 5432, 300*time.Millisecond) {
		return fmt.Errorf("PostgreSQL 5432 is unexpectedly reachable on host loopback")
	}
	if controlExpected && manager.offLoopbackReachable() {
		return fmt.Errorf("control port is reachable off loopback")
	}
	control, err := manager.runtime.Container(ctx, manager.config.ControlContainer)
	if err != nil {
		return err
	}
	if controlExpected && !exactLoopbackPublication(
		control,
		manager.config.ControlHostPort,
	) {
		return fmt.Errorf("control does not have exactly one loopback-only publication")
	}
	if controlExpected {
		if err := manager.verifyManagedTopology(ctx, runnerExpected, mode); err != nil {
			return err
		}
	}
	for _, role := range []string{
		manager.config.RunnerContainer,
		manager.config.PostgresContainer,
	} {
		actual, err := manager.runtime.Container(ctx, role)
		if err != nil {
			return err
		}
		if actual != nil &&
			(len(actual.Configuration.PublishedPorts) != 0 ||
				len(actual.Configuration.PublishedSock) != 0) {
			return fmt.Errorf("%s exposes a host port or socket", role)
		}
	}
	return nil
}

func (manager *manager) verifyManagedTopology(
	ctx context.Context,
	runnerExpected bool,
	mode lifecycle.Mode,
) error {
	control, err := manager.runtime.Container(ctx, manager.config.ControlContainer)
	if err != nil {
		return err
	}
	postgres, err := manager.runtime.Container(ctx, manager.config.PostgresContainer)
	if err != nil {
		return err
	}
	runner, err := manager.runtime.Container(ctx, manager.config.RunnerContainer)
	if err != nil {
		return err
	}
	if err := validateControlActual(control, manager.config); err != nil {
		return err
	}
	databaseHost, err := manager.databaseHost(ctx)
	if err != nil {
		return err
	}
	controlSpec := manager.controlSpec(mode, databaseHost)
	if err := manager.sealSpec(ctx, &controlSpec); err != nil {
		return err
	}
	if err := validateSpecActual(control, controlSpec); err != nil {
		return err
	}
	if err := validatePostgresActual(postgres, manager.config); err != nil {
		return err
	}
	postgresSpec := manager.postgresSpec()
	if err := manager.sealSpec(ctx, &postgresSpec); err != nil {
		return err
	}
	if err := validateSpecActual(postgres, postgresSpec); err != nil {
		return err
	}
	if runnerExpected {
		if err := validateRunnerActual(runner, manager.config, mode); err != nil {
			return err
		}
		controlHost, err := manager.networkHost(
			ctx,
			manager.config.ControlContainer,
		)
		if err != nil {
			return err
		}
		runnerSpec := manager.runnerSpec(mode, databaseHost, controlHost)
		if err := manager.sealSpec(ctx, &runnerSpec); err != nil {
			return err
		}
		return validateSpecActual(runner, runnerSpec)
	}
	// OFF is verified with both controlExpected and runnerExpected false.
	// MONITOR_ONLY intentionally keeps runner alive for the typed read broker.
	return nil
}

func validateSpecActual(
	actual *lifecycle.ContainerActual,
	expected lifecycle.ContainerSpec,
) error {
	if actual == nil {
		return fmt.Errorf("%s container is absent", expected.Name)
	}
	imageDigest := actual.Configuration.Image.Descriptor.Digest
	if !strings.HasPrefix(imageDigest, "sha256:") {
		return fmt.Errorf("%s has no immutable image descriptor", expected.Name)
	}
	expectedDigest, err := lifecycle.SpecDigest(expected, imageDigest)
	if err != nil {
		return err
	}
	if expected.SpecDigest != expectedDigest {
		return fmt.Errorf("%s desired specification digest is inconsistent", expected.Name)
	}
	if actual.Configuration.Labels["com.mrbaron3.workflow.spec-sha256"] !=
		expected.SpecDigest {
		return fmt.Errorf("%s immutable image or runtime specification drifted", expected.Name)
	}
	actualEnvironment := make(map[string]string)
	for _, entry := range actual.Configuration.InitProcess.Environment {
		key, value, present := strings.Cut(entry, "=")
		if !present || key == "" {
			return fmt.Errorf("%s actual environment is malformed", expected.Name)
		}
		if _, duplicate := actualEnvironment[key]; duplicate {
			return fmt.Errorf("%s actual environment repeats %s", expected.Name, key)
		}
		actualEnvironment[key] = value
	}
	for key, desired := range expected.Environment {
		if observed, present := actualEnvironment[key]; !present || observed != desired {
			return fmt.Errorf("%s environment drifted at %s", expected.Name, key)
		}
	}
	for key := range actualEnvironment {
		if lifecycle.CredentialEnvironmentKey(key) {
			if _, expectedCredential := expected.Environment[key]; !expectedCredential {
				return fmt.Errorf(
					"%s has an unexpected credential environment key %s",
					expected.Name,
					key,
				)
			}
		}
	}
	return nil
}

func (manager *manager) validateExistingTopology(
	ctx context.Context,
	mode lifecycle.Mode,
) error {
	for _, name := range []string{
		manager.config.ControlContainer,
		manager.config.RunnerContainer,
		manager.config.PostgresContainer,
	} {
		actual, err := manager.runtime.Container(ctx, name)
		if err != nil {
			return err
		}
		if actual != nil && actual.Status.State == "running" {
			var validateErr error
			switch name {
			case manager.config.ControlContainer:
				validateErr = validateControlActual(actual, manager.config)
			case manager.config.RunnerContainer:
				validateErr = validateRunnerActual(actual, manager.config, mode)
			case manager.config.PostgresContainer:
				validateErr = validatePostgresActual(actual, manager.config)
			}
			if validateErr != nil {
				return validateErr
			}
		}
	}
	return nil
}

func validateControlActual(
	actual *lifecycle.ContainerActual,
	config config,
) error {
	if err := validateManagedActual(
		actual,
		config.ControlContainer,
		"control",
		config.ControlImage,
		[]string{"default", config.Network},
		true,
	); err != nil {
		return err
	}
	if !exactLoopbackPublication(actual, config.ControlHostPort) {
		return fmt.Errorf("control publication does not match the expected loopback port")
	}
	if !exactMounts(actual, map[string]string{"/tmp": "tmpfs"}) {
		return fmt.Errorf("control mounts do not match the hardened topology")
	}
	return nil
}

func validateRunnerActual(
	actual *lifecycle.ContainerActual,
	config config,
	mode lifecycle.Mode,
) error {
	if err := validateManagedActual(
		actual,
		config.RunnerContainer,
		"runner",
		config.RunnerImage,
		[]string{config.Network},
		true,
	); err != nil {
		return err
	}
	if len(actual.Configuration.PublishedPorts) != 0 ||
		len(actual.Configuration.PublishedSock) != 0 {
		return fmt.Errorf("runner exposes a host port or socket")
	}
	expectedMounts := map[string]string{
		"/tmp":           "tmpfs",
		"/home/agentops": "tmpfs",
		"/workspace":     config.RunnerVolume,
	}
	if config.usesCodexAuthFileFor(mode) {
		expectedMounts["/run/agentops-credentials"] = config.CredentialVolume
	}
	if !exactMounts(actual, expectedMounts) {
		return fmt.Errorf("runner mounts do not match the hardened topology")
	}
	return nil
}

func validatePostgresActual(
	actual *lifecycle.ContainerActual,
	config config,
) error {
	if err := validateManagedActual(
		actual,
		config.PostgresContainer,
		"postgres",
		config.PostgresImage,
		[]string{config.Network},
		false,
	); err != nil {
		return err
	}
	if len(actual.Configuration.PublishedPorts) != 0 ||
		len(actual.Configuration.PublishedSock) != 0 {
		return fmt.Errorf("PostgreSQL exposes a host port or socket")
	}
	if !exactMounts(actual, map[string]string{
		"/tmp":                "tmpfs",
		"/run/postgresql":     "tmpfs",
		"/var/lib/postgresql": config.PostgresVolume,
	}) {
		return fmt.Errorf("PostgreSQL mounts do not match the managed topology")
	}
	return nil
}

func validateManagedActual(
	actual *lifecycle.ContainerActual,
	name, role, image string,
	networks []string,
	hardened bool,
) error {
	if actual == nil || actual.Status.State != "running" {
		return fmt.Errorf("%s container is not running", name)
	}
	if actual.ID != name ||
		actual.Configuration.Labels["com.mrbaron3.workflow.agentopsctl"] != "v1" ||
		actual.Configuration.Labels["com.mrbaron3.workflow.role"] != role {
		return fmt.Errorf("%s ownership or role label does not match", name)
	}
	if !imageReferenceMatches(actual.Configuration.Image.Reference, image) {
		return fmt.Errorf("%s image does not match %s", name, image)
	}
	actualNetworks := make([]string, 0, len(actual.Configuration.Networks))
	for _, network := range actual.Configuration.Networks {
		actualNetworks = append(actualNetworks, network.Network)
	}
	if strings.Join(actualNetworks, "\x00") != strings.Join(networks, "\x00") {
		return fmt.Errorf("%s networks do not match the managed topology", name)
	}
	if hardened {
		if !actual.Configuration.ReadOnly ||
			!containsString(actual.Configuration.CapDrop, "ALL") ||
			len(actual.Configuration.CapAdd) != 0 ||
			!managedNonRootUser(
				actual.Configuration.InitProcess.User.ID.UID,
				actual.Configuration.InitProcess.User.Raw.UserString,
			) {
			return fmt.Errorf("%s runtime hardening does not match", name)
		}
	}
	return nil
}

func managedNonRootUser(uid int, raw string) bool {
	return uid == 65532 ||
		raw == "agentops" ||
		raw == "65532" ||
		raw == "65532:65532"
}

func imageReferenceMatches(actual, expected string) bool {
	return actual == expected || strings.HasSuffix(actual, "/"+expected)
}

func exactMounts(
	actual *lifecycle.ContainerActual,
	expected map[string]string,
) bool {
	if actual == nil || len(actual.Configuration.Mounts) != len(expected) {
		return false
	}
	for _, mount := range actual.Configuration.Mounts {
		kind, present := expected[mount.Destination]
		if !present {
			return false
		}
		if kind == "tmpfs" {
			if _, present := mount.Type["tmpfs"]; !present {
				return false
			}
			continue
		}
		volume, present := mount.Type["volume"].(map[string]any)
		if !present || volume["name"] != kind {
			return false
		}
	}
	return true
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func exactLoopbackPublication(
	actual *lifecycle.ContainerActual,
	hostPort int,
) bool {
	if actual == nil ||
		len(actual.Configuration.PublishedPorts) != 1 ||
		len(actual.Configuration.PublishedSock) != 0 {
		return false
	}
	publication := actual.Configuration.PublishedPorts[0]
	return publication["hostAddress"] == "127.0.0.1" &&
		numericJSONValue(publication["hostPort"]) == hostPort &&
		numericJSONValue(publication["containerPort"]) == 8080 &&
		numericJSONValue(publication["count"]) == 1 &&
		publication["proto"] == "tcp"
}

func numericJSONValue(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return -1
	}
}

func (manager *manager) offLoopbackReachable() bool {
	interfaces, _ := net.Interfaces()
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := item.Addrs()
		for _, address := range addresses {
			host, _, err := net.ParseCIDR(address.String())
			if err != nil || host.IsLoopback() || host.To4() == nil {
				continue
			}
			if tcpReachable(host.String(), manager.config.ControlHostPort, 300*time.Millisecond) {
				return true
			}
		}
	}
	return false
}

func tcpReachable(host string, port int, timeout time.Duration) bool {
	connection, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(host, strconv.Itoa(port)),
		timeout,
	)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

func redactedError(err error, config config) string {
	message := err.Error()
	for _, secret := range []string{
		config.PostgresPassword,
		config.NextPostgresPassword,
		config.ControlDBPassword,
		config.RunnerDBPassword,
		config.ControlToken,
		config.DashboardToken,
		config.WebhookSecret,
		config.ControlGitHubToken,
		config.RunnerGitHubToken,
		config.ProviderToken,
	} {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "***")
		}
	}
	return message
}

func hasManagedService(
	containers []lifecycle.ContainerActual,
	config config,
) bool {
	names := map[string]bool{
		config.ControlContainer:  true,
		config.RunnerContainer:   true,
		config.PostgresContainer: true,
	}
	for _, container := range containers {
		if names[container.ID] {
			return true
		}
	}
	return false
}
