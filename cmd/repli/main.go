package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"repli/config"
	"repli/internal/job"
	"repli/internal/registry"
	"repli/internal/replicator"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stdout, "Usage: ./program <command> [flag]\n\t<start>: program start\n")
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	switch os.Args[1] {
	case "start":
		fs := flag.NewFlagSet("start", flag.ExitOnError)
		configPath := fs.String("config", "", "ex) ./program start -config=config.yaml")

		_ = fs.Parse(os.Args[2:])

		if *configPath == "" {
			fmt.Fprintln(os.Stderr, "error: -config is required")
			fs.Usage()
			os.Exit(1)
		}

		if err := run(ctx, *configPath); err != nil {
			fmt.Fprintf(os.Stderr, "run error: %v\n", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stdout, "invalid command: %s", os.Args[1])
		os.Exit(1)
	}
}

func run(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	// logging 추가
	// cfg.Logging

	reg, err := registry.New(cfg.Replication.Sources, cfg.Replication.Targets)
	if err != nil {
		return err
	}

	jobs, err := job.Build(cfg.Replication.Jobs, reg)
	if err != nil {
		return err
	}

	repli := replicator.New(jobs)
	if err := repli.StartAll(ctx); err != nil {
		return err
	}

	<-ctx.Done()
	log.Println("recevied shutdown signall")
	if err := repli.StopAll(); err != nil {
		return err
	}

	return nil
}
