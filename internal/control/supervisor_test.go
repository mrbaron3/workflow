package control

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type fakeSupervisionStore struct {
	mu            sync.Mutex
	registrations []Registration
	listError     error
	states        []string
}

func (store *fakeSupervisionStore) ListRegistrations(context.Context) ([]Registration, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]Registration(nil), store.registrations...), store.listError
}

func (store *fakeSupervisionStore) UpsertActualState(
	_ context.Context,
	registration Registration,
	component, state, _ string,
	_ error,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.states = append(store.states, componentKey(registration.ID, component)+":"+state)
	return nil
}

func (store *fakeSupervisionStore) set(registrations []Registration, err error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.registrations = registrations
	store.listError = err
}

type fakeComponentRunner struct {
	started chan string
	stopped chan string
}

func (runner *fakeComponentRunner) Run(
	ctx context.Context,
	registration Registration,
	component string,
) error {
	key := componentKey(registration.ID, component) + ":" + string(rune(registration.Version))
	runner.started <- key
	<-ctx.Done()
	runner.stopped <- key
	return nil
}

func TestSupervisorDynamicallyReconfiguresAndFailsClosed(t *testing.T) {
	store := &fakeSupervisionStore{}
	runner := &fakeComponentRunner{
		started: make(chan string, 20),
		stopped: make(chan string, 20),
	}
	supervisor := NewSupervisor(
		store,
		runner,
		"test",
		time.Hour,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	registration := Registration{
		ID: "registration-1", Repository: "owner/repo", Enabled: true,
		IssueMonitorEnabled: true, Version: 1,
	}
	store.set([]Registration{registration}, nil)
	if err := supervisor.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	assertStarts(t, runner.started, 2)

	registration.Version = 2
	registration.IssueMonitorEnabled = false
	registration.PRMonitorEnabled = true
	store.set([]Registration{registration}, nil)
	if err := supervisor.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	assertStops(t, runner.stopped, 2)
	assertStarts(t, runner.started, 2)

	store.set(nil, errors.New("database disconnected"))
	if err := supervisor.Reconcile(ctx); err == nil {
		t.Fatal("Reconcile() accepted disconnected database")
	}
	assertStops(t, runner.stopped, 2)

	store.set([]Registration{registration}, nil)
	if err := supervisor.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	assertStarts(t, runner.started, 2)
	if err := supervisor.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	assertNoStart(t, runner.started)

	registration.Version = 3
	registration.Enabled = false
	store.set([]Registration{registration}, nil)
	if err := supervisor.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	assertStops(t, runner.stopped, 2)
}

func assertNoStart(t *testing.T, channel <-chan string) {
	t.Helper()
	select {
	case started := <-channel:
		t.Fatalf("stale component owner removed a reconstructed component: %s", started)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPeriodicReconciliationRecoversMissedNotification(t *testing.T) {
	store := &fakeSupervisionStore{}
	runner := &fakeComponentRunner{
		started: make(chan string, 20),
		stopped: make(chan string, 20),
	}
	supervisor := NewSupervisor(
		store,
		runner,
		"test",
		10*time.Millisecond,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- supervisor.Run(ctx) }()
	store.set([]Registration{{
		ID: "registration-1", Repository: "owner/repo", Enabled: true,
		IssueMonitorEnabled: true, Version: 1,
	}}, nil)
	assertStarts(t, runner.started, 2)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Supervisor.Run did not stop")
	}
}

func assertStarts(t *testing.T, channel <-chan string, count int) {
	t.Helper()
	for range count {
		select {
		case <-channel:
		case <-time.After(time.Second):
			t.Fatalf("wanted %d component starts", count)
		}
	}
}

func assertStops(t *testing.T, channel <-chan string, count int) {
	t.Helper()
	for range count {
		select {
		case <-channel:
		case <-time.After(time.Second):
			t.Fatalf("wanted %d component stops", count)
		}
	}
}
