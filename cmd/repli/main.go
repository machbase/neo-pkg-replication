package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"repli/config"
	"repli/internal/replicator"
	"repli/internal/source"
	"repli/internal/target"
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
			os.Exit(2)
		}

		if err := run(ctx, *configPath); err != nil {
			fmt.Fprintf(os.Stderr, "run error: %v\n", err)
			os.Exit(2)
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

	fmt.Printf("config: %v\n", cfg)

	sources, err := source.New(cfg.Replication.Sources...)
	if err != nil {
		return err
	}
	targets, err := target.New(cfg.Replication.Targets...)
	if err != nil {
		return err
	}

	// src.List()
	// tar.List()

	replicator := replicator.New(cfg.Replication.Jobs...)
	replicator.Run(ctx, sources, targets)

	return nil
}
