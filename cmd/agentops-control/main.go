package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/mrbaron3/workflow/internal/control"
	"github.com/mrbaron3/workflow/internal/designgate"
)

func main() {
	if err := run(); err != nil {
		slog.Error("agentops-control failed closed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(log)
	root := environment("AGENTOPS_APP_ROOT", ".")
	bundleRoot := environment(
		"AGENTOPS_DESIGN_BUNDLE_ROOT",
		root+"/contracts/designflow/contract-v1.0.0-rc.1",
	)
	coveragePath := environment(
		"AGENTOPS_DESIGN_COVERAGE_PATH",
		root+"/evidence/ciso-03/design-capability-trace.json",
	)
	gate, err := designgate.Validate(bundleRoot, coveragePath)
	if err != nil {
		return fmt.Errorf("Experience design gate rejected Control API startup: %w", err)
	}
	log.Info(
		"Experience design gate accepted",
		"provider", designgate.ProviderRef,
		"providerCommit", designgate.ProviderCommit,
		"revisionId", gate.RevisionID,
		"bundleDigest", gate.BundleDigest,
		"capabilities", gate.CapabilityIDs,
	)

	databaseURL := strings.TrimSpace(os.Getenv("AGENTOPS_DATABASE_URL"))
	if databaseURL == "" {
		return fmt.Errorf("AGENTOPS_DATABASE_URL is required")
	}
	controlToken := strings.TrimSpace(os.Getenv("AGENTOPS_CONTROL_TOKEN"))
	if controlToken == "" {
		return fmt.Errorf("AGENTOPS_CONTROL_TOKEN is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startupContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	store, err := control.OpenStore(startupContext, databaseURL, root)
	if err != nil {
		return err
	}
	defer store.Close()

	supervisorID := environment("AGENTOPS_SUPERVISOR_ID", hostname())
	reconciliationInterval := durationEnvironment(
		"AGENTOPS_RECONCILIATION_INTERVAL",
		15*time.Second,
	)
	pollInterval := durationEnvironment("AGENTOPS_GITHUB_POLL_INTERVAL", time.Minute)
	httpClient := &http.Client{Timeout: 30 * time.Second}
	runner := &control.ProductionRunner{
		Store: store,
		Source: control.GitHubSource{
			Client:  httpClient,
			BaseURL: environment("AGENTOPS_GITHUB_API_URL", "https://api.github.com"),
			Token:   firstNonEmpty(os.Getenv("GH_TOKEN"), os.Getenv("GITHUB_TOKEN")),
		},
		SupervisorID:   supervisorID,
		PollInterval:   pollInterval,
		ForwarderRetry: 2 * time.Second,
		HealthInterval: reconciliationInterval,
		Log:            log,
	}
	supervisor := control.NewSupervisor(
		store,
		runner,
		supervisorID,
		reconciliationInterval,
		log,
	)
	router := &control.Router{
		Store:    store,
		Interval: reconciliationInterval,
		Lease:    30 * time.Second,
		Wake:     make(chan struct{}, 1),
		Log:      log,
	}
	api := &control.API{
		Store:         store,
		ControlToken:  controlToken,
		WebhookSecret: strings.TrimSpace(os.Getenv("AGENTOPS_GITHUB_WEBHOOK_SECRET")),
		StaleAfter:    max(3*reconciliationInterval, 3*pollInterval, time.Minute),
		RouterWake:    router.Signal,
		Log:           log,
	}
	server := &http.Server{
		Addr:              environment("AGENTOPS_CONTROL_LISTEN", "0.0.0.0:8080"),
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       time.Minute,
	}

	go func() {
		if err := supervisor.Run(ctx); err != nil {
			log.Error("supervisor stopped", "error", err)
			stop()
		}
	}()
	go func() {
		if err := router.Run(ctx); err != nil {
			log.Error("router stopped", "error", err)
			stop()
		}
	}()
	go listenLoop(ctx, store, "agentops_registration_wake", supervisor.Wake, log)
	go listenLoop(ctx, store, "agentops_webhook_wake", router.Signal, log)

	serverError := make(chan error, 1)
	go func() {
		log.Info("agentops-control listening", "address", server.Addr)
		serverError <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	return server.Shutdown(shutdownContext)
}

func listenLoop(
	ctx context.Context,
	store *control.Store,
	channel string,
	wake func(),
	log *slog.Logger,
) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := store.Listen(ctx, channel, wake); err != nil && ctx.Err() == nil {
			log.Error("LISTEN disconnected; periodic reconciliation remains authoritative",
				"channel", channel,
				"error", err,
			)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func environment(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func durationEnvironment(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		panic(fmt.Sprintf("%s must be a positive Go duration", name))
	}
	return duration
}

func hostname() string {
	value, err := os.Hostname()
	if err != nil {
		return "agentops-control"
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
