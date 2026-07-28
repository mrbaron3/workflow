package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/mrbaron3/workflow/internal/lifecycle"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "agentopsctl: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usageError()
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(
		context.Background(),
		syscall.SIGINT,
		syscall.SIGTERM,
	)
	defer stop()
	manager := newManager(cfg, lifecycle.NewAppleRuntime())
	switch args[0] {
	case "start":
		flags := flag.NewFlagSet("start", flag.ContinueOnError)
		modeRaw := flags.String("mode", "MONITOR_ONLY", "MONITOR_ONLY or ACTIVE")
		build := flags.Bool("build", false, "build the standard OCI images first")
		requestID := flags.String("request-id", "", "durable idempotency identity")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return usageError()
		}
		mode, err := lifecycle.ParseMode(*modeRaw)
		if err != nil {
			return err
		}
		if mode != lifecycle.ModeMonitorOnly && mode != lifecycle.ModeActive {
			return fmt.Errorf("start mode must be MONITOR_ONLY or ACTIVE")
		}
		return manager.Start(ctx, mode, *build, commandID("start", *requestID))
	case "drain":
		flags := flag.NewFlagSet("drain", flag.ContinueOnError)
		timeout := flags.Duration("timeout", 10*time.Minute, "maximum graceful drain wait")
		requestID := flags.String("request-id", "", "durable idempotency identity")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *timeout <= 0 {
			return usageError()
		}
		return manager.Drain(ctx, *timeout, commandID("drain", *requestID))
	case "stop":
		flags := flag.NewFlagSet("stop", flag.ContinueOnError)
		timeout := flags.Duration("timeout", 10*time.Minute, "maximum graceful drain wait")
		requestID := flags.String("request-id", "", "durable idempotency identity")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *timeout <= 0 {
			return usageError()
		}
		return manager.Stop(ctx, *timeout, commandID("stop", *requestID))
	case "rotate-postgres-admin":
		flags := flag.NewFlagSet("rotate-postgres-admin", flag.ContinueOnError)
		requestID := flags.String("request-id", "", "durable rotation identity")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return usageError()
		}
		return manager.RotatePostgresAdmin(
			ctx,
			commandID("rotate-postgres-admin", *requestID),
		)
	case "status":
		flags := flag.NewFlagSet("status", flag.ContinueOnError)
		asJSON := flags.Bool("json", false, "emit machine-readable JSON")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return usageError()
		}
		status, err := manager.Status(ctx)
		if err != nil {
			return err
		}
		if *asJSON {
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(status)
		}
		printStatus(status)
		return nil
	case "logs":
		flags := flag.NewFlagSet("logs", flag.ContinueOnError)
		component := flags.String("component", "control", "control, runner, or postgres")
		follow := flags.Bool("follow", false, "follow log output")
		lines := flags.Int("lines", 200, "tail line count")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *lines < 1 {
			return usageError()
		}
		return manager.Logs(ctx, *component, *lines, *follow)
	case "open":
		flags := flag.NewFlagSet("open", flag.ContinueOnError)
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return usageError()
		}
		return manager.Open(ctx)
	default:
		return usageError()
	}
}

func commandID(operation, provided string) string {
	if value := strings.TrimSpace(provided); value != "" {
		return value
	}
	return fmt.Sprintf(
		"%s-%d-%d",
		operation,
		time.Now().UTC().UnixNano(),
		os.Getpid(),
	)
}

func usageError() error {
	return fmt.Errorf(
		"usage: agentopsctl start|drain|stop|rotate-postgres-admin|status|logs|open (use -h after a command)",
	)
}
